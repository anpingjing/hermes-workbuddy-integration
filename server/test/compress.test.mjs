// 上下文压缩测试。
//
// 背景：上游对输入长度有硬限制，超了回 400 "prompt is too long: N > M maximum"。
// 原实现原样转发，长会话必然撞墙。这里覆盖裁剪逻辑的边界：
//   - tool_calls 与其 tool 结果必须同生共死（拆开会被上游拒）
//   - system 提示永不丢弃
//   - 最近的消息优先保留
//   - 单条超长时截断自身内容
//   - 从上游报错里学到真实上限
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  fitMessages,
  splitBlocks,
  truncateMessage,
  parseLimitFromError,
  isTooLongError,
  learnLimit,
  learnedLimit,
  resetLearnedLimits,
  estimateMessages,
  estimateTokensAccurate,
  parseActualTokens,
  calibrateEstimate,
  calibrationFactor,
  isProviderParamRejection,
} = await import('../src/compress.mjs');

const 填充 = (n) => '啊'.repeat(n);
const user = (n = 100) => ({ role: 'user', content: 填充(n) });
const assistant = (n = 100) => ({ role: 'assistant', content: 填充(n) });

beforeEach(() => resetLearnedLimits());

describe('从上游报错里解析真实上限', () => {
  test('标准格式 prompt is too long: N > M maximum', () => {
    assert.equal(
      parseLimitFromError('prompt is too long: 100001 tokens > 100000 maximum'),
      100000,
    );
  });

  test('上游把 > 转义成 \\u003e 时也要能解析（回归）', () => {
    // 真实响应就是这样：正文里是 6 个字符 `\u003e` 而不是 `>`。
    // 曾经的 bug：正则只认字面 `>`，于是静默返回 null，
    // 压缩逻辑写了却完全不触发，用户继续看到裸 400。
    const escaped = '{"code":11115,"msg":"prompt is too long: 100001 tokens \\u003e 100000 maximum",'
      + '"requestId":"x","extError":{"code":"context_length_exceeded"}}';
    assert.equal(parseLimitFromError(escaped), 100000);
  });

  test('完整的 cn-cli 真实错误体能解析', () => {
    const real = JSON.stringify({
      code: 11115,
      msg: 'prompt is too long: 100001 tokens > 100000 maximum',
      requestId: '1fac235f78df69a50ac97664bf8c1d65',
      extError: { code: 'context_length_exceeded', message: 'prompt is too long: 100001 tokens > 100000 maximum' },
    });
    assert.equal(parseLimitFromError(real), 100000);
    assert.equal(isTooLongError(400, real), true);
  });

  test('maximum context length is N tokens', () => {
    assert.equal(parseLimitFromError('This model\'s maximum context length is 128000 tokens'), 128000);
  });

  test('解析不出来返回 null（不瞎猜）', () => {
    assert.equal(parseLimitFromError('some other error'), null);
    assert.equal(parseLimitFromError(''), null);
    assert.equal(parseLimitFromError(null), null);
  });

  test('isTooLongError 认得各种说法', () => {
    assert.equal(isTooLongError(400, 'prompt is too long: 1 tokens > 0 maximum'), true);
    assert.equal(isTooLongError(400, 'context_length_exceeded'), true);
    assert.equal(isTooLongError(413, 'input too large'), true);
    assert.equal(isTooLongError(422, 'exceed max token'), true);
  });

  test('普通业务错误不会被误判为太长', () => {
    assert.equal(isTooLongError(400, 'invalid model'), false);
    assert.equal(isTooLongError(401, 'unauthorized'), false);
    assert.equal(isTooLongError(429, 'rate limit'), false);
    assert.equal(isTooLongError(500, 'internal error'), false);
  });

  test('学到的上限按「站点/模型」分别记', () => {
    learnLimit('cn-cli', 'glm-5.1', 100000);
    assert.equal(learnedLimit('cn-cli', 'glm-5.1'), 100000);
    assert.equal(learnedLimit('intl-cli', 'glm-5.1'), null, '别的站点不该共用');
    assert.equal(learnedLimit('cn-cli', 'other'), null);
  });

  test('上游亲口报的值优先于目录值（回归）', () => {
    // 目录值（弱证据）不该覆盖上游报的值（强证据），否则会反复按错的上限压缩
    learnLimit('cn-cli', 'glm-5.1', 200000);
    assert.equal(learnedLimit('cn-cli', 'glm-5.1'), 200000);
    learnLimit('cn-cli', 'glm-5.1', 100000, { authoritative: true });
    assert.equal(learnedLimit('cn-cli', 'glm-5.1'), 100000);
    learnLimit('cn-cli', 'glm-5.1', 200000);
    assert.equal(learnedLimit('cn-cli', 'glm-5.1'), 100000, '强证据不该被弱证据覆盖');
  });

  test('目录值本身照常记录（没有更强证据时用它）', () => {
    learnLimit('cn-cli', 'some-model', 128000);
    assert.equal(learnedLimit('cn-cli', 'some-model'), 128000);
  });
});

describe('分块：tool_calls 与 tool 结果不可拆', () => {
  test('assistant(tool_calls) 连带其后的 tool 消息算一块', () => {
    const msgs = [
      user(),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' }] },
      { role: 'tool', tool_call_id: 'c1', content: '结果1' },
      { role: 'tool', tool_call_id: 'c2', content: '结果2' },
      assistant(),
    ];
    const blocks = splitBlocks(msgs);
    assert.equal(blocks.length, 3, '应为 [user] [assistant+2个tool] [assistant]');
    assert.equal(blocks[1].length, 3);
  });

  test('没有 tool_calls 时一条一块', () => {
    const blocks = splitBlocks([user(), assistant(), user()]);
    assert.equal(blocks.length, 3);
    assert.ok(blocks.every((b) => b.length === 1));
  });

  test('裁剪后不会留下「孤儿」tool 消息', () => {
    const msgs = [user()];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function' }] });
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 填充(2000) });
    }
    msgs.push(user(50));
    const { messages } = fitMessages(msgs, { maxInputTokens: 20000, reserveForOutput: 1000 });
    // 每个 tool 消息都必须能找到它对应的 tool_calls
    const callIds = new Set();
    for (const m of messages) {
      if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callIds.add(c.id);
    }
    for (const m of messages) {
      if (m.role === 'tool') {
        assert.ok(callIds.has(m.tool_call_id), `孤儿 tool 消息：${m.tool_call_id}`);
      }
    }
  });
});

describe('fitMessages：裁剪策略', () => {
  test('没超限时原样返回，不动任何东西', () => {
    const msgs = [{ role: 'system', content: 'sys' }, user(50), assistant(50)];
    const { messages, stats } = fitMessages(msgs, { maxInputTokens: 1_000_000 });
    assert.equal(stats.applied, false);
    assert.equal(stats.dropped, 0);
    assert.deepEqual(messages, msgs);
  });

  test('system 提示永远保留', () => {
    const msgs = [{ role: 'system', content: '你很特别' }];
    for (let i = 0; i < 50; i++) msgs.push(i % 2 ? assistant(3000) : user(3000));
    const { messages } = fitMessages(msgs, { maxInputTokens: 8000, reserveForOutput: 500, minKeepMessages: 2 });
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, '你很特别');
  });

  test('从最老的开始丢，最新的保住', () => {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: `第${i}条 ${填充(2000)}` });
    msgs.push({ role: 'user', content: '最后一条' });
    const { messages, stats } = fitMessages(msgs, { maxInputTokens: 12000, reserveForOutput: 500, minKeepMessages: 2 });
    assert.ok(stats.dropped > 0, '应该有丢弃');
    assert.equal(messages[messages.length - 1].content, '最后一条', '最后一条必须留下');
    // 最早的那条应该被丢掉了
    assert.ok(!messages.some((m) => String(m.content).startsWith('第0条')), '第0条应被丢弃');
  });

  test('至少保留 minKeepMessages 条最近消息', () => {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: `第${i}条 ${填充(3000)}` });
    const { messages } = fitMessages(msgs, { maxInputTokens: 3000, reserveForOutput: 100, minKeepMessages: 4 });
    const 非系统 = messages.filter((m) => m.role !== 'system');
    assert.ok(非系统.length >= 4, `非系统消息应至少 4 条，实际 ${非系统.length}`);
  });

  test('单条自己就超限时截断内容', () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 填充(500_000) }];
    const { messages, stats } = fitMessages(msgs, { maxInputTokens: 10000, reserveForOutput: 500, minKeepMessages: 1 });
    assert.ok(stats.truncated >= 1, '应发生截断');
    const 最后 = messages[messages.length - 1];
    assert.ok(最后.content.length < 500_000, '内容应被截短');
    assert.ok(最后.content.includes('被代理截断'), '应留下截断标记');
    assert.ok(最后._proxy_truncated, '应打上标记便于排查');
  });

  test('裁剪后确实落到预算内', () => {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 60; i++) msgs.push(i % 2 ? assistant(4000) : user(4000));
    const limit = 20000;
    const { messages, stats } = fitMessages(msgs, { maxInputTokens: limit, reserveForOutput: 1000, minKeepMessages: 2 });
    assert.ok(stats.after <= limit, `裁剪后 ${stats.after} 应 <= ${limit}`);
    assert.equal(estimateMessages(messages), stats.after);
  });

  test('空数组与非法输入不崩', () => {
    assert.deepEqual(fitMessages([], { maxInputTokens: 100 }).messages, []);
    assert.deepEqual(fitMessages(null, { maxInputTokens: 100 }).messages, []);
    assert.deepEqual(fitMessages(undefined, { maxInputTokens: 100 }).messages, []);
  });

  test('没有上限时不裁（交给上游报错后再学）', () => {
    const msgs = [user(100000)];
    const { messages, stats } = fitMessages(msgs, { maxInputTokens: 0 });
    assert.equal(stats.applied, false);
    assert.equal(messages.length, 1);
  });

  test('nil/undefined 消息混在数组里也不崩', () => {
    const msgs = [user(100), null, undefined, assistant(100)];
    assert.doesNotThrow(() => fitMessages(msgs, { maxInputTokens: 100 }));
  });
});

describe('中文感知的 token 估算（回归）', () => {
  // 曾经的 bug：沿用 util.estimateTokens 的「3 字符 ≈ 1 token」（英文口径），
  // 中文被低估约 1.6 倍 → 以为装得下、其实装不下 → 压缩不触发。
  // 实测值（deepseek-v4.1-flash）：中文 0.528、英文 0.222、数字 0.332、代码 0.352 tokens/字符。
  test('中文比英文「更贵」：同样字符数，中文估得更多', () => {
    const 中文 = estimateTokensAccurate('这是一段测试文本'.repeat(100));
    const 英文 = estimateTokensAccurate('abcdefghijklmnop'.repeat(100));
    assert.ok(中文 > 英文, `中文 ${中文} 应大于英文 ${英文}`);
  });

  test('中文估算贴近实测（误差 < 15%）', () => {
    const text = '这是一段用于填充上下文的测试文本。'.repeat(3000);
    const 实测 = 26906; // 实测 prompt_tokens
    const 估算 = estimateTokensAccurate(text);
    const 偏差 = Math.abs(估算 / 实测 - 1);
    assert.ok(偏差 < 0.15, `偏差 ${(偏差 * 100).toFixed(1)}% 过大（估算 ${估算} / 实测 ${实测}）`);
  });

  test('数字估算贴近实测（误差 < 20%）', () => {
    const text = '1234567890'.repeat(10000);
    const 实测 = 33240;
    const 估算 = estimateTokensAccurate(text);
    assert.ok(Math.abs(估算 / 实测 - 1) < 0.2, `估算 ${估算} / 实测 ${实测}`);
  });

  test('空输入为 0，非空至少 1', () => {
    assert.equal(estimateTokensAccurate(''), 0);
    assert.equal(estimateTokensAccurate(null), 0);
    assert.ok(estimateTokensAccurate('a') >= 1);
  });

  test('对象输入按 JSON 估算', () => {
    assert.ok(estimateTokensAccurate({ messages: [{ role: 'user', content: '你好' }] }) > 0);
  });
});

describe('truncateMessage', () => {
  test('短内容不动', () => {
    const m = { role: 'user', content: '短' };
    assert.equal(truncateMessage(m, 1000).content, '短');
  });

  test('非字符串内容（多模态数组）原样返回', () => {
    const m = { role: 'user', content: [{ type: 'text', text: 'x' }] };
    assert.deepEqual(truncateMessage(m, 10).content, [{ type: 'text', text: 'x' }]);
  });

  test('保留头尾，中间打标记', () => {
    const m = { role: 'user', content: 'A'.repeat(5000) + 'TAIL' };
    const out = truncateMessage(m, 100);
    assert.ok(out.content.startsWith('A'));
    assert.ok(out.content.endsWith('TAIL'), '尾部应保留');
    assert.ok(out.content.includes('被代理截断'));
  });

  test('不改原对象', () => {
    const m = { role: 'user', content: 填充(5000) };
    const 原 = m.content;
    truncateMessage(m, 50);
    assert.equal(m.content, 原, '应返回副本，不能就地改');
  });
});

// 上游对「输入远超上限」有两种报法：
//   11115 → "prompt is too long: N tokens > M maximum"（带数字，能解析）
//   11133 → "Invalid request parameters" + extError model_param_invalid（一句通用文案）
// 只认前者会让后者完全不触发压缩，请求硬失败（实测 250 万字符触发，100 万字符仍是 200）。
describe('上游报错解析：真实 token 数与「参数被供应商拒」', () => {
  test('parseActualTokens 能解析被转义的 >', () => {
    // 上游 JSON 里 > 是 \u003e，不还原就匹配不到（parseLimitFromError 踩过同一个坑）
    const text = '{"code":11115,"msg":"prompt is too long: 1193121 tokens \\u003e 1048576 maximum"}';
    assert.equal(parseActualTokens(text), 1193121);
  });

  test('parseActualTokens 对不带数字的报错返回 null', () => {
    assert.equal(parseActualTokens('{"code":11133,"msg":"Invalid request parameters"}'), null);
    assert.equal(parseActualTokens(''), null);
  });

  test('isProviderParamRejection 认出 11133 + model_param_invalid', () => {
    const text = '{"code":11133,"msg":"Invalid request parameters","extError":{"code":"model_param_invalid"}}';
    assert.equal(isProviderParamRejection(text), true);
  });

  test('isProviderParamRejection 不误伤其它 400', () => {
    assert.equal(
      isProviderParamRejection('{"code":11101,"msg":"Non-stream chat request is currently not supported"}'),
      false,
    );
    assert.equal(isProviderParamRejection('{"code":11128,"msg":"first message is not system prompt"}'), false);
    // 只有 11133、但 extError 不是 model_param_invalid 时也不算
    assert.equal(isProviderParamRejection('{"code":11133,"msg":"something else"}'), false);
  });

  test('isTooLongError 对 11133 仍返回 false（算不算超限由上游层带守卫判断）', () => {
    const text = '{"code":11133,"msg":"Invalid request parameters","extError":{"code":"model_param_invalid"}}';
    assert.equal(isTooLongError(400, text), false);
  });
});

describe('估算校准：用上游报的真实 token 数修正本地低估', () => {
  test('没校准过的模型倍率为 1（不改动原有行为）', () => {
    assert.equal(calibrationFactor('intl-work', 'deepseek-v4.1-flash'), 1);
  });

  test('按「真实 ÷ 本地估算」的比值校准', () => {
    // 实测样本：上游报 1,193,121，本地只估到 620,249
    const f = calibrateEstimate('intl-work', 'deepseek-v4.1-flash', 1193121, 620249);
    assert.ok(f > 1.9 && f < 1.95, `倍率应约 1.92，实际 ${f}`);
    assert.equal(calibrationFactor('intl-work', 'deepseek-v4.1-flash'), f);
  });

  test('倍率夹在 [1,4]：只修低估，也不被单次异常样本带飞', () => {
    assert.equal(calibrateEstimate('s', 'm1', 500, 1000), 1, '估高了的样本夹到 1');
    assert.equal(calibrateEstimate('s', 'm2', 1000000, 1000), 4, '极端样本夹到 4');
  });

  test('多次样本按指数滑动平均收敛', () => {
    assert.equal(calibrateEstimate('s', 'm3', 200, 100), 2);
    assert.equal(calibrateEstimate('s', 'm3', 200, 100), 2, '同样本不应漂移');
    assert.equal(calibrateEstimate('s', 'm3', 400, 100), 3, '0.5×2.0 + 0.5×4.0');
  });

  test('无效样本返回 null 且不写入', () => {
    assert.equal(calibrateEstimate('s', 'm4', 0, 100), null);
    assert.equal(calibrateEstimate('s', 'm4', 100, 0), null);
    assert.equal(calibrateEstimate('s', 'm4', NaN, 100), null);
    assert.equal(calibrationFactor('s', 'm4'), 1);
  });

  test('resetLearnedLimits 同时清空校准', () => {
    calibrateEstimate('s', 'm5', 200, 100);
    assert.equal(calibrationFactor('s', 'm5'), 2);
    resetLearnedLimits();
    assert.equal(calibrationFactor('s', 'm5'), 1);
  });

  test('校准按 站点/模型 隔离', () => {
    calibrateEstimate('a', 'm', 200, 100);
    assert.equal(calibrationFactor('a', 'm'), 2);
    assert.equal(calibrationFactor('b', 'm'), 1);
    assert.equal(calibrationFactor('a', 'other'), 1);
  });
});

describe('fitMessages：截断量纲与 applied 语义（回归）', () => {
  test('单条消息自身超限时会被真的截断', () => {
    // 回归：这一步曾用粗略的 estimateTokens（约 0.333 token/字符）去和按
    // tokenWeight（中文约 0.55 token/字符）算出的「每条预算」比较 —— 两者量纲不同，
    // 于是该截断时不截断。日志表现是「已自动压缩：丢弃 0 条、截断 0 条，A → A」，
    // 请求照样超限发出，白撞一次上游 400。
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 填充(1_000_000) }];
    const { messages, stats } = fitMessages(msgs, {
      maxInputTokens: 500_000,
      reserveForOutput: 0,
      safetyRatio: 1,
    });
    assert.equal(stats.truncated, 1, '应截断那条超大消息');
    assert.ok(stats.after < stats.before, `应真的变小：${stats.before} → ${stats.after}`);
    assert.equal(stats.applied, true);
    assert.ok(messages[1].content.includes('被代理截断'));
  });

  test('压不动时 applied 为 false（不能报「已压缩」却没变）', () => {
    // 语义是「确实压小了」，不是「超了预算」：
    // 上游重试靠它判断「还压得动吗」，applyContextFit 靠它决定要不要打日志。
    // 多模态数组的内容不是字符串，截断不动 —— 此时必须如实返回 applied=false。
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 填充(1_000_000) }] },
    ];
    const { stats } = fitMessages(msgs, { maxInputTokens: 500_000, reserveForOutput: 0, safetyRatio: 1 });
    assert.equal(stats.applied, false);
    assert.equal(stats.truncated, 0, '压不动就不该计入 truncated');
    assert.equal(stats.after, stats.before);
  });
});

describe('token 估算：标点/符号的权重（回归）', () => {
  test('标点比字母更贵', () => {
    // 回归：标点原先和字母一样按 0.25 算，而分词器基本一个标点一个 token。
    // 后果是 JSON / 代码密集的内容被系统性低估 —— 实测一个 tools JSON
    // 本地估 928,990、上游真实约 998,920，低估 7.5%，直接导致长请求被判「装得下」
    // 却在上游吃 400。按实测反推，标点权重应约 0.349，这里取 0.35。
    const 字母 = estimateTokensAccurate('a'.repeat(1000));
    const 标点 = estimateTokensAccurate('{'.repeat(1000));
    assert.ok(标点 > 字母 * 1.3, `标点 ${标点} 应显著高于字母 ${字母}`);
  });

  test('数字比字母贵、比标点便宜', () => {
    const 字母 = estimateTokensAccurate('a'.repeat(1000));
    const 数字 = estimateTokensAccurate('7'.repeat(1000));
    const 标点 = estimateTokensAccurate('{'.repeat(1000));
    assert.ok(数字 > 字母 && 数字 < 标点);
  });

  test('空白与换行仍按字母档（不把缩进算贵）', () => {
    assert.equal(estimateTokensAccurate(' '.repeat(1000)), estimateTokensAccurate('a'.repeat(1000)));
  });
});

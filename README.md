# hermes-workbuddy-integration

把 **腾讯 WorkBuddy / CodeBuddy 桌面 App 的登录态与模型额度**，接到 **Hermes Agent** 上使用。

仓库里有两个层次，用途不同，分开看：

```
┌─ 本仓库新增（桥接层）────────────────────────────┐
│  sync-desktop-credential.mjs                     │
│    解密桌面 App 的加密登录态，转成网关能用的凭据   │
├─ vendored 上游项目（MIT）───────────────────────┤
│  server/  = yuan240324/workbuddy-openai-proxy    │
│    本机 OpenAI + Anthropic 兼容网关（零依赖）     │
└──────────────────────────────────────────────────┘
        │
        ▼
  Hermes：model.aliases.wb* → 本地网关 8788 → 上游
```

**只监听 127.0.0.1**，复用桌面 App 已有账号与额度，不对外暴露任何端口。

> 上游为非官方接口，本项目与腾讯无任何关联，未获官方授权或认可。
> 仅供个人学习研究，请自行评估使用风险（限速 / 封号 / 清额风险自担），并遵守 WorkBuddy 服务条款。

## 目录结构

| 路径 | 说明 |
|---|---|
| `sync-desktop-credential.mjs` | **桥接层**：解密桌面登录态并同步为网关凭据 |
| `server/` | 上游网关本体（MIT，yuan240324/workbuddy-openai-proxy v1.4.0 + 本机修复） |
| `.github/workflows/ci.yml` | CI：Node 18/20/22/24 × 449 项测试（零依赖，无需 npm install） |
| `server/修复记录.md` | 上游网关的一轮代码审查与修复记录（安全 / 健壮性 / 配置校验 / 控制台） |

不会被提交的文件（见 `.gitignore`）：`server/auth.cn-cli.json`（含 token 明文）、
`server/config.json`（含 apiKey）、`server/usage.json`、`*.log`、本机的 start/stop 脚本。

## 快速开始

前置：已安装 WorkBuddy 桌面 App 并登录（国内版），Node ≥ 18。

```bash
# 1. 同步桌面凭据（解密 → 择优 → 写入 server/auth.cn-cli.json，0600）
node sync-desktop-credential.mjs

# 2. 准备配置（首次）
cp server/config.example.json server/config.json   # 按需改 port / apiKey

# 3. 起网关
cd server && node server.mjs

# 4. 自检
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models -H "Authorization: Bearer <config.json 里的 apiKey>"
```

`config.json` 缺失时网关用内置默认值启动，但**没有任何凭据**，
`/health` 会显示 `logged_in: false` —— 这是预期状态，不是故障。

## 接到 Hermes

Hermes 侧配一个自定义 provider（`~/.hermes/config.yaml`），指向本机网关：

```yaml
model:
  aliases:
    wb:        workbuddy/glm-5.3          # 主力，1M 上下文
    wb-flash:  workbuddy/glm-5.3-flash    # 便宜快速，支持工具/图片
    wb-step:   workbuddy/step-5-preview   # 免费
    wb-hy3:    workbuddy/hy3              # 免费，混元
```

用法：对话里 `/model wb-flash` 切换；CLI 用 `hermes chat -m wb-flash -q "..."`。

完整别名与积分倍率见下表（上游实时清单共 17 个模型）：

| 别名 | 上游模型 | 积分倍率 | 说明 |
|---|---|---|---|
| `wb-hy3` | hy3 | x0.00 | 免费，混元 |
| `wb-step` | step-5-preview | x0.00 | 免费 |
| `wb-flash` | glm-5.3-flash | x0.06 | 便宜快速，支持工具/图片 |
| `wb-minimax` | minimax-m3 | x0.25 | |
| `wb-ds-flash` | deepseek-v4.1-flash | — | DeepSeek V4 Flash |
| `wb-deepseek` | deepseek-v4-pro | — | DeepSeek V4 Pro |
| `wb-kimi` | kimi-k3-1 | x1.62 | Kimi K3 |
| `wb` | glm-5.3 | x0.79 | 主力，1M 上下文 |
| `wb-auto` | auto | 随路由 | 上游自动选模型 |

## 凭据与刷新机制

- access token 有效期 28 天、refresh 30 天；网关在临期 5 分钟内自动用 refresh token 续期并回写自己的副本。
- 桌面 App 端重新登录 / 切号后，重跑 `node sync-desktop-credential.mjs` 即可：
  同 uid 取到期更晚的一份；uid 变化（切号）以桌面文件为准。
- 覆盖路径（一般不用）：环境变量 `WORKBUDDY_AUTH_FILE`、`WORKBUDDY_ELECTRON_BIN`。
- token 只落盘到 `server/auth.cn-cli.json`（0600），不打印、不出本机。

## 故障排查

| 现象 | 处理 |
|---|---|
| Hermes 报连接失败 | 看 `/health`；确认网关在跑（`node status.mjs` / `stop.mjs` / 重启） |
| 401 / 登录态失效 | 打开 WorkBuddy App 重新登录，再跑 `node sync-desktop-credential.mjs` |
| 解密报错（keyId 不匹配 / 格式不识别） | WorkBuddy 升级改了加密方案，需更新 `sync-desktop-credential.mjs`（参照 dsh-workbuddy-connect 最新版） |
| 端口 8788 占用 | 改 `server/config.json` 的 port，同步改 Hermes 别名 base_url |
| git-bash 里 curl 发中文乱码 | 用 `--data-binary @file.json`（UTF-8 文件），不要内联中文 |

## 本机实测结论（2026-10-13，Windows 11 + Node 26 + Hermes 0.21.6）

- 桌面端模型切换可用：Hermes 桌面端内切换模型后，CLI 侧 `hermes chat -m wb-*` 全链路通过。
- 网关 `/health` `logged_in: true`；`/v1/models` 返回 17 个模型。
- 基础对话 1.4s 返回；流式 SSE 10 chunks 正常聚合；工具调用 `tool_calls` 正确返回。
- 449 项测试全绿（`node --test server/test/*.test.mjs`）。
- 安全面复核：控制台拒绝非本机 Origin（403）、错误 API Key 401、仅绑 127.0.0.1（局域网 IP 不可达）。

## 参考来源（均 MIT）

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) — 凭据解密与上游协议权威参照（DSH 插件，不能直接用于 Hermes）
- [yuan240324/workbuddy-openai-proxy](https://github.com/yuan240324/workbuddy-openai-proxy) — 网关本体


#!/usr/bin/env node
/**
 * 桌面凭据桥接：解密 WorkBuddy 桌面 App (5.6+) 的静态加密登录态，
 * 同步为 workbuddy-openai-proxy 的单站点凭据 server/auth.cn-cli.json。
 *
 * 策略（与 corrinehu/dsh-workbuddy-connect 的凭据择优一致）：
 *   - 桌面 .info 是「当前登录身份」的权威来源（只读，绝不回写）
 *   - 适配器自己刷新得到的副本若属于同一 uid 且更新，则保留副本
 *   - uid 变化（桌面端切号）→ 以桌面为准
 *
 * 解密协议（MIT 参照实现转录）：WorkBuddy 魔改 Electron 的私有 binding
 * process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()
 * 取 {version:1, atRestSecretKey(base64,32B)}，protectorKey=sha256(secret)，
 * 信封 AES-256-GCM，AAD 见 buildAuthenticatedContextAad。
 *
 * 纯本地运行：不发任何网络请求；token 内容只落盘到 server/ 目录(0600)，不打印。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server');

const EXE = process.env.WORKBUDDY_ELECTRON_BIN
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs', 'WorkBuddy', 'WorkBuddy.exe');
const LOCAL_INFO = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const ROAMING_INFO = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const INFO = process.env.WORKBUDDY_AUTH_FILE || (fs.existsSync(LOCAL_INFO) ? LOCAL_INFO : ROAMING_INFO);
const OUT = path.join(ROOT, 'auth.cn-cli.json');

function fail(msg) { console.error('[sync] FAIL: ' + msg); process.exit(1); }

// ---- 1. 取 at-rest 保护密钥（跑 WorkBuddy 自己的 Electron，ELECTRON_RUN_AS_NODE） ----
const HELPER = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
let payloadRaw;
try {
  payloadRaw = execFileSync(EXE, ['-e', HELPER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15000, windowsHide: true, encoding: 'utf8',
  }).trim();
} catch (e) { fail(`无法从 WorkBuddy.exe 取密钥：${e.message.split('\n')[0]}`); }

let payload;
try { payload = JSON.parse(payloadRaw); } catch { fail('密钥助手返回了非预期内容'); }
if (payload.version !== 1 || typeof payload.atRestSecretKey !== 'string') fail('密钥载荷格式不识别（App 版本可能已变更）');
const protectorKey = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
const helperKeyId = crypto.createHash('sha256').update(protectorKey).digest('hex').slice(0, 16);

// ---- 2. 解密信封 ----
function aad(keyId, suite) {
  const len = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.allocUnsafe(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  const sb = Buffer.allocUnsafe(4); sb.writeUInt32BE(suite);
  return Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), len('WBEV1'), len('sym-v1'), sb, len(keyId), Buffer.from([2, 0, 0])]);
}
function openField(wrapped) {
  const env = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'));
  if (env.suite !== 1) fail(`未知加密套件 ${env.suite}`);
  const d = crypto.createDecipheriv('aes-256-gcm', protectorKey, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(aad(env.keyId, env.suite));
  d.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
}

const doc = JSON.parse(fs.readFileSync(INFO, 'utf8'));
const auth0 = doc.auth || fail('桌面凭据缺少 auth 段');
const account = doc.account || {};
if (auth0.accessToken?.$wbEncrypted !== 1) fail('accessToken 不是 5.6+ 加密信封格式（请更新本桥接或反馈）');
const accessToken = openField(auth0.accessToken);
const refreshToken = auth0.refreshToken?.$wbEncrypted === 1 ? openField(auth0.refreshToken) : (auth0.refreshToken || '');
if (!accessToken.startsWith('eyJ')) fail('解密结果不像 JWT');

const desktop = {
  accessToken,
  refreshToken,
  expiresAt: (auth0.expiresAt > 1e12 ? auth0.expiresAt : auth0.expiresAt * 1000) || 0,
  uid: account.uid || '',
  domain: auth0.domain || '',
};

// ---- 3. 与适配器自留副本择优（同 uid 取到期更晚；uid 不同以桌面为准） ----
function jwtExp(t) { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).exp * 1000; } catch { return 0; } }
let chosen = desktop, source = 'desktop';
if (fs.existsSync(OUT)) {
  try {
    const own = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (own.accessToken && own.uid === desktop.uid && jwtExp(own.accessToken) > jwtExp(desktop.accessToken)) {
      chosen = own; source = 'adapter-copy';
    } else if (own.accessToken && own.uid !== desktop.uid) {
      source = 'desktop(account-switched)';
    }
  } catch { /* 副本损坏则以桌面为准 */ }
}

fs.writeFileSync(OUT, JSON.stringify({
  accessToken: chosen.accessToken,
  refreshToken: chosen.refreshToken,
  expiresAt: chosen.expiresAt || jwtExp(chosen.accessToken),
  uid: chosen.uid,
  domain: chosen.domain,
}, null, 2) + '\n', { mode: 0o600 });

const exp = new Date(chosen.expiresAt || jwtExp(chosen.accessToken));
console.log(`[sync] OK  source=${source}  keyId=${helperKeyId}  uid=${chosen.uid.slice(0, 8)}…  domain=${chosen.domain || '(none)'}  token有效至=${exp.toLocaleString('zh-CN', { hour12: false })}`);

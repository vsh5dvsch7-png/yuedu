/**
 * 授权：离线激活码校验（Ed25519 签名）
 * 激活码格式：YD-<base64url(payload json)>.<base64url(signature)>
 * payload: { n: 用户名/邮箱, t: 签发时间(秒), e: 到期时间(秒, 0=永久) }
 * 用 tools/keygen.js 生成密钥对和激活码，私钥绝不要放进源码或仓库。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TRIAL_DAYS = 7;
// 公钥（PEM）。运行 node tools/keygen.js init 后会自动替换这里。
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYRo7PNwKtQ6G0ovanHX42DEMhOUotfUBl8I5UcHH2j4=
-----END PUBLIC KEY-----`;

let file = null, state = { firstRun: 0, code: null };
function init(userData) {
  file = path.join(userData, 'license.json');
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  if (!state.firstRun) { state.firstRun = Date.now(); save(); }
}
function save() { try { fs.writeFileSync(file, JSON.stringify(state)); } catch {} }

function b64uDecode(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function verify(code) {
  try {
    if (!code || !code.startsWith('YD-') || PUBLIC_KEY_PEM.includes('__PUBLIC')) return null;
    const [p, sig] = code.slice(3).trim().split('.');
    const payload = b64uDecode(p);
    const ok = crypto.verify(null, payload, crypto.createPublicKey(PUBLIC_KEY_PEM), b64uDecode(sig));
    if (!ok) return null;
    const info = JSON.parse(payload.toString('utf8'));
    if (info.e && info.e * 1000 < Date.now()) return null;   // 已过期
    return info;
  } catch { return null; }
}
function status() {
  const info = state.code ? verify(state.code) : null;
  if (info) return { pro: true, kind: 'licensed', name: info.n, expire: info.e || 0 };
  const left = TRIAL_DAYS - Math.floor((Date.now() - state.firstRun) / 86400000);
  if (left > 0) return { pro: true, kind: 'trial', daysLeft: left };
  return { pro: false, kind: 'free' };
}
function activate(code) {
  const info = verify(code);
  if (!info) return { ok: false, msg: '激活码无效或已过期' };
  state.code = code.trim(); save();
  return { ok: true, status: status() };
}
function deactivate() { state.code = null; save(); return status(); }

module.exports = { init, status, activate, deactivate, verify };

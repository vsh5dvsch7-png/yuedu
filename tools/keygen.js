#!/usr/bin/env node
/**
 * 激活码工具
 *   node tools/keygen.js init                 生成密钥对（tools/keys/private.pem, public.pem）并把公钥写进 src/license.js
 *   node tools/keygen.js gen <用户名> [天数]   生成激活码；天数省略或 0 = 永久
 *   node tools/keygen.js check <激活码>        校验激活码
 * tools/keys/ 已加入 .gitignore，私钥务必自己备份，丢了就无法再签发激活码。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const keyDir = path.join(__dirname, 'keys');
const privFile = path.join(keyDir, 'private.pem'), pubFile = path.join(keyDir, 'public.pem');
const licFile = path.join(root, 'src', 'license.js');
const b64u = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === 'init') {
  if (fs.existsSync(privFile)) { console.error('私钥已存在，如需重新生成请先手动删除 tools/keys/'); process.exit(1); }
  fs.mkdirSync(keyDir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(pubFile, pub);
  let src = fs.readFileSync(licFile, 'utf8');
  src = src.replace(/const PUBLIC_KEY_PEM = `[\s\S]*?`;/, 'const PUBLIC_KEY_PEM = `' + pub.trim() + '`;');
  fs.writeFileSync(licFile, src);
  console.log('密钥对已生成，公钥已写入 src/license.js\n私钥：' + privFile);
} else if (cmd === 'gen') {
  if (!a1) { console.error('用法: node tools/keygen.js gen <用户名> [天数]'); process.exit(1); }
  const days = parseInt(a2 || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ n: a1, t: now, e: days > 0 ? now + days * 86400 : 0 }));
  const sig = crypto.sign(null, payload, crypto.createPrivateKey(fs.readFileSync(privFile)));
  console.log('YD-' + b64u(payload) + '.' + b64u(sig));
} else if (cmd === 'check') {
  const lic = require(licFile);
  console.log(lic.verify(a1) || '无效');
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).join('\n'));
}

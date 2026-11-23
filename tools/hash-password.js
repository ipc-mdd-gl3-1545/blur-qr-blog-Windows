#!/usr/bin/env node
'use strict';
/**
 * 生成后台密码哈希
 *   node tools/hash-password.js '你的密码'            → 打印可用于 .env 的哈希
 *   node tools/hash-password.js '你的密码' --write    → 直接写入 data/admin.json（优先级低于 .env）
 *   node tools/hash-password.js                       → 随机生成一个强密码
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
let pw = args.find(a => !a.startsWith('--')) || crypto.randomBytes(9).toString('base64url');

if (pw.length < 8) {
  console.error('✗ 密码至少 8 位');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
const hash = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;

console.log('');
console.log('密码：', pw);
console.log('哈希：', hash);
console.log('');
console.log('把下面这一行写入项目根目录的 .env 文件，然后重启服务：');
console.log('');
console.log('ADMIN_PASSWORD_HASH=' + hash);
console.log('');

if (write) {
  const dir = path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'admin.json');
  fs.writeFileSync(f, JSON.stringify({ hash, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  console.log('✓ 已写入', f, '（.env 中的 ADMIN_PASSWORD_HASH 优先级更高）');
  console.log('');
}

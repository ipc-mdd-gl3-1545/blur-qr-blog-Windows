#!/usr/bin/env node
'use strict';
/**
 * 清理未被任何文章引用的上传图片（安全模式：默认只列出，不删除）
 *   node tools/clean-uploads.js             → 只列出可清理的文件
 *   node tools/clean-uploads.js --delete    → 真正删除
 *
 * 只会操作 UPLOAD_DIR（默认 ./uploads），不会碰其它目录。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 读取 .env（与 server.js 相同的极简解析）
const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || 'uploads');
const DEL = process.argv.includes('--delete');

if (!fs.existsSync(UPLOAD_DIR)) { console.log('图片目录不存在：' + UPLOAD_DIR); process.exit(0); }
if (!fs.existsSync(path.join(DATA_DIR, 'blog.db'))) { console.log('数据库不存在：' + path.join(DATA_DIR, 'blog.db')); process.exit(1); }

const db = new DatabaseSync(path.join(DATA_DIR, 'blog.db'));
const rows = db.prepare('SELECT title,body,cover FROM articles').all();
const used = new Set();
for (const r of rows) {
  for (const m of String(r.body || '').matchAll(/\/uploads\/([A-Za-z0-9._-]+)/g)) used.add(m[1]);
  for (const m of String(r.cover || '').matchAll(/\/uploads\/([A-Za-z0-9._-]+)/g)) used.add(m[1]);
}
db.close();

const files = fs.readdirSync(UPLOAD_DIR).filter(f => fs.statSync(path.join(UPLOAD_DIR, f)).isFile());
const orphans = files.filter(f => !used.has(f));
let bytes = 0;
for (const f of orphans) bytes += fs.statSync(path.join(UPLOAD_DIR, f)).size;

console.log(`图片总数 ${files.length}，被引用 ${files.length - orphans.length}，可清理 ${orphans.length}（${(bytes / 1024).toFixed(1)} KB）`);
orphans.forEach(f => console.log('  - ' + f));

if (!orphans.length) process.exit(0);
if (!DEL) {
  console.log('\n以上文件仅列出，未删除。确认无误后执行：node tools/clean-uploads.js --delete');
  process.exit(0);
}
for (const f of orphans) fs.unlinkSync(path.join(UPLOAD_DIR, f));
console.log(`\n✓ 已删除 ${orphans.length} 个文件`);

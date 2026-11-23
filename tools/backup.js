#!/usr/bin/env node
'use strict';
/**
 * 数据库热备份（服务运行中也能安全执行）
 *   node tools/backup.js              → 备份到 data/backups/blog-YYYYMMDD-HHMMSS.db
 *   node tools/backup.js /mnt/backup  → 备份到指定目录
 * 原理：SQLite 的 VACUUM INTO，生成一致的完整副本，不锁表。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

// 读取 .env
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
const DB_FILE = path.join(DATA_DIR, 'blog.db');
if (!fs.existsSync(DB_FILE)) {
  console.error('✗ 数据库不存在：' + DB_FILE);
  process.exit(1);
}

const stamp = (() => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();

const outDir = path.resolve(process.argv[2] || path.join(DATA_DIR, 'backups'));
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `blog-${stamp}.db`);

const db = new DatabaseSync(DB_FILE, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${outFile.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`✓ 备份完成：${outFile}（${kb} KB）`);

// 只保留最近 14 份（同一目录下的自动备份）
const all = fs.readdirSync(outDir).filter(f => /^blog-\d{8}-\d{6}\.db$/.test(f)).sort();
const keep = 14;
while (all.length > keep) {
  const old = all.shift();
  fs.unlinkSync(path.join(outDir, old));
  console.log('  已清理旧备份：' + old);
}
console.log('提示：图片目录 uploads/ 需要单独备份（rsync / tar）。');

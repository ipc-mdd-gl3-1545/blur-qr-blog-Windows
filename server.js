'use strict';
/**
 * 模糊二维码 · 博客后端（生产版）
 * 依赖：仅 Node.js 内置模块 + node:sqlite（Node >= 22.5）
 * 启动：node server.js          （读取同目录 .env，可被系统环境变量覆盖）
 * 健康检查：GET /healthz
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/* ------------------------------------------------------------------ */
/* 0. 运行时检查                                                       */
/* ------------------------------------------------------------------ */
const NODE_MIN = [22, 5, 0];
const cur = process.versions.node.split('.').map(Number);
if (cur[0] < NODE_MIN[0] || (cur[0] === NODE_MIN[0] && cur[1] < NODE_MIN[1])) {
  console.error(`\n[启动失败] 需要 Node.js >= ${NODE_MIN.join('.')}（当前 ${process.versions.node}）。`);
  console.error('Ubuntu 安装：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs\n');
  process.exit(1);
}
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\n[启动失败] 当前 Node 不支持 node:sqlite。请升级到 Node 22.5+（推荐 22 LTS 或 24 LTS）。\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 1. 配置（.env → 环境变量优先级更高）                                */
/* ------------------------------------------------------------------ */
const ROOT = __dirname;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, '').trim();     // 去掉行内注释
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = k => (process.env[k] === undefined ? '' : String(process.env[k]).trim());
const envNum = (k, d) => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };
const envBool = (k, d) => { const v = env(k).toLowerCase(); return v === '' ? d : /^(1|true|yes|on)$/.test(v); };

const PORT = envNum('PORT', 8080);
const HOST = env('HOST') || '0.0.0.0';
const DATA_DIR = path.resolve(ROOT, env('DATA_DIR') || 'data');
const UPLOAD_DIR = path.resolve(ROOT, env('UPLOAD_DIR') || 'uploads');
const TRUST_PROXY = envBool('TRUST_PROXY', true);          // 位于 Nginx 后面时开启
const ADMIN_PATH = (() => {
  let p = env('ADMIN_PATH') || '/manage';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/manage';
})();
const SESSION_TTL = envNum('SESSION_TTL_HOURS', 12) * 3600 * 1000;
const MAX_IMAGE_MB = envNum('MAX_IMAGE_MB', 5);
const MAX_UPLOAD = Math.round(MAX_IMAGE_MB * 1024 * 1024) + 512 * 1024;  // 预留 multipart 头开销
const MAX_JSON = 4 * 1024 * 1024;
const LOG_REQUESTS = envBool('LOG_REQUESTS', true);       // 是否记录每一条 HTTP 请求
const LOG_BUFFER = envNum('LOG_BUFFER', 1200);            // 内存里保留多少条日志给后台看
const LOG_FILE_MB = envNum('LOG_FILE_MB', 5);             // 日志文件轮转阈值
const METRIC_INTERVAL = Math.min(60, Math.max(5, envNum('METRIC_INTERVAL_SEC', 10)));   // 采样间隔（秒）
const GZIP = envBool('GZIP', true);

/* ---- 小影院：本地视频 + 弹幕 ---- */
const LOCAL_VIDEO_DIR = env('LOCAL_VIDEO_DIR');                      // 本地视频目录（局域网直读，秒开不卡）
const MAX_VIDEO_MB = envNum('MAX_VIDEO_MB', 4096);                   // 后台单个视频上限
const MAX_VIDEO_BYTES = Math.round(MAX_VIDEO_MB * 1024 * 1024);
const DM_MAX_LEN = Math.min(envNum('DANMAKU_MAX_LEN', 50), 100);     // 单条弹幕字数上限
const DM_COOLDOWN = envNum('DANMAKU_COOLDOWN_SEC', 3) * 1000;        // 同一 IP 发送间隔
const DM_PAGE_MAX = envNum('DANMAKU_FETCH_MAX', 2000);               // 单次拉取上限

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (LOCAL_VIDEO_DIR) { try { fs.mkdirSync(LOCAL_VIDEO_DIR, { recursive: true }); } catch (e) { /* 目录不可创建时只在用到时报警 */ } }

/* ------------------------------------------------------------------ */
/* 2. 密码与会话密钥                                                    */
/* ------------------------------------------------------------------ */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
function checkHash(pw, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expect = Buffer.from(parts[5], 'base64');
    const key = crypto.scryptSync(String(pw == null ? '' : pw), salt, expect.length, { N, r, p });
    return key.length === expect.length && crypto.timingSafeEqual(key, expect);
  } catch (e) { return false; }
}

const ADMIN_HASH_FILE = path.join(DATA_DIR, 'admin.json');
let adminHash = env('ADMIN_PASSWORD_HASH');
let generatedPassword = '';

if (!adminHash && fs.existsSync(ADMIN_HASH_FILE)) {
  try { adminHash = JSON.parse(fs.readFileSync(ADMIN_HASH_FILE, 'utf8')).hash || ''; } catch (e) { adminHash = ''; }
}
if (!adminHash && env('ADMIN_PASSWORD')) {
  adminHash = hashPassword(env('ADMIN_PASSWORD'));
  try {
    fs.writeFileSync(ADMIN_HASH_FILE, JSON.stringify({ hash: adminHash, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch (e) { console.warn('[warn] 无法写入密码文件:', e.message); }
}
if (!adminHash) {
  generatedPassword = crypto.randomBytes(9).toString('base64url');   // 12 位随机密码
  adminHash = hashPassword(generatedPassword);
  try {
    fs.writeFileSync(ADMIN_HASH_FILE, JSON.stringify({ hash: adminHash, createdAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch (e) { console.warn('[warn] 无法写入密码文件:', e.message); }
}

const SESSION_SECRET = (() => {
  if (env('SESSION_SECRET')) return env('SESSION_SECRET');
  const keyFile = path.join(DATA_DIR, 'session.key');
  try {
    if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  } catch (e) { /* ignore */ }
  const k = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(keyFile, k, { mode: 0o600 }); } catch (e) { /* ignore */ }
  return k;
})();

/* ------------------------------------------------------------------ */
/* 3. 数据库                                                           */
/* ------------------------------------------------------------------ */
const DB_FILE = path.join(DATA_DIR, 'blog.db');

/* ---------------- 本地备份（SQLite 文件快照） ---------------- */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');   // 与 tools/backup.js 保持一致
const BACKUP_KEEP = 30;
let bkStatus = { state: 'idle', message: '' };

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
function backupName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return 'blog-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.db';
}
function listBackups() {
  try {
    ensureBackupDir();
    return fs.readdirSync(BACKUP_DIR)
      .filter(n => /^blog-\d{8}-\d{6}\.db$/.test(n))
      .map(n => {
        const st = fs.statSync(path.join(BACKUP_DIR, n));
        return { name: n, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}
function runBackup() {
  ensureBackupDir();
  const name = backupName();
  const dest = path.join(BACKUP_DIR, name);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  // VACUUM INTO 生成一致性快照，服务运行中执行也安全（SQLite 3.27+）
  const sqlPath = dest.replace(/\\/g, '/').replace(/'/g, "''");
  db.exec("VACUUM INTO '" + sqlPath + "'");
  for (const old of listBackups().slice(BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch (e) { /* 忽略 */ }
  }
  return name;
}

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS articles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    tag         TEXT    NOT NULL DEFAULT '',
    body        TEXT    NOT NULL DEFAULT '',
    cover       TEXT    NOT NULL DEFAULT '',
    published   INTEGER NOT NULL DEFAULT 1,
    views       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at DESC);

  CREATE TABLE IF NOT EXISTS danmaku (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    video       TEXT    NOT NULL,
    t           REAL    NOT NULL,
    text        TEXT    NOT NULL,
    color       TEXT    NOT NULL DEFAULT '#ffffff',
    ip_hash     TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_danmaku_video ON danmaku(video, t);
`);

// 兼容老库：缺列则补
(() => {
  const cols = db.prepare('PRAGMA table_info(articles)').all().map(c => c.name);
  if (!cols.includes('published')) db.exec('ALTER TABLE articles ADD COLUMN published INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('views')) db.exec('ALTER TABLE articles ADD COLUMN views INTEGER NOT NULL DEFAULT 0');
})();

const qList = db.prepare(`SELECT id,title,tag,body,cover,published,views,created_at,updated_at
                          FROM articles WHERE published = 1 ORDER BY created_at DESC`);
const qListAll = db.prepare(`SELECT id,title,tag,body,cover,published,views,created_at,updated_at
                             FROM articles ORDER BY created_at DESC`);
const qGet = db.prepare(`SELECT id,title,tag,body,cover,published,views,created_at,updated_at
                         FROM articles WHERE id = ?`);
const qInsert = db.prepare(`INSERT INTO articles (title,tag,body,cover,published,created_at,updated_at)
                            VALUES (?,?,?,?,?,?,?)`);
const qUpdate = db.prepare(`UPDATE articles SET title=?,tag=?,body=?,cover=?,published=?,updated_at=? WHERE id=?`);
const qDelete = db.prepare('DELETE FROM articles WHERE id=?');
const qView = db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?');

// 弹幕
const qDmList = db.prepare(`SELECT id,t,text,color FROM danmaku WHERE video = ?
                            ORDER BY t ASC, id ASC LIMIT ?`);
const qDmInsert = db.prepare(`INSERT INTO danmaku (video,t,text,color,ip_hash,created_at)
                              VALUES (?,?,?,?,?,?)`);
const qDmCount = db.prepare('SELECT count(*) c FROM danmaku WHERE video = ?');
const qDmTrim = db.prepare(`DELETE FROM danmaku WHERE video = ?
                            AND id NOT IN (SELECT id FROM danmaku WHERE video = ? ORDER BY id DESC LIMIT 5000)`);

/* ------------------------------------------------------------------ */
/* 4. 通用工具                                                         */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json'
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg)/;

function json(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}
function fail(res, status, msg) { return json(res, status, { error: msg }); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) { const e = new Error(`请求体超过上限 ${Math.round(limit / 1024)}KB`); e.status = 413; reject(e); }
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}
function parseJson(buf) {
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { const err = new Error('JSON 格式不正确'); err.status = 400; throw err; }
}
const str = (v, max) => String(v == null ? '' : v).slice(0, max == null ? 20000 : max);

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (TRUST_PROXY) {
    const p = req.headers['x-forwarded-proto'];
    if (p) return String(p).split(',')[0].trim() === 'https';
  }
  return false;
}

/* ---- 会话 ---- */
function signToken() {
  const payload = `admin.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const i = tok.lastIndexOf('.');
  if (i < 0) return false;
  const payload = tok.slice(0, i), sig = tok.slice(i + 1);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (sig.length !== expect.length) return false;
  let equal = false;
  try { equal = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch (e) { return false; }
  if (!equal) return false;
  const ts = Number(payload.split('.')[1]);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < SESSION_TTL && Date.now() >= ts - 60000;
}
function getToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === 'wb_admin') {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (e) { return ''; }
    }
  }
  return '';
}
const isAuthed = req => verifyToken(getToken(req));

function cookieHeader(req, token, maxAgeSec) {
  const bits = [`wb_admin=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) bits.push('Secure');
  return bits.join('; ');
}

/* ---- 登录限速（防爆破） ---- */
const LOGIN_MAX = envNum('LOGIN_MAX_TRIES', 8);
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_LOCK = 15 * 60 * 1000;
const loginState = new Map();   // ip -> { count, since, lockUntil }
function loginLockRemain(ip) {
  const s = loginState.get(ip);
  if (!s) return 0;
  if (s.lockUntil && s.lockUntil > Date.now()) return Math.ceil((s.lockUntil - Date.now()) / 1000);
  return 0;
}
function loginFail(ip) {
  const now = Date.now();
  let s = loginState.get(ip);
  if (!s || now - s.since > LOGIN_WINDOW) s = { count: 0, since: now, lockUntil: 0 };
  s.count += 1;
  if (s.count >= LOGIN_MAX) s.lockUntil = now + LOGIN_LOCK;
  loginState.set(ip, s);
  if (loginState.size > 5000) {
    for (const [k, v] of loginState) if (!v.lockUntil || v.lockUntil < now) loginState.delete(k);
  }
}
function loginOk(ip) { loginState.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginState) {
    if (now - v.since > LOGIN_WINDOW && (!v.lockUntil || v.lockUntil < now)) loginState.delete(k);
  }
}, 5 * 60 * 1000).unref();

/* ---- 同源校验（配合 SameSite=Strict 双重防 CSRF） ---- */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
  }
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  return true;
}

/* ---- 安全响应头 ---- */
function securityHeaders(req, res, isHtml) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isHtml) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data: blob: https:",
      // 视频全部走 /api/play 同源读出，不需要放开任何外部媒体源
      "media-src 'self' blob: data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; '));
  }
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/* ------------------------------------------------------------------ */
/* 5. multipart 解析                                                   */
/* ------------------------------------------------------------------ */
function parseMultipart(buf, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType || '');
  if (!bm) { const e = new Error('缺少 multipart boundary'); e.status = 400; throw e; }
  const bbuf = Buffer.from('--' + (bm[1] || bm[2]));
  const fields = {}, files = [];
  let pos = buf.indexOf(bbuf);
  while (pos >= 0) {
    let segStart = pos + bbuf.length;
    if (buf[segStart] === 13 && buf[segStart + 1] === 10) segStart += 2;
    else break;
    const next = buf.indexOf(bbuf, segStart);
    if (next < 0) break;
    let segEnd = next;
    if (buf[segEnd - 2] === 13 && buf[segEnd - 1] === 10) segEnd -= 2;
    const seg = buf.subarray(segStart, segEnd);
    const hEnd = seg.indexOf('\r\n\r\n');
    if (hEnd >= 0) {
      const headers = seg.subarray(0, hEnd).toString('utf8');
      const data = Buffer.from(seg.subarray(hEnd + 4));
      const nameM = /name="([^"]*)"/.exec(headers);
      const fileM = /filename="([^"]*)"/.exec(headers);
      const ctM = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
      const name = nameM ? nameM[1] : '';
      if (fileM && fileM[1]) files.push({ field: name, filename: fileM[1], contentType: ctM ? ctM[1].trim().toLowerCase() : '', data });
      else fields[name] = data.toString('utf8');
    }
    pos = next;
    if (buf[pos + bbuf.length] === 45 && buf[pos + bbuf.length + 1] === 45) break;
  }
  return { fields, files };
}

const IMG_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
function looksLikeImage(buf, ct) {
  if (buf.length < 12) return false;
  if (ct === 'image/png') return buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG';
  if (ct === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === 'image/gif') return buf.subarray(0, 3).toString('latin1') === 'GIF';
  if (ct === 'image/webp') return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/* ------------------------------------------------------------------ */
/* 6. 静态文件                                                         */
/* ------------------------------------------------------------------ */
const DENY_FILES = new Set([
  'server.js', 'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.env', '.env.example', 'readme.md', 'deploy.md', 'admin.html', '.gitignore',
  'dockerfile', 'docker-compose.yml'
]);

function denyStatic(urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  if (!rel) return false;
  const parts = rel.split('/');
  for (const p of parts) {
    if (p.startsWith('.') || p.startsWith('_')) return true;
    if (p === 'data' || p === 'deploy' || p === 'tools' || p === 'node_modules') return true;
  }
  const base = parts[parts.length - 1].toLowerCase();
  if (DENY_FILES.has(base)) return true;
  if (/\.(db|db-wal|db-shm|key|log|pem|crt|sh|env|bak|sql|ini|conf|service)$/i.test(base)) return true;
  return false;
}

const gzipCache = new Map();   // key -> { buf, size }
function gzipCached(file, stat) {
  const key = `${file}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  const hit = gzipCache.get(key);
  if (hit) return hit.buf;
  if (stat.size > 8 * 1024 * 1024) return null;
  const buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
  if (gzipCache.size > 60) gzipCache.clear();
  gzipCache.set(key, { buf });
  return buf;
}

function sendFile(req, res, file, opts) {
  const o = opts || {};
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return fail(res, 404, '文件不存在'); }
  if (!stat.isFile()) return fail(res, 404, '文件不存在');

  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': o.cache || 'no-cache',
    'ETag': etag,
    'Last-Modified': new Date(stat.mtimeMs).toUTCString()
  };
  securityHeaders(req, res, /^text\/html/.test(mime));

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, Object.assign({}, headers, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1
    }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.end()).pipe(res);
    return;
  }

  const accept = String(req.headers['accept-encoding'] || '');
  if (GZIP && COMPRESSIBLE.test(mime) && stat.size > 1024 && /\bgzip\b/.test(accept)) {
    const gz = gzipCached(file, stat);
    if (gz) {
      res.writeHead(200, Object.assign({}, headers, {
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        'Content-Length': gz.length
      }));
      if (req.method === 'HEAD') return res.end();
      return res.end(gz);
    }
  }

  res.writeHead(200, Object.assign({}, headers, { 'Content-Length': stat.size }));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.end()).pipe(res);
}

/* ------------------------------------------------------------------ */
/* 7. 业务 API                                                         */
/* ------------------------------------------------------------------ */
/* ---- 小影院：只从 LOCAL_VIDEO_DIR 读视频，不依赖任何网盘 ---- */
const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|flv|f4v|ts|m3u8)$/i;

const dmLast = new Map();   // ip -> 上次发送时间
const ipHash = ip => crypto.createHash('sha256').update(String(ip) + '|dm').digest('hex').slice(0, 16);

function articleRow(r) {
  return {
    id: r.id, title: r.title, tag: r.tag, body: r.body, cover: r.cover,
    published: !!r.published, views: r.views,
    created: r.created_at, updated: r.updated_at
  };
}

/* 本地视频：直接读磁盘，支持 Range，局域网可以随便拖进度条 */
const MIME_VIDEO = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.ts': 'video/mp2t'
};
function videoMime(n) {
  return MIME_VIDEO[path.extname(n).toLowerCase()] || 'video/mp4';
}

/* 后台视频管理：文件名消毒 → 防路径穿越、防隐藏文件、限长、校验扩展名 */
function safeVideoName(raw) {
  let n = String(raw || '');
  try { n = decodeURIComponent(n); } catch (_) { return ''; }
  if (/[\\/]/.test(n)) return '';                        // 名字里不许带路径，直接拒绝
  n = n.normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')   // 路径分隔符与控制字符
    .replace(/^\.+/, '')                                 // 不许隐藏文件
    .replace(/\s+/g, ' ')
    .trim();
  if (!n || n.length > 120) return '';
  if (!VIDEO_EXT.test(n)) return '';
  if (n.includes('..')) return '';
  return n;
}

/* 重名时自动加序号：a.mp4 → a-2.mp4 */
function uniqueVideoName(base) {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let name = base;
  for (let i = 2; fs.existsSync(path.join(LOCAL_VIDEO_DIR, name)) && i < 1000; i++) {
    name = stem + '-' + i + ext;
  }
  return name;
}

/* 列出视频（后台用，比公开接口多返回时长无关的元信息） */
function localVideoRows() {
  if (!LOCAL_VIDEO_DIR) return [];
  let ents = [];
  try { ents = fs.readdirSync(LOCAL_VIDEO_DIR, { withFileTypes: true }); }
  catch (e) { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || !VIDEO_EXT.test(e.name)) continue;
    let st;
    try { st = fs.statSync(path.join(LOCAL_VIDEO_DIR, e.name)); } catch (_) { continue; }
    out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

// 视频目录能不能写。磁盘写满后 ext4 会自动切只读（EROFS），这时肉眼看不出来，
// 但上传必然失败——所以上传前先探一次，别让浏览器白传几十 MB 才报错。
function videoDirWritable() {
  if (!LOCAL_VIDEO_DIR) return { ok: false, code: 'LOCAL_VIDEO_DIR 未配置' };
  try {
    fs.accessSync(LOCAL_VIDEO_DIR, fs.constants.W_OK);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || e.message };
  }
}

function localVideos() {
  if (!LOCAL_VIDEO_DIR) return [];
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(LOCAL_VIDEO_DIR, { withFileTypes: true }); }
  catch (e) { log('本地视频目录读取失败：' + e.message, 'error', 'video'); return []; }
  for (const e of ents) {
    if (!e.isFile() || !VIDEO_EXT.test(e.name)) continue;
    let size = 0;
    try { size = fs.statSync(path.join(LOCAL_VIDEO_DIR, e.name)).size; } catch (_) { continue; }
    out.push({
      name: e.name,
      path: 'local:' + e.name,
      size,
      thumb: '',
      src: 'local',
      play: '/api/play?local=' + encodeURIComponent(e.name)
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

function serveLocalVideo(req, res, name) {
  if (!LOCAL_VIDEO_DIR) return fail(res, 404, '没有配置本地视频目录');
  const base = path.basename(name);
  if (base !== name || !VIDEO_EXT.test(base)) return fail(res, 400, '视频名不合法');
  const full = path.join(LOCAL_VIDEO_DIR, base);
  let st;
  try { st = fs.statSync(full); } catch (_) { return fail(res, 404, '视频不存在'); }
  if (!st.isFile()) return fail(res, 404, '视频不存在');

  const total = st.size;
  let start = 0, end = total - 1, code = 200;
  const rh = req.headers.range;
  if (rh) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rh));
    if (m) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), total - 1);
      } else if (m[2]) {
        start = Math.max(0, total - Number(m[2]));
      }
      if (!Number.isFinite(start) || start < 0 || start >= total) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        return res.end();
      }
      code = 206;
    }
  }
  const head = {
    'Content-Type': videoMime(base),
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600'
  };
  if (code === 206) head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
  res.writeHead(code, head);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full, { start, end })
    .on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } })
    .pipe(res);
}

/* ---- 后台：数据库只读浏览 / 备份 / 维护 ----
   原则：表名一律来自 sqlite_master 白名单，排序字段一律来自 PRAGMA table_info，
   不用任何用户输入直接拼 SQL 的标识符部分，避免注入。 */
function dbTables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(r => r.name);
}
function dbQuote(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
function dbTableMeta(name) {
  if (!dbTables().includes(name)) return null;
  const cols = db.prepare('PRAGMA table_info(' + dbQuote(name) + ')').all()
    .map(c => ({ name: c.name, type: c.type || '', pk: !!c.pk, notnull: !!c.notnull }));
  const rows = db.prepare('SELECT COUNT(*) AS c FROM ' + dbQuote(name)).get().c;
  return { name, columns: cols, rows };
}
function dbFileInfo() {
  const sz = f => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
  const ver = (() => { try { return db.prepare('SELECT sqlite_version() AS v').get().v; } catch (_) { return ''; } })();
  const page = (() => { try { return db.prepare('PRAGMA page_size').get().page_size; } catch (_) { return 0; } })();
  return {
    file: DB_FILE,
    size: sz(DB_FILE),
    walSize: sz(DB_FILE + '-wal'),
    shmSize: sz(DB_FILE + '-shm'),
    pageSize: page,
    sqlite: ver
  };
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function handleApi(req, res, u) {
  const seg = u.pathname.split('/').filter(Boolean);
  const method = req.method.toUpperCase();
  const p = u.pathname;

  // 写操作同源校验
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    return fail(res, 403, '跨站请求被拒绝');
  }

  /* ---- 会话 ---- */
  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const remain = loginLockRemain(ip);
    if (remain > 0) return fail(res, 429, `尝试次数过多，请 ${Math.ceil(remain / 60)} 分钟后再试`);
    const d = parseJson(await readBody(req, MAX_JSON));
    const pw = String(d.password == null ? '' : d.password);
    if (!checkHash(pw, adminHash)) {
      loginFail(ip);
      log('登录失败：密码不正确', 'warn', 'auth', ip);
      return fail(res, 401, '密码不正确');
    }
    loginOk(ip);
    log('登录成功', 'info', 'auth', ip);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': cookieHeader(req, signToken(), Math.floor(SESSION_TTL / 1000)),
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/logout' && method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': cookieHeader(req, '', 0),
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/session' && method === 'GET') {
    return json(res, 200, { authed: isAuthed(req) });
  }

  /* ---- 公开读取 ---- */
  if (p === '/api/articles' && method === 'GET') {
    return json(res, 200, { articles: qList.all().map(articleRow) });
  }
  if (seg[0] === 'api' && seg[1] === 'articles' && /^\d+$/.test(seg[2] || '') && method === 'GET') {
    const id = Number(seg[2]);
    const r = Number.isInteger(id) ? qGet.get(id) : null;
    if (!r || !r.published) return fail(res, 404, '文章不存在');
    qView.run(id);
    return json(res, 200, { article: articleRow(Object.assign({}, r, { views: r.views + 1 })) });
  }

  /* ---- 小影院：视频列表 / 播放地址（公开） ---- */
  if (p === '/api/videos' && method === 'GET') {
    if (!LOCAL_VIDEO_DIR) {
      return json(res, 200, { source: 'none', videos: [], error: '还没有配置本地视频目录（LOCAL_VIDEO_DIR）' });
    }
    return json(res, 200, { source: 'local', dir: LOCAL_VIDEO_DIR, videos: localVideos() });
  }

  if (p === '/api/play' && (method === 'GET' || method === 'HEAD')) {
    const lname = str(u.searchParams.get('local'), 400);
    if (!lname) return fail(res, 400, '缺少视频参数');
    return serveLocalVideo(req, res, lname);
  }

  /* ---- 弹幕（公开：任何人可看可发） ---- */
  if (p === '/api/danmaku' && method === 'GET') {
    const v = str(u.searchParams.get('video'), 400);
    if (!v) return fail(res, 400, '缺少 video 参数');
    const rows = qDmList.all(v, DM_PAGE_MAX);
    return json(res, 200, { danmaku: rows.map(r => ({ id: r.id, t: r.t, x: r.text, c: r.color })) });
  }

  if (p === '/api/danmaku' && method === 'POST') {
    const d = parseJson(await readBody(req, 16 * 1024));
    const v = str(d.video, 400).trim();
    if (!v) return fail(res, 400, '缺少 video 参数');
    const text = str(d.text, 400).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!text) return fail(res, 400, '弹幕不能为空哦');
    if ([...text].length > DM_MAX_LEN) return fail(res, 400, `弹幕最多 ${DM_MAX_LEN} 个字`);
    const t = Math.max(0, Math.min(Number(d.t) || 0, 24 * 3600));
    const color = /^#[0-9a-fA-F]{6}$/.test(String(d.color || '')) ? String(d.color).toLowerCase() : '#ffffff';

    const ip = clientIp(req);
    const now = Date.now();
    const last = dmLast.get(ip) || 0;
    if (now - last < DM_COOLDOWN) {
      const wait = Math.ceil((DM_COOLDOWN - (now - last)) / 1000);
      return fail(res, 429, `发得有点快呀，${wait} 秒后再来～`);
    }
    if (dmLast.size > 5000) dmLast.clear();   // 防止 Map 无限膨胀
    dmLast.set(ip, now);

    const info = qDmInsert.run(v, t, text, color, ipHash(ip), now);
    try { if (qDmCount.get(v).c > 5000) qDmTrim.run(v, v); } catch (e) { /* 忽略清理失败 */ }
    return json(res, 201, { id: Number(info.lastInsertRowid), t, x: text, c: color });
  }

  /* ---- 以下均需登录 ---- */
  if (!isAuthed(req)) return fail(res, 401, '请先登录');

  /* ---- 后台：修改管理密码 ---- */
  if (p === '/api/admin/password' && method === 'POST') {
    const d = parseJson(await readBody(req, MAX_JSON));
    const oldPw = String(d.oldPassword == null ? '' : d.oldPassword);
    const next = String(d.newPassword == null ? '' : d.newPassword);
    if (!checkHash(oldPw, adminHash)) return fail(res, 400, '当前密码不正确');
    if (next.length < 8) return fail(res, 400, '新密码至少 8 位');
    if (next.length > 200) return fail(res, 400, '新密码太长');
    try {
      const hash = hashPassword(next);
      fs.writeFileSync(ADMIN_HASH_FILE, JSON.stringify({ hash, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
      const envFile = path.join(ROOT, '.env');
      if (fs.existsSync(envFile)) {
        const txt = fs.readFileSync(envFile, 'utf8');
        if (/^\s*ADMIN_PASSWORD_HASH\s*=/m.test(txt)) {
          fs.writeFileSync(envFile, txt.replace(/^(\s*ADMIN_PASSWORD_HASH\s*=).*$/m, '$1' + hash), 'utf8');
        }
      }
      adminHash = hash;
      log('管理密码已修改', 'warn', 'auth', clientIp(req));
      return json(res, 200, { ok: true });
    } catch (e) {
      return fail(res, 500, '保存失败：' + e.message);
    }
  }

  /* ---- 后台：本地数据库备份 ---- */
  if (p === '/api/admin/backups' && method === 'GET') {
    return json(res, 200, { status: bkStatus, backups: listBackups() });
  }
  if (p === '/api/admin/backup/status' && method === 'GET') {
    return json(res, 200, bkStatus);
  }
  if (p === '/api/admin/backup/run' && method === 'POST') {
    if (bkStatus.state === 'running') return json(res, 200, { ok: true, status: bkStatus });
    bkStatus = { state: 'running', message: '正在导出数据库', at: Date.now() };
    try {
      const name = runBackup();
      bkStatus = { state: 'done', message: '已生成 ' + name, at: Date.now() };
      log('手动备份完成：' + name, 'info', 'db', clientIp(req));
      return json(res, 200, { ok: true, name, status: bkStatus });
    } catch (e) {
      bkStatus = { state: 'failed', message: e.message, at: Date.now() };
      log('手动备份失败：' + e.message, 'error', 'db', clientIp(req));
      return fail(res, 500, '备份失败：' + e.message);
    }
  }
  if (p === '/api/admin/backup/delete' && method === 'POST') {
    const d = parseJson(await readBody(req, MAX_JSON));
    const name = String(d.name || '');
    if (!/^blog-\d{8}-\d{6}\.db$/.test(name)) return fail(res, 400, '文件名不合法');
    const f = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(f)) return fail(res, 404, '备份不存在');
    try { fs.unlinkSync(f); } catch (e) { return fail(res, 500, '删除失败：' + e.message); }
    log('删除备份：' + name, 'warn', 'db', clientIp(req));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/backup/download' && method === 'GET') {
    const name = String(u.searchParams.get('name') || '');
    if (!/^blog-\d{8}-\d{6}\.db$/.test(name)) return fail(res, 400, '文件名不合法');
    const f = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(f)) return fail(res, 404, '备份不存在');
    const buf = fs.readFileSync(f);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buf.length,
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Cache-Control': 'no-store'
    });
    return res.end(buf);
  }


  /* ---- 后台：日志 ---- */
  if (p === '/api/admin/logs' && method === 'GET') {
    const level = String(u.searchParams.get('level') || '').toLowerCase();
    const kind = str(u.searchParams.get('kind'), 20).toLowerCase();
    const kw = str(u.searchParams.get('q'), 120).trim().toLowerCase();
    const limit = Math.min(500, Math.max(10, Number(u.searchParams.get('limit')) || 200));
    const before = Number(u.searchParams.get('before')) || 0;

    let rows = logBuf;
    if (level === 'warn+') rows = rows.filter(r => r.level !== 'info');
    else if (level && level !== 'all') rows = rows.filter(r => r.level === level);
    if (kind && kind !== 'all') rows = rows.filter(r => r.kind === kind);
    if (kw) rows = rows.filter(r => r.msg.toLowerCase().includes(kw) || r.ip.includes(kw) || r.kind.includes(kw));
    if (before) rows = rows.filter(r => r.id < before);

    const total = rows.length;
    const page = rows.slice(-limit).reverse();     // 最新的在最前面
    return json(res, 200, {
      logs: page,
      total,
      hasMore: page.length > 0 && page[page.length - 1].id > 1 && total > page.length,
      counts: lifeCounts,
      kinds: Array.from(new Set(logBuf.map(r => r.kind))).sort(),
      buffered: logBuf.length,
      file: { path: LOG_FILE, size: logFileSize(), max: LOG_FILE_MAX },
      bufferMax: LOG_BUFFER
    });
  }

  if (p === '/api/admin/logs/export' && method === 'GET') {
    flushLog(true);                                 // 先把攒着的那一秒刷进文件
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="blog-log-' + stamp + '.log"',
      'Cache-Control': 'no-store'
    });
    if (logFileSize() > 0) {
      const rs = fs.createReadStream(LOG_FILE);
      rs.on('error', () => { try { res.end(); } catch (_) { /* ignore */ } });
      return rs.pipe(res);
    }
    return res.end(logBuf.map(logLine).join('\n') + '\n');   // 文件还没落盘就把内存里的给出去
  }

  if (p === '/api/admin/logs' && method === 'DELETE') {
    const removed = logBuf.length;
    logBuf.length = 0;
    pendingLines = [];
    lifeCounts.info = 0; lifeCounts.warn = 0; lifeCounts.error = 0;   // 计数跟着清空一起归零
    try { fs.truncateSync(LOG_FILE, 0); } catch (_) { /* 文件可能不存在 */ }
    try { fs.truncateSync(LOG_FILE + '.1', 0); } catch (_) { /* 可能没有旧文件 */ }
    log('日志已清空（' + removed + ' 条）', 'info', 'system', clientIp(req));
    return json(res, 200, { ok: true, removed });
  }

  /* ---- 后台：监控指标 ---- */
  if (p === '/api/admin/metrics' && method === 'GET') {
    return json(res, 200, buildMetrics());
  }

  /* ---- 后台：数据库概览 ---- */
  if (p === '/api/admin/db' && method === 'GET') {
    const info = dbFileInfo();
    let tables = [];
    try {
      tables = dbTables().map(n => {
        const m = dbTableMeta(n);
        return { name: n, rows: m ? m.rows : 0, cols: m ? m.columns.length : 0 };
      });
    } catch (e) { log('数据库概览失败：' + e.message, 'error', 'db'); }
    return json(res, 200, Object.assign({ tables }, info));
  }

  /* ---- 后台：浏览某张表（分页 / 搜索 / 排序） ---- */
  if (p === '/api/admin/db/rows' && method === 'GET') {
    const name = str(u.searchParams.get('table'), 80);
    const meta = dbTableMeta(name);
    if (!meta) return fail(res, 404, '表不存在');
    const pageSize = Math.min(200, Math.max(5, Number(u.searchParams.get('size')) || 25));
    const page = Math.max(1, Number(u.searchParams.get('page')) || 1);

    const kw = str(u.searchParams.get('q'), 120).trim();
    const where = [];
    const params = [];
    if (kw) {
      const textCols = meta.columns.filter(c => /TEXT|CHAR|CLOB|^$/i.test(c.type)).slice(0, 8);
      const use = textCols.length ? textCols : meta.columns.slice(0, 4);
      if (use.length) {
        where.push('(' + use.map(c => dbQuote(c.name) + ' LIKE ?').join(' OR ') + ')');
        use.forEach(() => params.push('%' + kw + '%'));
      }
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = where.length
      ? db.prepare('SELECT COUNT(*) AS c FROM ' + dbQuote(name) + whereSql).get(...params).c
      : meta.rows;

    const sortIn = str(u.searchParams.get('sort'), 60);
    const sort = meta.columns.some(c => c.name === sortIn) ? dbQuote(sortIn) : 'rowid';
    const dir = String(u.searchParams.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * pageSize;

    let rows = [];
    try {
      rows = db.prepare(
        'SELECT * FROM ' + dbQuote(name) + whereSql + ' ORDER BY ' + sort + ' ' + dir + ' LIMIT ? OFFSET ?'
      ).all(...params, pageSize, offset);
    } catch (e) {
      // 有些表没有 rowid（WITHOUT ROWID），退化成不排序
      rows = db.prepare('SELECT * FROM ' + dbQuote(name) + whereSql + ' LIMIT ? OFFSET ?')
        .all(...params, pageSize, offset);
    }
    return json(res, 200, {
      table: name, columns: meta.columns, rows, total, page, pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)), sort: sortIn || 'rowid', dir
    });
  }

  /* ---- 后台：导出（CSV / 整库快照） ---- */
  if (p === '/api/admin/db/export' && method === 'GET') {
    const what = String(u.searchParams.get('type') || 'csv').toLowerCase();

    if (what === 'db') {
      // VACUUM INTO 生成一致性快照，避免直接拷 .db 时漏掉 WAL 里的数据
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const tmp = path.join(DATA_DIR, '.backup-' + process.pid + '-' + Date.now() + '.db');
      try {
        db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
      } catch (e) {
        return fail(res, 500, '生成备份失败：' + e.message);
      }
      const size = (() => { try { return fs.statSync(tmp).size; } catch (_) { return 0; } })();
      log('下载数据库快照（' + (size / 1048576).toFixed(2) + ' MB）', 'info', 'db', clientIp(req));
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Content-Disposition': 'attachment; filename="blog-backup-' + stamp + '.db"',
        'Cache-Control': 'no-store'
      });
      const rs = fs.createReadStream(tmp);
      rs.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
      rs.on('close', () => { fs.promises.unlink(tmp).catch(() => {}); });
      return rs.pipe(res);
    }

    const name = str(u.searchParams.get('table'), 80);
    const meta = dbTableMeta(name);
    if (!meta) return fail(res, 404, '表不存在');
    let rows;
    try { rows = db.prepare('SELECT * FROM ' + dbQuote(name)).all(); }
    catch (e) { return fail(res, 500, '读取失败：' + e.message); }
    const head = meta.columns.map(c => csvCell(c.name)).join(',');
    const body = rows.map(r => meta.columns.map(c => csvCell(r[c.name])).join(',')).join('\r\n');
    const csv = '\ufeff' + head + '\r\n' + body + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '.csv"',
      'Cache-Control': 'no-store'
    });
    return res.end(csv);
  }

  /* ---- 后台：只读 SQL 查询 ---- */
  if (p === '/api/admin/db/query' && method === 'POST') {
    const d = parseJson(await readBody(req, MAX_JSON));
    let sql = String(d.sql == null ? '' : d.sql).trim();
    if (!sql) return fail(res, 400, '请输入 SQL');
    if (sql.length > 4000) return fail(res, 400, 'SQL 太长');
    sql = sql.replace(/;\s*$/, '');
    if (!/^(select|with|explain)\b/i.test(sql)) return fail(res, 400, '只允许 SELECT / WITH / EXPLAIN 查询');
    if (/;\s*\S/.test(sql)) return fail(res, 400, '一次只能执行一条语句');
    if (/^\s*(with\s+)?[^]*\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum)\b/i.test(sql.replace(/'[^']*'/g, "''"))) {
      return fail(res, 400, '只读模式：不允许写操作');
    }
    const t0 = Date.now();
    try {
      const rows = db.prepare(sql).all();
      const cols = rows.length ? Object.keys(rows[0]) : [];
      return json(res, 200, {
        columns: cols,
        rows: rows.slice(0, 200),
        rowCount: rows.length,
        truncated: rows.length > 200,
        ms: Date.now() - t0
      });
    } catch (e) {
      return fail(res, 400, 'SQL 执行失败：' + e.message);
    }
  }

  /* ---- 后台：维护（压缩 / 检查点 / 清理孤立弹幕） ---- */
  if (p === '/api/admin/db/maintain' && method === 'POST') {
    const d = parseJson(await readBody(req, MAX_JSON));
    const action = String(d.action || '');
    const before = dbFileInfo();
    try {
      if (action === 'vacuum') {
        db.exec('VACUUM');
      } else if (action === 'checkpoint') {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } else if (action === 'orphan') {
        const keep = new Set(localVideoRows().map(v => v.name));
        const rows = db.prepare('SELECT DISTINCT video FROM danmaku').all();
        const del = db.prepare('DELETE FROM danmaku WHERE video = ?');
        let n = 0;
        for (const r of rows) if (!keep.has(r.video)) n += del.run(r.video).changes || 0;
        const after = dbFileInfo();
        log('数据库维护 orphan：清理孤立弹幕 ' + n + ' 条', 'warn', 'db', clientIp(req));
        return json(res, 200, { ok: true, action, removed: n, before, after });
      } else {
        return fail(res, 400, '不支持的操作');
      }
    } catch (e) {
      log('数据库维护失败 ' + action + '：' + e.message, 'error', 'db', clientIp(req));
      return fail(res, 500, '维护失败：' + e.message);
    }
    const afterInfo = dbFileInfo();
    log('数据库维护 ' + action + '，大小 ' + before.size + ' → ' + afterInfo.size + ' 字节', 'info', 'db', clientIp(req));
    return json(res, 200, { ok: true, action, before, after: afterInfo });
  }

  if (p === '/api/articles/all' && method === 'GET') {
    return json(res, 200, { articles: qListAll.all().map(articleRow) });
  }
  if (p === '/api/articles' && method === 'POST') {
    const d = parseJson(await readBody(req, MAX_JSON));
    const title = str(d.title, 200).trim();
    if (!title) return fail(res, 400, '标题不能为空');
    const now = Date.now();
    const info = qInsert.run(title, str(d.tag, 60).trim(), str(d.body), str(d.cover, 500),
      d.published === false ? 0 : 1, now, now);
    log('新建文章《' + title + '》', 'info', 'article', clientIp(req));
    return json(res, 201, { article: articleRow(qGet.get(Number(info.lastInsertRowid))) });
  }
  if (seg[0] === 'api' && seg[1] === 'articles' && /^\d+$/.test(seg[2] || '') && method === 'PUT') {
    const id = Number(seg[2]);
    const cur = qGet.get(id);
    if (!cur) return fail(res, 404, '文章不存在');
    const d = parseJson(await readBody(req, MAX_JSON));
    const title = str(d.title, 200).trim();
    if (!title) return fail(res, 400, '标题不能为空');
    qUpdate.run(title, str(d.tag, 60).trim(), str(d.body), str(d.cover, 500),
      d.published === false ? 0 : 1, Date.now(), id);
    log('更新文章《' + title + '》#' + id, 'info', 'article', clientIp(req));
    return json(res, 200, { article: articleRow(qGet.get(id)) });
  }
  if (seg[0] === 'api' && seg[1] === 'articles' && /^\d+$/.test(seg[2] || '') && method === 'DELETE') {
    const id = Number(seg[2]);
    const info = qDelete.run(id);
    if (!info.changes) return fail(res, 404, '文章不存在');
    log('删除文章 #' + id, 'warn', 'article', clientIp(req));
    return json(res, 200, { ok: true });
  }

  /* ---- 图片上传 ---- */
  if (p === '/api/upload' && method === 'POST') {
    const buf = await readBody(req, MAX_UPLOAD);
    const { files } = parseMultipart(buf, req.headers['content-type']);
    const f = files[0];
    if (!f) return fail(res, 400, '没有收到图片文件');
    if (f.data.length > MAX_IMAGE_MB * 1024 * 1024) return fail(res, 413, `图片不能超过 ${MAX_IMAGE_MB}MB`);
    const ext = IMG_EXT[f.contentType];
    if (!ext) return fail(res, 400, '仅支持 PNG / JPG / GIF / WebP 图片');
    if (!looksLikeImage(f.data, f.contentType)) return fail(res, 400, '文件内容不是有效图片');
    const name = crypto.randomUUID().replace(/-/g, '') + ext;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), f.data);
    return json(res, 201, { url: '/uploads/' + name, filename: name, size: f.data.length });
  }

  /* ---- 小影院：视频管理（仅后台） ---- */
  if (p === '/api/admin/videos' && method === 'GET') {
    const rows = localVideoRows();
    const w = videoDirWritable();
    return json(res, 200, {
      dir: LOCAL_VIDEO_DIR || '',
      maxMB: MAX_VIDEO_MB,
      totalBytes: rows.reduce((s, r) => s + r.size, 0),
      writable: w.ok,
      writeErr: w.ok ? undefined : w.code,
      videos: rows,
      error: LOCAL_VIDEO_DIR ? undefined : '还没有配置 LOCAL_VIDEO_DIR'
    });
  }

  // 直接收原始字节流写盘，不经过内存缓冲，几百 MB 的视频也不会撑爆服务
  if (p === '/api/admin/videos' && method === 'POST') {
    if (!LOCAL_VIDEO_DIR) return fail(res, 400, '还没有配置 LOCAL_VIDEO_DIR');
    const want = safeVideoName(u.searchParams.get('name'));
    if (!want) return fail(res, 400, '文件名不合法，或扩展名不在支持列表里');
    // 写不进去就直接拒，别让浏览器白传几十 MB 才发现（磁盘满后 ext4 会静默切只读）
    const w = videoDirWritable();
    if (!w.ok) {
      const hint = /EROFS|read-only/i.test(w.code)
        ? '，文件系统已是只读（多半是磁盘写满后 ext4 自动挂成只读，先 df -h 看空间）'
        : '';
      return fail(res, 507, '视频目录写不进去（' + w.code + '）' + hint);
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > MAX_VIDEO_BYTES) return fail(res, 413, `视频不能超过 ${MAX_VIDEO_MB}MB`);

    const name = uniqueVideoName(want);
    const dest = path.join(LOCAL_VIDEO_DIR, name);
    const tmp = dest + '.part-' + crypto.randomBytes(4).toString('hex');
    let size = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > MAX_VIDEO_BYTES) {
          const e = new Error(`视频不能超过 ${MAX_VIDEO_MB}MB`);
          e.status = 413;
          return cb(e);
        }
        cb(null, chunk);
      }
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(tmp));
      if (!size) throw Object.assign(new Error('没有收到文件内容'), { status: 400 });
      await fs.promises.rename(tmp, dest);
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch (_) { /* 临时文件可能还没建 */ }
      log('视频上传失败：' + e.message, 'error', 'video', clientIp(req));
      return fail(res, e.status || 500, e.status ? e.message : '写入失败：' + e.message);
    }
    log('视频上传完成 ' + name + '（' + (size / 1048576).toFixed(1) + ' MB）', 'info', 'video', clientIp(req));
    return json(res, 201, { ok: true, name, size });
  }

  if (p === '/api/admin/videos' && method === 'DELETE') {
    if (!LOCAL_VIDEO_DIR) return fail(res, 400, '还没有配置 LOCAL_VIDEO_DIR');
    let raw = u.searchParams.get('name') || '';
    try { raw = decodeURIComponent(raw); } catch (_) { /* 原样使用 */ }
    const name = path.basename(raw);
    if (!name || name !== raw || !VIDEO_EXT.test(name)) return fail(res, 400, '文件名不合法');
    const full = path.join(LOCAL_VIDEO_DIR, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return fail(res, 404, '视频不存在');
      await fs.promises.unlink(full);
    } catch (e) {
      return fail(res, 404, '视频不存在');
    }
    try { db.prepare('DELETE FROM danmaku WHERE video = ?').run(name); } catch (e) { /* 顺手清弹幕 */ }
    log('视频已删除 ' + name, 'warn', 'video', clientIp(req));
    return json(res, 200, { ok: true });
  }

  /* ---- 后台：弹幕管理（按视频分组查看 / 删除） ---- */
  // 视频列表 + 每个视频的弹幕条数。用 LEFT JOIN 保证没弹幕的视频也列出来。
  if (p === '/api/admin/danmaku' && method === 'GET') {
    const videos = localVideoRows();
    const counts = {};
    try {
      for (const r of db.prepare('SELECT video, count(*) c FROM danmaku GROUP BY video').all()) {
        counts[r.video] = r.c;
      }
    } catch (e) { /* 表可能还没建 */ }
    const rows = videos.map(v => ({
      name: v.name,
      size: v.size,
      count: counts[v.name] || 0,
      exists: true
    }));
    // 数据库里有、视频文件已不存在的孤立弹幕也列出来，让后台能清理
    for (const [name, c] of Object.entries(counts)) {
      if (!rows.some(r => r.name === name)) rows.push({ name, size: 0, count: c, exists: false });
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    const total = Object.values(counts).reduce((s, c) => s + c, 0);
    return json(res, 200, {
      videos: rows,
      total,
      orphan: rows.filter(r => !r.exists).length
    });
  }

  // 单个视频的弹幕明细，支持分页。video 必须是数据库里的真实值，不走文件路径拼接。
  if (p === '/api/admin/danmaku/rows' && method === 'GET') {
    const video = str(u.searchParams.get('video'), 400);
    if (!video) return fail(res, 400, '缺少 video 参数');
    const page = Math.max(1, Number(u.searchParams.get('page') || 1) || 1);
    const size = Math.min(200, Math.max(10, Number(u.searchParams.get('size') || 50) || 50));
    const q = str(u.searchParams.get('q'), 100).trim();
    try {
      const where = q ? 'WHERE video = ? AND text LIKE ?' : 'WHERE video = ?';
      const args = q ? [video, '%' + q + '%'] : [video];
      const total = db.prepare(`SELECT count(*) c FROM danmaku ${where}`).get(...args).c;
      const rows = db.prepare(`SELECT id,t,text,color,ip_hash,created_at FROM danmaku ${where}
                               ORDER BY t ASC, id ASC LIMIT ? OFFSET ?`)
        .all(...args, size, (page - 1) * size);
      return json(res, 200, {
        video, total, page, size,
        hasMore: page * size < total,
        rows: rows.map(r => ({
          id: r.id, t: r.t, text: r.text, color: r.color,
          ip: r.ip_hash ? r.ip_hash.slice(0, 8) : '',
          time: r.created_at
        }))
      });
    } catch (e) {
      return fail(res, 500, '读取弹幕失败：' + e.message);
    }
  }

  // 删一条弹幕：id 必须是数字
  if (p === '/api/admin/danmaku/delete' && method === 'POST') {
    const d = parseJson(await readBody(req, 16 * 1024));
    const id = Number(d.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '弹幕 id 不合法');
    try {
      const info = db.prepare('DELETE FROM danmaku WHERE id = ?').run(id);
      if (!info.changes) return fail(res, 404, '弹幕不存在');
      log('删除弹幕 #' + id, 'warn', 'danmaku', clientIp(req));
      return json(res, 200, { ok: true });
    } catch (e) {
      return fail(res, 500, '删除失败：' + e.message);
    }
  }

  // 清空某个视频的全部弹幕；all=1 时清空整库
  if (p === '/api/admin/danmaku/clear' && method === 'POST') {
    const d = parseJson(await readBody(req, 16 * 1024));
    const all = d.all === true || d.all === 1;
    const video = all ? '' : str(d.video, 400);
    if (!all && !video) return fail(res, 400, '缺少 video 参数');
    try {
      const info = all
        ? db.prepare('DELETE FROM danmaku').run()
        : db.prepare('DELETE FROM danmaku WHERE video = ?').run(video);
      log('清空弹幕 ' + (all ? '（全部）' : video) + '，共 ' + info.changes + ' 条', 'warn', 'danmaku', clientIp(req));
      return json(res, 200, { ok: true, removed: info.changes });
    } catch (e) {
      return fail(res, 500, '清空失败：' + e.message);
    }
  }

  /* ---- 备份 ---- */
  if (p === '/api/export' && method === 'GET') {
    return json(res, 200, {
      version: 2, exportedAt: Date.now(),
      articles: qListAll.all().map(articleRow)
    });
  }
  if (p === '/api/import' && method === 'POST') {
    const d = parseJson(await readBody(req, MAX_JSON));
    if (!Array.isArray(d.articles)) return fail(res, 400, '备份格式不正确');
    const rows = d.articles.filter(a => a && typeof a.title === 'string');
    if (d.mode === 'replace') db.exec('DELETE FROM articles');
    const now = Date.now();
    let n = 0;
    for (const a of rows) {
      qInsert.run(str(a.title, 200), str(a.tag, 60), str(a.body), str(a.cover, 500),
        a.published === false ? 0 : 1,
        Number(a.created) || now, Number(a.updated) || Number(a.created) || now);
      n++;
    }
    return json(res, 200, { imported: n });
  }

  /* ---- 站点信息 ---- */
  if (p === '/api/stats' && method === 'GET') {
    const total = db.prepare('SELECT count(*) c FROM articles').get().c;
    const pub = db.prepare('SELECT count(*) c FROM articles WHERE published = 1').get().c;
    const views = db.prepare('SELECT coalesce(sum(views),0) v FROM articles').get().v;
    const bytes = (() => {
      try { return fs.readdirSync(UPLOAD_DIR).reduce((s, f) => s + fs.statSync(path.join(UPLOAD_DIR, f)).size, 0); }
      catch (e) { return 0; }
    })();
    const danmaku = db.prepare('SELECT count(*) c FROM danmaku').get().c;
    return json(res, 200, { total, published: pub, drafts: total - pub, views, uploadBytes: bytes, danmaku });
  }

  return fail(res, 404, '接口不存在');
}

/* ------------------------------------------------------------------ */
/* 8. 日志（内存环形缓冲 + 落盘轮转）                                    */
/* ------------------------------------------------------------------ */
const LOG_FILE = path.join(DATA_DIR, 'blog.log');
const LOG_FILE_MAX = Math.round(LOG_FILE_MB * 1024 * 1024);
const LOG_SKIP = new Set(['/api/admin/metrics', '/api/admin/logs', '/api/admin/danmaku', '/api/admin/danmaku/rows']); // 后台自己的轮询不写日志

const logBuf = [];                                     // 后台「日志」页直接读这里
const lifeCounts = { info: 0, warn: 0, error: 0 };     // 本次运行累计条数
let logSeq = 0;
let pendingLines = [];

const pad2 = n => String(n).padStart(2, '0');
function tsText(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function logLine(e) {
  return tsText(e.ts) + ' [' + e.level.toUpperCase() + '] ' + e.kind +
    (e.ip ? ' ' + e.ip : '') + ' | ' + e.msg;
}

/**
 * 记一条日志。
 * @param {string} msg   内容
 * @param {string} level info | warn | error
 * @param {string} kind  request / auth / article / video / db / system
 * @param {string} ip    访问者 IP（可省略）
 */
function log(msg, level, kind, ip) {
  const lv = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  const e = {
    id: ++logSeq,
    ts: Date.now(),
    level: lv,
    kind: String(kind || 'system').slice(0, 20),
    msg: String(msg == null ? '' : msg).slice(0, 2000),
    ip: String(ip || '').slice(0, 60)
  };
  logBuf.push(e);
  if (logBuf.length > LOG_BUFFER) logBuf.splice(0, logBuf.length - LOG_BUFFER);
  lifeCounts[lv]++;
  pendingLines.push(logLine(e));
  const mark = lv === 'error' ? '✗' : lv === 'warn' ? '!' : '·';
  console.log(mark + ' ' + tsText(e.ts) + ' [' + e.kind + '] ' + (e.ip ? e.ip + ' ' : '') + e.msg);
}

/* 攒 1 秒批量写盘，避免每条日志一次 syscall；出错静默，不能因为日志把服务搞挂 */
function flushLog(sync) {
  if (!pendingLines.length) return;
  const chunk = pendingLines.join('\n') + '\n';
  pendingLines = [];
  try {
    if (sync) fs.appendFileSync(LOG_FILE, chunk);
    else fs.appendFile(LOG_FILE, chunk, () => { /* 磁盘满 / 权限问题忽略 */ });
  } catch (_) { /* ignore */ }
}
function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE).size > LOG_FILE_MAX) {
      try { fs.unlinkSync(LOG_FILE + '.1'); } catch (_) { /* 上一份可能不存在 */ }
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');     // 只留一份旧的，磁盘不会被日志吃满
    }
  } catch (_) { /* 文件还没生成 */ }
}
function logFileSize() {
  try { return fs.statSync(LOG_FILE).size; } catch (_) { return 0; }
}
setInterval(() => { flushLog(); rotateLog(); }, 1000).unref();
process.on('exit', () => flushLog(true));

/* ------------------------------------------------------------------ */
/* 9. 监控指标（每 10 秒采一个点，滚动保留最近 30 分钟）                 */
/* ------------------------------------------------------------------ */
const bootAt = Date.now();
const HIST_MAX = Math.max(30, envNum('METRIC_HISTORY', 180));
const metrics = {
  reqTotal: 0, ok2xx: 0, r3xx: 0, r4xx: 0, r5xx: 0,
  durSum: 0, durMax: 0,
  winReq: 0, winErr: 0, qps: 0,
  history: []
};

function touchRequest(status, ms) {
  metrics.reqTotal++;
  metrics.winReq++;
  metrics.durSum += ms;
  if (ms > metrics.durMax) metrics.durMax = ms;
  if (status >= 500) { metrics.r5xx++; metrics.winErr++; }
  else if (status >= 400) metrics.r4xx++;
  else if (status >= 300) metrics.r3xx++;
  else metrics.ok2xx++;
}

/* 事件循环延迟：定时器被阻塞多久，正常是个位数毫秒 */
let loopLag = 0;
setInterval(() => {
  const t = Date.now();
  setImmediate(() => { loopLag = Date.now() - t; });
}, 1000).unref();

let lastCpu = process.cpuUsage();
let lastSample = Date.now() - METRIC_INTERVAL * 1000;

function sampleMetrics() {
  const now = Date.now();
  const dt = Math.max(1, now - lastSample);
  const cu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  lastSample = now;

  const cores = Math.max(1, (os.cpus() || []).length);
  const cpu = Math.min(100, Math.round((cu.user + cu.system) / 1000 / dt / cores * 1000) / 10);
  const mem = process.memoryUsage();
  const totalMem = os.totalmem() || 1;
  const point = {
    t: now,
    cpu,
    rss: Math.round(mem.rss / 1048576),
    mem: Math.round((1 - os.freemem() / totalMem) * 1000) / 10,
    qps: Math.round(metrics.winReq / (dt / 1000) * 100) / 100,
    req: metrics.winReq,
    err: metrics.winErr,
    lag: loopLag
  };
  metrics.qps = point.qps;
  metrics.winReq = 0;
  metrics.winErr = 0;
  metrics.history.push(point);
  if (metrics.history.length > HIST_MAX) metrics.history.splice(0, metrics.history.length - HIST_MAX);
}
sampleMetrics();
setInterval(sampleMetrics, METRIC_INTERVAL * 1000).unref();

function diskInfo(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { total, free, used: total - free };
  } catch (_) { return null; }
}

let metricsCache = { at: 0, data: null };
function buildMetrics() {
  const now = Date.now();
  if (metricsCache.data && now - metricsCache.at < 3000) return metricsCache.data;

  const mem = process.memoryUsage();
  const totalMem = os.totalmem(), freeMem = os.freemem();
  const dbf = dbFileInfo();

  let tableCount = 0, tableRows = 0;
  try {
    const names = dbTables();
    tableCount = names.length;
    for (const n of names) { const m = dbTableMeta(n); if (m) tableRows += m.rows; }
  } catch (_) { /* 库忙时跳过 */ }

  const vids = localVideoRows();
  const last = metrics.history[metrics.history.length - 1] || { cpu: 0 };
  let host = '';
  try { host = os.hostname(); } catch (_) { /* ignore */ }

  const data = {
    now, bootAt, uptime: Math.floor((now - bootAt) / 1000),
    pid: process.pid, node: process.versions.node,
    platform: os.platform() + ' ' + os.release(), host,
    cpu: {
      cores: Math.max(1, (os.cpus() || []).length),
      load: os.loadavg().map(n => Math.round(n * 100) / 100),
      pct: last.cpu, lag: loopLag
    },
    mem: {
      total: totalMem, free: freeMem, used: totalMem - freeMem,
      pct: Math.round((1 - freeMem / (totalMem || 1)) * 1000) / 10,
      rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external
    },
    disk: { root: diskInfo(ROOT), data: diskInfo(DATA_DIR) },
    db: { file: dbf.file, size: dbf.size, wal: dbf.walSize, tables: tableCount, rows: tableRows, sqlite: dbf.sqlite },
    video: { count: vids.length, bytes: vids.reduce((s, v) => s + v.size, 0), dir: LOCAL_VIDEO_DIR || '' },
    req: {
      total: metrics.reqTotal, ok: metrics.ok2xx, r3xx: metrics.r3xx, r4xx: metrics.r4xx, r5xx: metrics.r5xx,
      avgMs: metrics.reqTotal ? Math.round(metrics.durSum / metrics.reqTotal) : 0,
      maxMs: metrics.durMax,
      qps: metrics.qps,
      lastMin: metrics.history.filter(p => now - p.t <= 60000).reduce((s, p) => s + p.req, 0)
    },
    logs: { info: lifeCounts.info, warn: lifeCounts.warn, error: lifeCounts.error, buffer: logBuf.length },
    interval: METRIC_INTERVAL,
    history: metrics.history
  };
  metricsCache = { at: now, data };
  return data;
}

/* ------------------------------------------------------------------ */
/* 9. HTTP 服务                                                        */
/* ------------------------------------------------------------------ */
const startedAt = Date.now();

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  res.on('error', () => { /* 客户端断开 */ });
  let u;
  try {
    u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    return fail(res, 400, '非法请求');
  }
  const method = req.method.toUpperCase();
  const urlPath = u.pathname;

  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (urlPath === '/healthz') return;
    touchRequest(res.statusCode, ms);
    if (!LOG_REQUESTS || LOG_SKIP.has(urlPath)) return;
    const lv = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log(method + ' ' + urlPath + ' ' + res.statusCode + ' ' + ms + 'ms', lv, 'request', clientIp(req));
  });

  try {
    /* 健康检查 */
    if (urlPath === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      return json(res, 200, {
        ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000),
        node: process.versions.node, time: Date.now()
      });
    }

    /* API */
    if (urlPath.startsWith('/api/')) return await handleApi(req, res, u);

    /* 管理后台：仅通过 ADMIN_PATH 访问，/admin.html 不对外 */
    if (urlPath === ADMIN_PATH || urlPath === ADMIN_PATH + '/') {
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, '方法不允许');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return sendFile(req, res, path.join(ROOT, 'admin.html'), { cache: 'no-store' });
    }

    /* 静态资源 */
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('405 Method Not Allowed');
    }
    if (denyStatic(urlPath)) return fail(res, 404, '未找到');

    let file, cache = 'no-cache';
    if (urlPath.startsWith('/uploads/')) {
      const rel = decodeURIComponent(urlPath.slice('/uploads'.length));
      const abs = path.resolve(UPLOAD_DIR, '.' + rel);
      if (abs !== UPLOAD_DIR && !abs.startsWith(UPLOAD_DIR + path.sep)) return fail(res, 404, '未找到');
      file = abs;
      cache = 'public, max-age=31536000, immutable';
    } else {
      let decoded;
      try { decoded = decodeURIComponent(urlPath); } catch (e) { return fail(res, 400, '非法路径'); }
      const abs = path.resolve(ROOT, '.' + (decoded === '/' ? '/index.html' : decoded));
      if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return fail(res, 404, '未找到');
      file = abs;
      if (abs.startsWith(path.join(ROOT, 'assets') + path.sep)) cache = 'public, max-age=3600';
    }

    if (!fs.existsSync(file)) {
      // 干净 URL：/about -> /about.html
      const alt = file + '.html';
      if (!path.extname(file) && fs.existsSync(alt)) file = alt;
      else {
        const nf = path.join(ROOT, '404.html');
        if (fs.existsSync(nf) && !urlPath.startsWith('/uploads/')) {
          res.statusCode = 404;
          return sendFile(req, res, nf, { cache: 'no-store' });
        }
        return fail(res, 404, '未找到');
      }
    }
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    sendFile(req, res, file, { cache });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[server]', e.stack || e.message);
    if (!res.headersSent) fail(res, status, status >= 500 ? '服务器内部错误' : e.message);
    else try { res.end(); } catch (err) { /* ignore */ }
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 1800000;   // 30 分钟：给大视频上传留足时间（局域网 4GB ≈ 3 分钟）
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  let lan = [];
  try {
    lan = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  } catch (_) { /* 部分沙箱环境下枚举网卡会报 errno 97，忽略即可 */ }
  console.log('');
  console.log('  ✦ 模糊二维码 · 博客后端已启动');
  console.log(`    监听          ${HOST}:${PORT}`);
  console.log(`    本机访问      http://127.0.0.1:${PORT}/`);
  if (lan.length) console.log(`    局域网访问    http://${lan[0]}:${PORT}/`);
  console.log(`    管理后台      http://127.0.0.1:${PORT}${ADMIN_PATH}   （已从首页移除入口）`);
  console.log(`    数据库        ${DB_FILE}`);
  console.log(`    图片目录      ${UPLOAD_DIR}`);
  console.log(`    日志文件      ${LOG_FILE}   （${LOG_FILE_MB} MB 轮转，内存保留 ${LOG_BUFFER} 条）`);
  console.log(`    监控采样      每 ${METRIC_INTERVAL} 秒一次，保留最近 ${HIST_MAX} 个点`);
  console.log(`    登录限速      ${LOGIN_MAX} 次 / 10 分钟，超限锁定 15 分钟`);
  log('服务启动 ' + HOST + ':' + PORT + '，Node ' + process.versions.node, 'info', 'system');
  if (generatedPassword) {
    console.log('');
    console.log('  ┌───────────────────────────────────────────────┐');
    console.log(`  │  已生成初始后台密码：${generatedPassword.padEnd(22)}│`);
    console.log(`  │  仅显示这一次，请立即保存！                    │`);
    console.log(`  │  已写入 ${path.relative(ROOT, ADMIN_HASH_FILE).padEnd(38)}│`);
    console.log('  └───────────────────────────────────────────────┘');
  }
  console.log('');
});

/* 优雅退出 */
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n[${sig}] 正在关闭服务…`);
  server.close(() => {
    try { db.close(); } catch (e) { /* ignore */ }
    console.log('[退出] 已安全关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

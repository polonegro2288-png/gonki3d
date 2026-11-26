// Сервер игры: статика + аккаунты и облачные сохранения (Postgres).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;        // Railway сам задаёт PORT
const ROOT = path.join(__dirname, 'public');
const DB_URL = process.env.DATABASE_URL;
const SECURE = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

const pool = DB_URL ? new Pool({ connectionString: DB_URL, max: 5 }) : null;

async function initDb() {
  if (!pool) { console.warn('DATABASE_URL не задан — аккаунты отключены'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      username_lc TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saves (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPass = (pw, salt) => new Promise((ok, no) =>
  crypto.scrypt(pw, salt, 64, (e, k) => e ? no(e) : ok(k.toString('hex'))));

function json(res, code, obj, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 100000) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > limit) { no(new Error('big')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch (e) { no(e); } });
    req.on('error', no);
  });
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const cookieStr = (v, maxAge) =>
  'sid=' + v + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + (SECURE ? '; Secure' : '');

async function userOf(req) {
  const t = cookie(req, 'sid');
  if (!t) return null;
  const r = await pool.query(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [sha(t)]);
  return r.rows[0] || null;
}
async function startSession(res, uid, user) {
  const tok = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3||' days')::interval)", [sha(tok), uid, String(SESSION_DAYS)]);
  pool.query('DELETE FROM sessions WHERE expires_at<now()').catch(() => {});
  json(res, 200, { user }, { 'Set-Cookie': cookieStr(tok, SESSION_DAYS * 86400) });
}

// простой лимит попыток входа по IP
const tries = new Map();
function limited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), a = (tries.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); tries.set(ip, a);
  if (tries.size > 5000) tries.clear();
  return a.length > 10;
}

async function api(req, res, p) {
  if (!pool) return json(res, 503, { error: 'Аккаунты временно недоступны' });
  try {
    if (p === '/api/me' && req.method === 'GET') {
      const u = await userOf(req);
      return json(res, 200, { user: u && { username: u.username } });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = cookie(req, 'sid');
      if (t) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha(t)]);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieStr('', 0) });
    }
    if ((p === '/api/register' || p === '/api/login') && req.method === 'POST') {
      if (limited(req)) return json(res, 429, { error: 'Слишком много попыток, подождите минуту' });
      const b = await readBody(req, 2000);
      const name = String(b.username || '').trim(), pw = String(b.password || '');
      if (p === '/api/register') {
        if (!/^[\p{L}\p{N}_.-]{3,20}$/u.test(name)) return json(res, 400, { error: 'Логин: 3–20 символов (буквы, цифры, _ . -)' });
        if (pw.length < 6 || pw.length > 100) return json(res, 400, { error: 'Пароль: минимум 6 символов' });
        const salt = crypto.randomBytes(16).toString('hex');
        const h = await hashPass(pw, salt);
        try {
          const r = await pool.query('INSERT INTO users(username,username_lc,pass_hash,salt) VALUES($1,$2,$3,$4) RETURNING id',
            [name, name.toLowerCase(), h, salt]);
          return startSession(res, r.rows[0].id, { username: name });
        } catch (e) {
          if (e.code === '23505') return json(res, 409, { error: 'Такой логин уже занят' });
          throw e;
        }
      }
      const r = await pool.query('SELECT id, username, pass_hash, salt FROM users WHERE username_lc=$1', [name.toLowerCase()]);
      const u = r.rows[0];
      const h = await hashPass(pw, u ? u.salt : 'x'.repeat(32));
      if (!u || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.pass_hash)))
        return json(res, 401, { error: 'Неверный логин или пароль' });
      return startSession(res, u.id, { username: u.username });
    }
    if (p === '/api/save') {
      const u = await userOf(req);
      if (!u) return json(res, 401, { error: 'Нужен вход' });
      if (req.method === 'GET') {
        const r = await pool.query('SELECT data FROM saves WHERE user_id=$1', [u.id]);
        return json(res, 200, { save: r.rows[0] ? r.rows[0].data : null });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const d = b.save;
        if (!d || typeof d !== 'object' || Array.isArray(d)) return json(res, 400, { error: 'Некорректное сохранение' });
        await pool.query(
          `INSERT INTO saves(user_id,data) VALUES($1,$2)
           ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [u.id, JSON.stringify(d)]);
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Ошибка сервера' });
  }
}

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.startsWith('/api/')) return api(req, res, p);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    if (/gzip/.test(req.headers['accept-encoding'] || '') && /text|javascript|json|svg/.test(type)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      return res.end(zlib.gzipSync(data));
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log('Игра запущена: http://localhost:' + PORT));

initDb().catch(e => console.error('Ошибка БД:', e.message));

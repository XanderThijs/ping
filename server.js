// Ping: checks apps, disk and backups every minute, keeps an incident log and sends phone alerts through ntfy.
// No dependencies. Settings come from environment variables (see README.md).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DATA = env.DATA_DIR || '/data';
const BACKUP_DIR = env.BACKUP_DIR || '/backups';
const EVERY = Number(env.INTERVAL_MS) || 60_000;
const FAILS = Number(env.FAILS_BEFORE_ALERT) || 2;          // consecutive failed checks before a service counts as down
const DISK_ALERT = Number(env.DISK_ALERT_PERCENT) || 85;
const BACKUP_MAX_HOURS = Number(env.BACKUP_MAX_HOURS) || 26;
const PASSWORD = env.PING_PASSWORD || '';
const NTFY_URL = env.NTFY_URL || '';                        // e.g. https://ntfy.sh/your-private-topic
const DAYS = 60;
const TARGETS = JSON.parse(env.TARGETS || '[]');            // [{name, url, path, note}]
const FILE = path.join(DATA, 'ping.json');

// ---------- state ----------
let db = { history: {}, incidents: [], cond: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
const live = {};          // service name -> {up, ms, at, err}
let disk = null, backups = { volumes: [], error: null }, checkedAt = null;
const verified = new Map(); // "file:size:mtime" -> true/false (archive integrity)

const day = (d = new Date()) => d.toISOString().slice(0, 10);
function save() {
  const keep = new Set(Array.from({ length: DAYS }, (_, i) => day(new Date(Date.now() - i * 864e5))));
  for (const n of Object.keys(db.history)) for (const d of Object.keys(db.history[n])) if (!keep.has(d)) delete db.history[n][d];
  db.incidents = db.incidents.slice(-50);
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); }
  catch (e) { console.error('save failed:', e.message); }
}

// ---------- alerts ----------
async function notify(title, message, { priority = 3, tags = '' } = {}) {
  console.log(`[alert] ${title}: ${message}`);
  if (!NTFY_URL) return false;
  try {
    const r = await fetch(NTFY_URL, { method: 'POST', body: message, signal: AbortSignal.timeout(8000),
      headers: { Title: title, Priority: String(priority), ...(tags ? { Tags: tags } : {}) } });
    return r.ok;
  } catch (e) { console.error('ntfy failed:', e.message); return false; }
}
const mins = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 90 ? m + ' minute' + (m === 1 ? '' : 's') : m < 2880 ? Math.round(m / 60) + ' hours' : Math.round(m / 1440) + ' days'; };

// A condition is something that can be bad (a service down, the disk full, a backup missing).
// When it turns bad Ping opens an incident and alerts; when it recovers it closes the incident and alerts again.
async function setCondition(key, bad, what, detail, recoveredText) {
  const c = (db.cond[key] ||= { bad: false, since: null });
  if (bad && !c.bad) {
    c.bad = true; c.since = Date.now();
    db.incidents.push({ id: crypto.randomUUID().slice(0, 8), key, what, start: c.since, end: null });
    await notify(what, detail, { priority: 4, tags: 'warning' });
  } else if (!bad && c.bad) {
    const inc = [...db.incidents].reverse().find(i => i.key === key && !i.end);
    const end = Date.now(); if (inc) inc.end = end;
    const took = mins(end - c.since); c.bad = false; c.since = null;
    await notify(recoveredText, `Recovered after ${took}.`, { priority: 3, tags: 'white_check_mark' });
  }
}

// ---------- checks ----------
async function checkService(t) {
  const t0 = Date.now();
  let up = false, err = '';
  try {
    const r = await fetch(t.url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'ping-monitor' } });
    await r.arrayBuffer(); up = r.status < 500; if (!up) err = 'HTTP ' + r.status;
  } catch (e) { err = e.name === 'TimeoutError' ? 'timeout' : 'no connection'; }
  const ms = Date.now() - t0;
  const h = ((db.history[t.name] ||= {})[day()] ||= { n: 0, ok: 0, ms: 0 }); h.n++; if (up) { h.ok++; h.ms += ms; }
  const c = (db.cond['svc:' + t.name] ||= { bad: false, since: null });
  c.fails = up ? 0 : (c.fails || 0) + 1;
  live[t.name] = { up, ms, at: new Date().toISOString(), err };
  const down = c.fails >= FAILS || (c.bad && !up);
  const dur = c.since ? mins(Date.now() - c.since) : mins(c.fails * EVERY);
  await setCondition('svc:' + t.name, down, t.name + ' is down', `No response from ${t.path || t.url} for ${dur} (${err || 'unknown error'}).`, t.name + ' is back');
}

function checkDisk() {
  try {
    const s = fs.statfsSync(BACKUP_DIR), total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    disk = { usedPercent: Math.round((1 - free / total) * 100), freeGB: Math.round(free / 1e9 * 10) / 10, totalGB: Math.round(total / 1e9 * 10) / 10, alertAt: DISK_ALERT };
  } catch { disk = null; }
  return disk;
}

async function archiveOk(file, size, mtime) {
  const k = `${file}:${size}:${mtime}`;
  if (verified.has(k)) return verified.get(k);
  let ok = false;
  try { await pipeline(fs.createReadStream(file), zlib.createGunzip(), async function (src) { for await (const _ of src) { /* read to the end */ } }); ok = size > 0; } catch { ok = false; }
  verified.clear(); verified.set(k, ok); return ok;
}
async function checkBackups() {
  let names;
  try { names = fs.readdirSync(BACKUP_DIR).filter(n => /\.tar\.gz$/.test(n)); } catch (e) { backups = { volumes: [], error: 'Backup folder not readable' }; return; }
  const by = {};
  for (const n of names) {
    const vol = n.replace(/-\d{8}-\d{6}\.tar\.gz$/, '').replace(/\.tar\.gz$/, '');
    const st = fs.statSync(path.join(BACKUP_DIR, n)); (by[vol] ||= []).push({ file: n, size: st.size, mtime: st.mtimeMs });
  }
  const volumes = [];
  for (const [vol, list] of Object.entries(by)) {
    list.sort((a, b) => b.mtime - a.mtime); const l = list[0];
    const ok = await archiveOk(path.join(BACKUP_DIR, l.file), l.size, l.mtime);
    volumes.push({ name: vol, kept: list.length, latest: { file: l.file, at: new Date(l.mtime).toISOString(), size: l.size, ok } });
  }
  backups = { volumes, error: names.length ? null : 'No backups found' };
  if (!volumes.length) await setCondition('backup:none', true, 'Backup missing', 'No backups found in the backup folder.', 'Backups found again');
  else await setCondition('backup:none', false, '', '', 'Backups found again');
  for (const v of volumes) {
    const age = Date.now() - new Date(v.latest.at), stale = age > BACKUP_MAX_HOURS * 3600e3, broken = !v.latest.ok;
    await setCondition('backup:' + v.name, stale || broken, 'Backup missing',
      broken ? `The latest backup of ${v.name} is empty or unreadable.` : `No new backup of ${v.name} in ${mins(age)}. The latest is from ${new Date(v.latest.at).toLocaleString('en-GB')}.`, 'Backup is fresh again');
  }
}

async function round() {
  await Promise.all(TARGETS.map(t => checkService(t).catch(e => console.error('check failed', t.name, e.message))));
  const d = checkDisk();
  if (d) await setCondition('disk', d.usedPercent >= DISK_ALERT, `Disk above ${DISK_ALERT}%`, `The disk is ${d.usedPercent}% full (${d.freeGB} GB free).`, 'Disk is fine again');
  await checkBackups().catch(e => console.error('backup check failed', e.message));
  checkedAt = new Date().toISOString();
  save();
}

// ---------- API ----------
function services() {
  return TARGETS.map(t => {
    const h = db.history[t.name] || {}, days = []; let n = 0, ok = 0, ms = 0;
    for (let i = DAYS - 1; i >= 0; i--) { const x = h[day(new Date(Date.now() - i * 864e5))]; if (!x) { days.push(null); continue; } n += x.n; ok += x.ok; ms += x.ms; days.push(Math.round(x.ok / x.n * 10000) / 100); }
    const l = live[t.name] || {};
    return { name: t.name, path: t.path || '', note: t.note || '', up: l.up ?? null, ms: l.up ? l.ms : null, err: l.err || '',
             uptime: n ? Math.round(ok / n * 10000) / 100 : null, avgMs: ok ? Math.round(ms / ok) : null, days };
  });
}
const publicView = () => ({ checked: checkedAt, apps: services().map(a => ({ name: a.name, note: a.note, up: a.up, ms: a.ms, uptime: a.uptime, days: a.days })) });
function privateView() {
  const sv = services(), bad = sv.filter(s => s.up === false).length, badOther = Object.entries(db.cond).filter(([k, c]) => c.bad && !k.startsWith('svc:')).length;
  const maskedTopic = NTFY_URL ? NTFY_URL.split('/').pop().replace(/.(?=.{3})/g, '•').slice(0, 24) : '';
  return { checked: checkedAt, services: sv, disk, backups: { ...backups, maxHours: BACKUP_MAX_HOURS }, problems: bad + badOther,
    incidents: [...db.incidents].reverse().slice(0, 20), alerts: { configured: !!NTFY_URL, topic: maskedTopic, failsBeforeAlert: FAILS, diskAlert: DISK_ALERT } };
}

// ---------- HTTP ----------
const failures = new Map();   // ip -> [timestamps]
function authOk(req, res) {
  if (!PASSWORD) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('The dashboard is disabled until PING_PASSWORD is set.'); return false; }
  const ip = req.socket.remoteAddress || '?', now = Date.now(), recent = (failures.get(ip) || []).filter(t => now - t < 60_000);
  if (recent.length >= 5) { res.writeHead(429, { 'retry-after': '60' }); res.end('Too many attempts. Wait a minute.'); return false; }
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  const given = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (m && crypto.timingSafeEqual(a, b)) return true;
  if (m) { recent.push(now); failures.set(ip, recent); }
  res.writeHead(401, { 'www-authenticate': 'Basic realm="Ping", charset="UTF-8"' }); res.end('Sign in to see the dashboard.'); return false;
}
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/healthz') { res.end('ok'); return; }
    if (url === '/status.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...SEC }); res.end(JSON.stringify(publicView())); return; }
    if (!authOk(req, res)) return;
    if (url === '/api/state') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SEC }); res.end(JSON.stringify(privateView())); return; }
    if (url === '/api/test' && req.method === 'POST') {
      const ok = await notify('Test alert from Ping', 'If you can read this, alerts reach your phone.', { tags: 'bell' });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sent: ok, configured: !!NTFY_URL })); return;
    }
    const f = url === '/' ? 'index.html' : url.slice(1);
    if (/[^\w.\-]/.test(f) || !TYPES[path.extname(f)]) { res.writeHead(404); res.end('Not found'); return; }
    const body = fs.readFileSync(path.join(PUB, f));
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)], 'cache-control': 'no-cache', ...SEC }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(PORT, () => console.log(`Ping listening on :${PORT}, checking ${TARGETS.length} target(s) every ${EVERY / 1000}s`));
round().catch(e => console.error(e)); setInterval(() => round().catch(e => console.error(e)), EVERY);
process.on('SIGTERM', () => { save(); process.exit(0); });

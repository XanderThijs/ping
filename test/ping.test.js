'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const listen = h => new Promise(r => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
const wait = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };
const auth = p => ({ authorization: 'Basic ' + Buffer.from('x:' + p).toString('base64') });

let target, ntfy, proc, proc2, base, base2, targetUp = true, posts = [], tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ping-'));
  const bk = path.join(tmp, 'backups'); fs.mkdirSync(bk);
  const good = zlib.gzipSync(Buffer.from('hello backup'));
  fs.writeFileSync(path.join(bk, 'app_data-20261001-030000.tar.gz'), good);                       // fresh and valid
  fs.writeFileSync(path.join(bk, 'old_data-20260101-030000.tar.gz'), good);                       // stale
  fs.utimesSync(path.join(bk, 'old_data-20260101-030000.tar.gz'), new Date(Date.now() - 3 * 864e5), new Date(Date.now() - 3 * 864e5));
  fs.writeFileSync(path.join(bk, 'bad_data-20261001-030000.tar.gz'), Buffer.from('not a gzip file'));  // corrupt
  target = await listen((q, s) => { s.statusCode = targetUp ? 200 : 503; s.end('x'); });
  ntfy = await listen((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { posts.push({ title: q.headers.title, body: b }); s.end('ok'); }); });
  const common = { INTERVAL_MS: '150', FAILS_BEFORE_ALERT: '2', BACKUP_MAX_HOURS: '26', PATH: process.env.PATH,
    TARGETS: JSON.stringify([{ name: 'Target', url: `http://127.0.0.1:${target.address().port}/`, path: '/target/' }]) };
  const start = (port, extra) => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...common, PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(tmp, 'd')), BACKUP_DIR: bk, ...extra }, stdio: 'ignore' });
  const free = await listen(() => {}); const p1 = free.address().port; free.close();
  const free2 = await listen(() => {}); const p2 = free2.address().port; free2.close();
  proc = start(p1, { PING_PASSWORD: 'secret', NTFY_URL: `http://127.0.0.1:${ntfy.address().port}/topic`, DISK_ALERT_PERCENT: '1' });
  proc2 = start(p2, {});
  base = `http://127.0.0.1:${p1}`; base2 = `http://127.0.0.1:${p2}`;
  await wait(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } });
  await wait(async () => { try { return (await fetch(base2 + '/healthz')).ok; } catch { return false; } });
});
after(async () => {
  const done = p => new Promise(r => { p.once('exit', r); p.kill(); });
  await Promise.all([done(proc), done(proc2)]); target.close(); ntfy.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('the public status needs no password and hides the details', async () => {
  const r = await fetch(base + '/status.json'); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.apps[0].name, 'Target'); assert.ok(!('incidents' in j) && !('disk' in j));
});

test('the dashboard asks for the password', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: auth('wrong') })).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: auth('secret') })).status, 200);
  assert.equal((await fetch(base + '/', { headers: auth('secret') })).status, 200);
});

test('the dashboard is disabled when no password is set', async () => {
  assert.equal((await fetch(base2 + '/api/state')).status, 403);
  assert.equal((await fetch(base2 + '/status.json')).status, 200);
});

test('a service that stops answering raises one alert, and a recovery alert follows', async () => {
  await wait(() => posts.length >= 0);
  targetUp = false;
  await wait(() => posts.some(p => p.title === 'Target is down'));
  await new Promise(r => setTimeout(r, 700));
  assert.equal(posts.filter(p => p.title === 'Target is down').length, 1, 'only one down alert, not one per check');
  targetUp = true;
  await wait(() => posts.some(p => p.title === 'Target is back'));
  const state = await (await fetch(base + '/api/state', { headers: auth('secret') })).json();
  const inc = state.incidents.find(i => i.what === 'Target is down'); assert.ok(inc && inc.end, 'the incident is closed');
});

test('old and corrupt backups raise alerts, a fresh one does not', async () => {
  await wait(() => posts.filter(p => p.title === 'Backup missing').length >= 2);
  const bodies = posts.filter(p => p.title === 'Backup missing').map(p => p.body).join('\n');
  assert.match(bodies, /old_data/); assert.match(bodies, /bad_data/); assert.doesNotMatch(bodies, /app_data/);
  const s = await (await fetch(base + '/api/state', { headers: auth('secret') })).json();
  assert.equal(s.backups.volumes.length, 3);
  assert.equal(s.backups.volumes.find(v => v.name === 'app_data').latest.ok, true);
  assert.equal(s.backups.volumes.find(v => v.name === 'bad_data').latest.ok, false);
});

test('the disk alert fires above the limit', async () => {
  await wait(() => posts.some(p => /^Disk above/.test(p.title)));
});

test('a test alert reaches the phone', async () => {
  const before = posts.length;
  const r = await (await fetch(base + '/api/test', { method: 'POST', headers: auth('secret') })).json();
  assert.equal(r.sent, true); assert.ok(posts.length > before);
});

test('failed logins are limited', async () => {
  let last; for (let i = 0; i < 8; i++) last = (await fetch(base + '/api/state', { headers: auth('nope' + i) })).status;
  assert.equal(last, 429);
});

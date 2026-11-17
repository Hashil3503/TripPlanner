'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { computeAppVersion } = require('../server/version');

const ROOT = path.join(__dirname, '..');
let tmp;
const servers = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
  s.on('error', reject);
});

/** 임시 DB로 서버를 띄우고 호출 헬퍼를 돌려준다 */
async function startServer(dbPath) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { TP_PORT: String(port), TP_DB_PATH: dbPath }), stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(child);
  await new Promise((resolve, reject) => {
    child.once('exit', (c) => reject(new Error(`server exited ${c}`)));
    child.stdout.on('data', (d) => { if (String(d).includes('실행 중')) resolve(); });
  });
  const call = async (method, url, body, cookie, headers) => {
    const h = Object.assign({ 'Content-Type': 'application/json', Origin: base }, headers || {});
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    const sc = res.headers.get('set-cookie');
    return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null, setCookie: sc, headers: res.headers };
  };
  return { call, child, base };
}

async function stopServer(child) {
  child.stopped = true;
  const closed = new Promise((r) => child.once('close', r));
  child.kill();
  await closed;
}

const trip = (name) => ({ name, startDate: '', days: [{ id: 'd1', startTime: '09:00', items: [] }] });

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-ver-'));
});

test.after(async () => {
  for (const child of servers) if (!child.stopped) await stopServer(child);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('computeAppVersion: 내용/이름이 같으면 같은 해시, 바뀌면 다른 해시', () => {
  const dir = path.join(tmp, 'app1');
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'index');
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'js', 'b.js'), 'b');
  const v1 = computeAppVersion(dir);
  assert.match(v1, /^[0-9a-f]{12}$/);
  assert.strictEqual(computeAppVersion(dir), v1, '같은 내용이면 결정적이다');

  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'a changed');
  const v2 = computeAppVersion(dir);
  assert.notStrictEqual(v2, v1, '파일 내용이 바뀌면 달라진다');

  fs.renameSync(path.join(dir, 'js', 'b.js'), path.join(dir, 'js', 'c.js'));
  const v3 = computeAppVersion(dir);
  assert.notStrictEqual(v3, v2, '파일 이름이 바뀌면 달라진다');
});

test('computeAppVersion: 점 파일/점 폴더는 무시한다', () => {
  const dir = path.join(tmp, 'app2');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), 'a');
  const before = computeAppVersion(dir);
  fs.writeFileSync(path.join(dir, '.hidden'), 'x');
  fs.writeFileSync(path.join(dir, '.git', 'x'), 'y');
  assert.strictEqual(computeAppVersion(dir), before);
});

test('서버: /api/version, config.js, 응답 헤더, 저장 버전 게이트', async () => {
  const { call, base } = await startServer(path.join(tmp, 'ver.db'));

  const ver = await call('GET', '/api/version');
  assert.strictEqual(ver.status, 200);
  assert.match(ver.data.version, /^[0-9a-f]{12}$/);
  const V = ver.data.version;
  assert.strictEqual(ver.headers.get('x-app-version'), V);
  assert.strictEqual((await call('HEAD', '/api/version')).status, 200);

  const cfgRes = await fetch(`${base}/config.js`);
  const cfg = await cfgRes.text();
  assert.match(cfg, new RegExp(`"appVersion":"${V}"`));

  const su = await call('POST', '/api/signup', { username: 'erin', password: 'secret-pass-1' });
  assert.strictEqual(su.status, 201);
  const C = su.cookie;
  const body = { trip: trip('제주') };

  const bad = await call('PUT', '/api/trips/t1', body, C, { 'X-App-Version': 'wrong' });
  assert.strictEqual(bad.status, 412);
  assert.strictEqual(bad.data.outdated, true);
  assert.strictEqual(bad.data.version, V);

  assert.strictEqual((await call('PUT', '/api/trips/t1', body, C, { 'X-App-Version': V })).status, 200);
  assert.strictEqual((await call('PUT', '/api/trips/t1', body, C)).status, 200, '헤더 없는 옛 클라이언트는 허용');

  const badSettings = await call('PUT', '/api/settings', { settings: {} }, C, { 'X-App-Version': 'wrong' });
  assert.strictEqual(badSettings.status, 412);
  assert.strictEqual(badSettings.data.outdated, true);
  assert.strictEqual((await call('PUT', '/api/settings', { settings: {} }, C, { 'X-App-Version': V })).status, 200);

  assert.strictEqual((await call('PUT', '/api/trips/t1', body, null, { 'X-App-Version': 'wrong' })).status, 401, '세션이 없으면 401');
});

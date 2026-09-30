const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
let tmp, port, child, base, dbPath;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
  s.on('error', reject);
});

function env() {
  return Object.assign({}, process.env, { TP_PORT: String(port), TP_DB_PATH: dbPath });
}

async function call(method, url, body, cookie) {
  const headers = { 'Content-Type': 'application/json', Origin: base };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-pw-'));
  dbPath = path.join(tmp, 'test.db');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.once('exit', (c) => reject(new Error(`server exited ${c}`)));
    child.stdout.on('data', (d) => { if (String(d).includes('실행 중')) resolve(); });
  });
});

test.after(async () => {
  if (child) {
    const closed = new Promise((r) => child.once('close', r));
    child.kill();
    await closed;
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('비밀번호 변경: 전체 흐름', async () => {
  const OLD = 'old-password-1';
  const NEW = 'new-password-2';

  const su = await call('POST', '/api/signup', { username: 'Alice', password: OLD });
  assert.strictEqual(su.status, 201);
  const A = su.cookie; // 세션 A (현재)
  const lg = await call('POST', '/api/login', { username: 'alice', password: OLD });
  assert.strictEqual(lg.status, 200);
  const B = lg.cookie; // 세션 B (다른 기기)

  // 로그인 안 하면 거부
  assert.strictEqual((await call('PUT', '/api/password', { currentPassword: OLD, newPassword: NEW })).status, 401);

  // 현재 비밀번호 틀림: 401 + 일반 메시지, 아무것도 안 바뀜
  const wrong = await call('PUT', '/api/password', { currentPassword: 'wrong-password', newPassword: NEW }, A);
  assert.strictEqual(wrong.status, 401);
  assert.match(wrong.data.error, /현재 비밀번호/);
  assert.strictEqual((await call('POST', '/api/login', { username: 'alice', password: OLD })).status, 200);

  // 너무 짧은 새 비밀번호 / 타입 오류
  assert.strictEqual((await call('PUT', '/api/password', { currentPassword: OLD, newPassword: 'short' }, A)).status, 400);
  assert.strictEqual((await call('PUT', '/api/password', { currentPassword: OLD, newPassword: 12345678 }, A)).status, 400);
  assert.strictEqual((await call('PUT', '/api/password', { currentPassword: OLD, newPassword: 'x'.repeat(73) }, A)).status, 400);

  // 성공
  const ok = await call('PUT', '/api/password', { currentPassword: OLD, newPassword: NEW }, A);
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.data, { ok: true });

  assert.strictEqual((await call('POST', '/api/login', { username: 'alice', password: OLD })).status, 401);
  assert.strictEqual((await call('POST', '/api/login', { username: 'alice', password: NEW })).status, 200);
  assert.strictEqual((await call('GET', '/api/me', undefined, A)).status, 200); // 현재 세션 유지
  assert.strictEqual((await call('GET', '/api/me', undefined, B)).status, 401); // 다른 세션 무효화
});

test('비밀번호 변경: 실패 횟수 제한(429)', async () => {
  const su = await call('POST', '/api/signup', { username: 'bob_1', password: 'bob-password-1' });
  for (let i = 0; i < 10; i++) {
    assert.strictEqual((await call('PUT', '/api/password', { currentPassword: 'nope-nope-nope', newPassword: 'new-password-2' }, su.cookie)).status, 401);
  }
  assert.strictEqual((await call('PUT', '/api/password', { currentPassword: 'bob-password-1', newPassword: 'new-password-2' }, su.cookie)).status, 429);
});

test('reset-password CLI: 인자 없음 / 비TTY 거부', () => {
  const run = (args) => spawnSync(process.execPath, ['scripts/reset-password.js', ...args], { cwd: ROOT, env: env(), input: 'new-password-3\nnew-password-3\n', encoding: 'utf8' });
  const noArg = run([]);
  assert.notStrictEqual(noArg.status, 0);
  assert.match(noArg.stderr, /사용법/);
  const piped = run(['alice']);
  assert.notStrictEqual(piped.status, 0);
  assert.match(piped.stderr, /터미널/);
  assert.ok(!(piped.stdout + piped.stderr).includes('new-password-3'));
});

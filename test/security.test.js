'use strict';
// server.js 의 보안 응답(Origin/Host 403, 본문 1MB 413, Content-Type 415)과
// server/static.js 의 경로 이탈 차단을 실제로 띄운 서버에 HTTP 로 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const BODY_LIMIT = 1024 * 1024; // server.js 의 BODY_LIMIT
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

/** 임시 DB로 서버를 띄우고 호출 헬퍼를 돌려준다 (test/account.test.js 와 같은 방식) */
async function startServer(dbPath) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { TP_PORT: String(port), TP_DB_PATH: dbPath }), stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(child);
  await new Promise((resolve, reject) => {
    child.once('exit', (c) => reject(new Error(`server exited ${c}`)));
    child.stdout.on('data', (d) => { if (String(d).includes('실행 중')) resolve(); });
  });

  /** 기본 헤더(정상 Origin + JSON)에 덮어쓸 헤더를 더해 요청한다. 본문은 문자열 그대로 보낸다 */
  const call = async (method, url, body, headers) => {
    const h = Object.assign({ 'Content-Type': 'application/json', Origin: base }, headers || {});
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    const sc = res.headers.get('set-cookie');
    return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null, headers: res.headers };
  };

  /** fetch 는 Host/Content-Length 를 마음대로 바꾸므로, 그런 요청은 http.request 로 직접 보낸다 */
  const raw = (method, urlPath, options) => new Promise((resolve, reject) => {
    const o = options || {};
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: o.headers || {} }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(o.body === undefined ? undefined : o.body);
  });

  return { call, raw, base };
}

async function stopServer(child) {
  child.stopped = true;
  const closed = new Promise((r) => child.once('close', r));
  child.kill();
  await closed;
}

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sec-'));
});

test.after(async () => {
  for (const child of servers) if (!child.stopped) await stopServer(child);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('Origin / Host 허용 목록: 상태 변경 API 는 403', async () => {
  const { call, raw, base } = await startServer(path.join(tmp, 'origin.db'));
  const su = await call('POST', '/api/signup', { username: 'secuser', password: 'secret-pass-1' });
  assert.strictEqual(su.status, 201);

  // Origin 이 허용 목록 밖이면 상태 변경 요청 거부 (다른 사이트의 CSRF)
  for (const origin of ['http://evil.example', 'http://127.0.0.1:1', 'null']) {
    const r = await call('PUT', '/api/trips/t1', { trip: { name: 'x', days: [{ items: [] }] } }, { Origin: origin });
    assert.strictEqual(r.status, 403, origin);
    assert.strictEqual(typeof r.data.error, 'string');
  }
  // 거부됐으므로 여행이 저장되지 않았다 (로그인은 정상 세션으로)
  const list = await call('GET', '/api/trips', undefined, { Cookie: su.cookie });
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.data.trips, []);

  // Host 헤더(DNS 리바인딩)가 허용 목록 밖이면 403. 정적 파일에도 적용된다
  const badHost = await raw('POST', '/api/login', { headers: { Host: 'evil.example', 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'secuser', password: 'secret-pass-1' }) });
  assert.strictEqual(badHost.status, 403);
  const badHostStatic = await raw('GET', '/index.html', { headers: { Host: 'evil.example' } });
  assert.strictEqual(badHostStatic.status, 403);

  // 허용된 Host/Origin 은 통과 (로그인까지 간다: 비밀번호가 틀리면 401)
  const okHost = await raw('POST', '/api/login', { headers: { Host: `127.0.0.1:${new URL(base).port}`, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'secuser', password: 'wrong-password' }) });
  assert.strictEqual(okHost.status, 401);
});

test('JSON API 의 Content-Type 이 아니면 415', async () => {
  const { call } = await startServer(path.join(tmp, 'ctype.db'));
  const body = JSON.stringify({ username: 'secuser', password: 'secret-pass-1' });
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/json-patch+json', '']) {
    const r = await call('POST', '/api/login', body, { 'Content-Type': type });
    assert.strictEqual(r.status, 415, `Content-Type: ${type}`);
    assert.strictEqual(typeof r.data.error, 'string');
  }
  // 대소문자/파라미터가 붙어도 application/json 이면 통과 (없는 계정이라 401)
  for (const type of ['Application/JSON', 'application/json; charset=utf-8']) {
    const r = await call('POST', '/api/login', body, { 'Content-Type': type });
    assert.strictEqual(r.status, 401, `Content-Type: ${type}`);
  }
});

test('요청 본문이 1MB 를 넘으면 413 (Content-Length 든 chunked 든)', async () => {
  const { call, raw, base } = await startServer(path.join(tmp, 'body.db'));

  // 정확히 1MB 는 통과(한도 초과가 아니므로 본문을 끝까지 읽는다), 1바이트만 넘으면 413
  const head = '{"pad":"';
  const tail = '"}';
  const okBody = head + 'x'.repeat(BODY_LIMIT - head.length - tail.length) + tail;
  assert.strictEqual(Buffer.byteLength(okBody), BODY_LIMIT);
  const over = okBody + ' '; // 1바이트 더 (여전히 올바른 JSON)
  assert.strictEqual(Buffer.byteLength(over), BODY_LIMIT + 1);

  const atLimit = await call('POST', '/api/login', okBody);
  assert.strictEqual(atLimit.status, 401, 'Content-Length 가 한도면 본문을 그대로 읽어 로그인 처리까지 간다');
  // 거절됐으므로 로그인 실패 횟수도 오르지 않는다 (레이트 리미터 미적용)
  const aboveLimit = await call('POST', '/api/login', over);
  assert.strictEqual(aboveLimit.status, 413);
  assert.strictEqual(aboveLimit.headers.get('connection'), 'close');
  assert.strictEqual(typeof aboveLimit.data.error, 'string');

  // Content-Length 없이 chunked 로 보내도 읽는 도중 한도를 넘으면 413
  const chunked = await raw('POST', '/api/login', {
    headers: { Host: `127.0.0.1:${new URL(base).port}`, Origin: base, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    body: over,
  });
  assert.strictEqual(chunked.status, 413);
});

test('정적 파일 경로 이탈(../, %2e%2e%2f, 역슬래시, 인코딩 오류)은 public 밖을 내주지 않는다', async () => {
  const { raw, call } = await startServer(path.join(tmp, 'static.db'));
  const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');

  // 정상 파일은 그대로 준다 (비교 기준)
  const index = await raw('GET', '/index.html');
  assert.strictEqual(index.status, 200);
  const pkgUrl = await raw('GET', '/package.json');
  assert.strictEqual(pkgUrl.status, 404, 'public 밖의 파일은 원래 없다');

  const attempts = [
    '/../package.json',
    '/../../package.json',
    '/js/../../package.json',
    '/%2e%2e/package.json',
    '/%2e%2e%2fpackage.json',
    '/js%2f..%2f..%2fpackage.json',
    '/..%5cpackage.json',
    '/%2e%2e%5cserver.js',
    '/%2e%2e%2fserver.js',
    '/..%2fdata%2ftripplanner.db',
    '/.%2e/package.json',
    '/%00index.html',
    '/%E0%A4%A', // 잘못된 percent-encoding
    '/js/..',
  ];
  for (const p of attempts) {
    const r = await raw('GET', p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.text.includes(pkg.split('\n')[0]), `${p} 가 package.json 을 내줬다`);
  }

  // '.' 으로 시작하는 파일/폴더와 디렉터리 목록도 없다
  assert.strictEqual((await raw('GET', '/.git/config')).status, 404);
  assert.strictEqual((await raw('GET', '/js/')).status, 404);
  assert.strictEqual((await raw('GET', '/')).status, 200); // 루트는 index.html

  // 경로 이탈 응답은 JSON API 로도 새지 않는다 (정적 처리 경로는 /api 밖)
  assert.strictEqual((await call('GET', '/api/..%2f..%2fpackage.json')).status, 404);
});

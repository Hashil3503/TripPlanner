const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

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
  const call = async (method, url, body, cookie) => {
    const headers = { 'Content-Type': 'application/json', Origin: base };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    const sc = res.headers.get('set-cookie');
    return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null, setCookie: sc };
  };
  return { call, child };
}

async function stopServer(child) {
  child.stopped = true;
  const closed = new Promise((r) => child.once('close', r));
  child.kill();
  await closed;
}

const trip = (name) => ({ name, startDate: '', days: [{ id: 'd1', startTime: '09:00', items: [] }] });

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acct-'));
});

test.after(async () => {
  for (const child of servers) if (!child.stopped) await stopServer(child);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('회원 탈퇴: 계정과 여행이 지워진다', async () => {
  const { call } = await startServer(path.join(tmp, 'del.db'));
  const PW = 'secret-pass-1';
  const su = await call('POST', '/api/signup', { username: 'Bob', password: PW });
  assert.strictEqual(su.status, 201);
  const C = su.cookie;
  assert.strictEqual((await call('PUT', '/api/trips/t1', { trip: trip('제주') }, C)).status, 200);

  // 로그인 없이 / 비밀번호 틀림
  assert.strictEqual((await call('DELETE', '/api/me', { password: PW })).status, 401);
  const wrong = await call('DELETE', '/api/me', { password: 'wrong-password' }, C);
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual((await call('GET', '/api/me', undefined, C)).status, 200); // 아직 계정이 살아 있다

  const ok = await call('DELETE', '/api/me', { password: PW }, C);
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.data, { ok: true });
  assert.match(ok.setCookie, /Max-Age=0|Expires=/i); // 쿠키 삭제

  assert.strictEqual((await call('GET', '/api/me', undefined, C)).status, 401);
  assert.strictEqual((await call('POST', '/api/login', { username: 'bob', password: PW })).status, 401);

  // 같은 아이디로 다시 가입: 이전 여행은 남아 있지 않다
  const again = await call('POST', '/api/signup', { username: 'Bob', password: PW });
  assert.strictEqual(again.status, 201);
  const list = await call('GET', '/api/trips', undefined, again.cookie);
  assert.deepStrictEqual(list.data.trips, []);
});

test('여행 리비전: 낙관적 잠금', async () => {
  const { call } = await startServer(path.join(tmp, 'rev.db'));
  const su = await call('POST', '/api/signup', { username: 'carol', password: 'secret-pass-1' });
  const C = su.cookie;
  const put = (id, name, baseRev) => call('PUT', `/api/trips/${id}`, baseRev === undefined ? { trip: trip(name) } : { trip: trip(name), baseRev }, C);

  const created = await put('a1', 'v1', null);
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.data.rev, 1);

  const second = await put('a1', 'v2', 1);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.data.rev, 2);

  // 오래된 baseRev
  const stale = await put('a1', 'stale', 1);
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.conflict, true);
  assert.strictEqual(stale.data.rev, 2);
  assert.strictEqual(stale.data.trip.name, 'v2');
  assert.strictEqual(stale.data.trip.id, 'a1');

  // 이미 있는데 새로 만들기
  const dup = await put('a1', 'dup', null);
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.data.rev, 2);

  // 목록에 revs
  const list = await call('GET', '/api/trips', undefined, C);
  assert.deepStrictEqual(list.data.revs, { a1: 2 });
  assert.strictEqual('rev' in list.data.trips[0], false);

  // baseRev 생략: 예전 클라이언트용 무조건 덮어쓰기 (리비전은 올라간다)
  const legacy = await put('a1', 'legacy');
  assert.strictEqual(legacy.status, 200);
  assert.strictEqual(legacy.data.rev, 3);

  // 삭제
  const delStale = await call('DELETE', '/api/trips/a1', { baseRev: 2 }, C);
  assert.strictEqual(delStale.status, 409);
  assert.strictEqual(delStale.data.rev, 3);
  assert.strictEqual((await call('DELETE', '/api/trips/a1', { baseRev: 3 }, C)).status, 200);

  // 다른 곳에서 지워진 여행에 정수 baseRev로 저장
  const gone = await put('a1', 'again', 3);
  assert.strictEqual(gone.status, 409);
  assert.strictEqual(gone.data.trip, null);
  assert.strictEqual(gone.data.rev, null);
  // 이미 없는 여행 삭제는 그냥 성공
  assert.strictEqual((await call('DELETE', '/api/trips/a1', { baseRev: 3 }, C)).status, 200);

  // 잘못된 baseRev
  for (const bad of ['1', 0, 1.5, -1, true]) {
    assert.strictEqual((await put('a2', 'x', bad)).status, 400, `baseRev ${JSON.stringify(bad)}`);
  }
  assert.strictEqual((await call('DELETE', '/api/trips/a2', { baseRev: '1' }, C)).status, 400);
});

test('마이그레이션: rev 컬럼이 없는 예전 DB', async () => {
  const dbPath = path.join(tmp, 'old.db');
  // 서버로 계정을 만든 뒤 종료하고, trips 테이블만 예전 구조(rev 없음)로 되돌려 행을 넣는다
  const first = await startServer(dbPath);
  const su = await first.call('POST', '/api/signup', { username: 'dave', password: 'secret-pass-1' });
  assert.strictEqual(su.status, 201);
  await stopServer(first.child);

  const raw = new DatabaseSync(dbPath);
  raw.exec('DROP TABLE trips; CREATE TABLE trips (id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));');
  const uid = raw.prepare('SELECT id FROM users WHERE username = ?').get('dave').id;
  raw.prepare('INSERT INTO trips (id, user_id, data_json, updated_at) VALUES (?, ?, ?, ?)').run('old1', uid, JSON.stringify(trip('옛 여행')), Date.now());
  assert.strictEqual(raw.prepare('PRAGMA table_info(trips)').all().some((c) => c.name === 'rev'), false);
  raw.close();

  const second = await startServer(dbPath);
  const lg = await second.call('POST', '/api/login', { username: 'dave', password: 'secret-pass-1' });
  assert.strictEqual(lg.status, 200);
  const list = await second.call('GET', '/api/trips', undefined, lg.cookie);
  assert.strictEqual(list.data.trips.length, 1);
  assert.deepStrictEqual(list.data.revs, { old1: 1 });
  const upd = await second.call('PUT', '/api/trips/old1', { trip: trip('수정'), baseRev: 1 }, lg.cookie);
  assert.strictEqual(upd.data.rev, 2);
});

'use strict';
// 대중교통 프록시(server/transit.js)의 캐시 / 호출 제한 / 동시 요청 병합.
// 업스트림(fetch)은 test/tago.test.js 와 같은 방식으로 가짜 함수를 넣어 실제 네트워크를 쓰지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const { createTransit, MSG } = require('../server/transit');

// transit_cache 를 흉내 내는 메모리 DB
function memDb() {
  const m = new Map();
  return {
    getTransit: (k) => m.get(k),
    putTransit: (k, json, at) => m.set(k, { json, created_at: at }),
    purgeTransit: () => {},
  };
}

// 카카오 응답 원문 (transit.js 가 정규화한다)
const upstreamBody = () => ({
  status: 'OK',
  routes: [{ properties: { type: 'SUBWAY', totalDistance: 8000, totalTime: 1200, transfers: 0, fare: { value: 1500 } }, steps: [] }],
});
const resp = (body) => ({ ok: true, status: 200, json: async () => body });

function make(handler, env = { TP_KAKAO_REST_KEY: ' restkey ' }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return handler(new URL(url), init);
  };
  const t = createTransit({ db: memDb(), env, fetchImpl, now: () => 1000 });
  return { t, calls };
}

const Q = { sx: '126.97', sy: '37.55', ex: '129.04', ey: '35.10' };
const qAt = (i) => ({ ...Q, ex: String(120 + i / 1000) }); // 좌표가 달라 캐시 미스가 되는 요청

test('lookup: 캐시 적중이면 업스트림을 다시 부르지 않는다', async () => {
  const { t, calls } = make(() => resp(upstreamBody()));
  const a = await t.lookup(Q, 'ip');
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.cache, 'MISS');
  assert.strictEqual(a.body.status, 'OK');
  assert.strictEqual(calls.length, 1);

  // REST 키는 서버에서만 쓰고, 좌표는 업스트림 쿼리로 전달된다
  const { url, init } = calls[0];
  assert.strictEqual(init.headers.Authorization, 'KakaoAK restkey');
  assert.deepStrictEqual(['start_x', 'start_y', 'end_x', 'end_y'].map((k) => url.searchParams.get(k)), ['126.97', '37.55', '129.04', '35.1']);

  const b = await t.lookup(Q, 'ip');
  assert.strictEqual(b.status, 200);
  assert.strictEqual(b.cache, 'HIT');
  assert.deepStrictEqual(b.body, a.body);
  assert.strictEqual(calls.length, 1);
});

test('lookup: 같은 구간 동시 요청은 업스트림 한 번으로 합친다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { t, calls } = make(async () => {
    await gate;
    return resp(upstreamBody());
  });
  const p1 = t.lookup(Q, 'ip');
  const p2 = t.lookup(Q, 'ip');
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(a.cache, 'MISS');
  assert.deepStrictEqual(b.body, a.body);

  // 합쳐진 결과가 캐시되었으므로 다음 요청도 업스트림을 부르지 않는다
  assert.strictEqual((await t.lookup(Q, 'ip')).cache, 'HIT');
  assert.strictEqual(calls.length, 1);
});

test('lookup: 캐시 미스만 IP당 분당 60회로 제한, 429 + rate 메시지', async () => {
  const { t, calls } = make(() => resp(upstreamBody()));
  for (let i = 0; i < 60; i++) {
    const r = await t.lookup(qAt(i), '1.1.1.1');
    assert.strictEqual(r.status, 200, `i=${i}`);
  }
  assert.strictEqual(calls.length, 60);

  const blocked = await t.lookup(qAt(60), '1.1.1.1');
  assert.strictEqual(blocked.status, 429);
  assert.deepStrictEqual(blocked.body, { error: MSG.rate });
  assert.strictEqual(calls.length, 60);

  assert.strictEqual((await t.lookup(qAt(61), '2.2.2.2')).status, 200); // 다른 IP는 그대로
  // 캐시 적중은 호출 제한과 무관하다
  assert.strictEqual((await t.lookup(qAt(0), '1.1.1.1')).cache, 'HIT');
  assert.strictEqual(calls.length, 61);
});

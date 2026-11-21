const test = require('node:test');
const assert = require('node:assert');
const { createBus, scoreName, candidatesOf, placeKey, kstYmd, MSG } = require('../server/bus');
const { createQueue } = require('../server/tago');

const NOW = Date.UTC(2026, 10, 25, 3, 0); // 한국 시각 2026-11-25 12:00: 시험 날짜(11-26)가 고속(2일)·시외(1일) 조회 기간 안

// transit_cache 를 흉내 내는 메모리 DB
function memDb() {
  const m = new Map();
  return {
    rows: m,
    getTransit: (k) => m.get(k),
    putTransit: (k, json, at) => m.set(k, { json, created_at: at }),
    deleteTransit: (k) => m.delete(k),
    purgeTago: () => {},
  };
}

const resp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const hdr = (code) => ({ response: { header: { resultCode: code, resultMsg: 'X' } } });
const page = (items, total) => ({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: items.length ? { item: items } : '', totalCount: total ?? items.length } } });

/** TAGO 터미널 한 건 (업스트림 응답 모양: terminalId/terminalNm) */
const term = (id, name, city) => (city ? { terminalId: id, terminalNm: name, cityName: city } : { terminalId: id, terminalNm: name });
/** 터미널 목록 라우트 (numOfRows/pageNo 로 쪽을 나눈다) */
const listRoute = (rows) => (u) => {
  const n = Number(u.searchParams.get('numOfRows'));
  const p = Number(u.searchParams.get('pageNo'));
  return resp(page(rows.slice((p - 1) * n, p * n), rows.length));
};
/** 시간표 라우트. trips: { '출발id>도착id': rows } */
const tripsRoute = (trips) => (u) => resp(page(trips[`${u.searchParams.get('depTerminalId')}>${u.searchParams.get('arrTerminalId')}`] || []));
const routes = (o) => Object.assign({
  GetExpBusTrminlList: listRoute(o.exp || []),
  GetSuberbsBusTrminlList: listRoute(o.sub || []),
  GetStrtpntAlocFndExpbusInfo: tripsRoute(o.expTrips || {}),
  GetStrtpntAlocFndSuberbsBusInfo: tripsRoute(o.subTrips || {}),
}, o.extra || {});

function setup(r, env = { TP_TAGO_KEY: ' secretkey ' }) {
  const calls = [];
  const db = memDb();
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const op = u.pathname.split('/').pop();
    const h = r[op];
    if (!h) throw new Error(`unexpected upstream call: ${op}`);
    return h(u);
  };
  const bus = createBus({ db, env, fetchImpl, now: () => NOW, queue: createQueue(0), retryWaitMs: [0, 0] });
  const op = (name) => calls.filter((u) => u.pathname.endsWith(name));
  return { bus, db, calls, op };
}

// TAGO 버스 시간표 한 건 (depPlandTime/arrPlandTime 은 숫자 12자리, 14자리도 허용)
const brow = (dep, arr, charge, grade = '우등') => ({ depPlandTime: dep, arrPlandTime: arr, charge, gradeNm: grade, depPlaceNm: '', arrPlaceNm: '', routeId: 'R1' });

const SEOUL = { name: '서울고속버스터미널(경부)', lat: 37.5049, lon: 127.0049 };
const DONGDAEGU = { name: '동대구', lat: 35.8795, lon: 128.6285 };
const JEONJU = { name: '전주', lat: 35.8242, lon: 127.148 };
const DONGSEOUL = { name: '동서울', lat: 37.5345, lon: 127.0946 };
const BUSAN = { name: '부산종합버스터미널', lat: 35.1679, lon: 129.1322 };
const NAKDONG = { name: '낙동강휴게소', lat: 36.2, lon: 128.3 };
const q = (dep, arr, date = '20261126') => ({ depName: dep.name, depLat: dep.lat, depLon: dep.lon, arrName: arr.name, arrLat: arr.lat, arrLon: arr.lon, date });

// 동대구는 이름 하나에 id 가 여럿 (NAEK800..NAEK808)
const DONGDAEGU_IDS = Array.from({ length: 9 }, (_, i) => term(`NAEK80${i}`, '동대구'));
// 시외버스 목록: 서울/동대구 장소와 이름이 겹치지 않는 곳만 (고속만 조회되는 상황)
const SUB_TERMS = [term('NAI6193701', '전주', '전북특별자치도'), term('NAI2000001', '광주', '광주광역시')];
const pairCache = (kind, dep, arr) => `tago-v5|bus|pair|${kind}|${placeKey(dep)}|${placeKey(arr)}`;
const hintCache = (kind, place) => `tago-v5|bus|hint|${kind}|${placeKey(place)}`;

test('버스: 잘못된 파라미터는 400 (업스트림 호출 없음)', async () => {
  const { bus, calls } = setup(routes({}));
  const bad = [
    { ...q(SEOUL, DONGDAEGU), date: '20260230' },
    { ...q(SEOUL, DONGDAEGU), date: '2026112' },
    { ...q(SEOUL, DONGDAEGU), depName: '' },
    { ...q(SEOUL, DONGDAEGU), depName: '   ' },
    { ...q(SEOUL, DONGDAEGU), depName: '가'.repeat(61) },
    { ...q(SEOUL, DONGDAEGU), depLat: 40 },
    { ...q(SEOUL, DONGDAEGU), arrLon: 100 },
    { ...q(SEOUL, DONGDAEGU), arrLat: 'abc' },
    {},
  ];
  for (const b of bad) assert.strictEqual((await bus.trips(b, 'ip')).status, 400, JSON.stringify(b));
  assert.strictEqual(calls.length, 0);
});

test('버스: 키가 없으면 503, 같은 장소면 호출 없이 NO_RESULTS', async () => {
  const noKey = setup(routes({ exp: [term('NAEK010', '서울경부')] }), {});
  assert.ok(!noKey.bus.hasKey());
  const r = await noKey.bus.trips(q(SEOUL, DONGDAEGU), 'ip');
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error, /TP_TAGO_KEY/);
  assert.strictEqual(noKey.calls.length, 0);

  const { bus, calls } = setup(routes({}));
  const same = await bus.trips(q(SEOUL, SEOUL), 'ip');
  assert.strictEqual(same.status, 200);
  assert.deepStrictEqual(same.body, { status: 'NO_RESULTS', trips: [], terminals: { express: null, intercity: null }, errors: [], outOfWindow: [] });
  assert.strictEqual(calls.length, 0);
});

test('버스: 이름 점수 — 유스퀘어/경부, 시스템 이름(통합단말) 제외', async () => {
  const terms = [
    { id: 'NAEK010', name: '서울경부' },
    { id: 'NAEK011', name: '서울남부' },
    { id: 'NAEK020', name: '광주(유·스퀘어)' },
    { id: 'NAEK021', name: '광주비아' },
    { id: 'NAEK030', name: '동서울' },
  ];
  assert.deepStrictEqual(candidatesOf(terms, '유스퀘어광주종합버스터미널').map((x) => x.name), ['광주(유·스퀘어)']);
  assert.strictEqual(candidatesOf(terms, '서울고속버스터미널(경부)')[0].name, '서울경부'); // 부분 일치(동서울)보다 먼저
  assert.ok(scoreName('서울남부', '서울고속버스터미널(경부)') < 0.5); // 부분 일치만으로는 고르지 않는다

  // 업스트림 목록에서 시스템성 이름은 캐시 전에 뺀다
  const { bus, db } = setup(routes({
    exp: [term('NAEK010', '서울경부'), term('NAEK999', '통합단말(수수료)'), term('NAEK998', '공항왕복')],
    sub: SUB_TERMS,
  }));
  await bus.trips(q(SEOUL, DONGDAEGU), 'ip');
  const cached = JSON.parse(db.getTransit('tago-v5|bus|terms|exp').json);
  assert.deepStrictEqual(cached.terminals.map((t) => t.id), ['NAEK010']);
});

test('버스: 실제 시간표가 있는 첫 짝을 고르고 짝·힌트를 저장, 다음 요청은 0회 호출 (HIT)', async () => {
  const { bus, db, calls, op } = setup(routes({
    exp: [term('NAEK010', '서울경부'), ...DONGDAEGU_IDS],
    sub: SUB_TERMS,
    expTrips: { 'NAEK010>NAEK801': [brow(202611261330, 202611261615, 59800)] },
  }));
  const r = await bus.trips(q(SEOUL, DONGDAEGU), 'ip');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'OK');
  assert.deepStrictEqual(r.body.trips, [{ kind: 'express', grade: '우등', dep: '202611261330', arr: '202611261615', charge: 59800 }]);
  assert.deepStrictEqual(r.body.terminals, { express: { dep: '서울경부', arr: '동대구' }, intercity: null });
  assert.deepStrictEqual(r.body.errors, []);
  assert.strictEqual(r.cache, 'MISS');
  // id 800(결과 없음) 다음 801(결과 있음)에서 멈춘다
  assert.deepStrictEqual(op('GetStrtpntAlocFndExpbusInfo').map((u) => u.searchParams.get('arrTerminalId')), ['NAEK800', 'NAEK801']);
  // 짝 캐시 + 양쪽 힌트 (성공 id 가 맨 앞)
  assert.deepStrictEqual(JSON.parse(db.getTransit(pairCache('express', SEOUL, DONGDAEGU)).json), { a: 'NAEK010', b: 'NAEK801' });
  assert.deepStrictEqual(JSON.parse(db.getTransit(hintCache('express', SEOUL)).json), { ids: ['NAEK010'] });
  assert.deepStrictEqual(JSON.parse(db.getTransit(hintCache('express', DONGDAEGU)).json), { ids: ['NAEK801'] });

  const before = calls.length;
  const r2 = await bus.trips(q(SEOUL, DONGDAEGU), 'ip');
  assert.strictEqual(r2.cache, 'HIT');
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(r2.body.trips, r.body.trips);
  assert.strictEqual(calls.length, before); // 터미널·짝·시간표 캐시로 모두 답한다
  // 키와 공통 파라미터는 업스트림으로 전달된다
  const u = op('GetExpBusTrminlList')[0];
  assert.strictEqual(u.searchParams.get('serviceKey'), 'secretkey');
  assert.strictEqual(u.searchParams.get('_type'), 'json');
  assert.strictEqual(u.searchParams.get('numOfRows'), '1000');
  // 시간표도 1000건씩 받는다 (빠뜨리면 TAGO 기본 10건만 온다 — 2026-11-21 실호출에서 40편 중 10편만 나온 버그)
  for (const t of op('GetStrtpntAlocFndExpbusInfo')) assert.strictEqual(t.searchParams.get('numOfRows'), '1000');
});

test('버스: 힌트가 있으면 그 id 를 먼저 시도한다 (동서울 -> 동대구)', async () => {
  const { bus, op } = setup(routes({
    exp: [term('NAEK010', '서울경부'), term('NAEK030', '동서울'), term('NAEK040', '전주'), ...DONGDAEGU_IDS],
    sub: SUB_TERMS,
    expTrips: {
      'NAEK801>NAEK040': [brow(202611260730, 202611261030, 20000)], // 800 은 결과 없음 -> 801 로
      'NAEK030>NAEK801': [brow(202611261100, 202611261330, 30000)],
    },
  }));
  const first = await bus.trips(q(DONGDAEGU, JEONJU), 'ip');
  assert.strictEqual(first.body.status, 'OK');
  assert.deepStrictEqual(op('GetStrtpntAlocFndExpbusInfo').map((u) => u.searchParams.get('depTerminalId')), ['NAEK800', 'NAEK801']);

  const n = op('GetStrtpntAlocFndExpbusInfo').length;
  const second = await bus.trips(q(DONGSEOUL, DONGDAEGU), 'ip');
  assert.strictEqual(second.body.status, 'OK');
  assert.strictEqual(second.body.trips[0].dep, '202611261100');
  // 동대구 힌트(NAEK801)를 먼저 보므로 시간표 요청은 한 번뿐이다 (동대구 id 9개보다 적다)
  assert.strictEqual(op('GetStrtpntAlocFndExpbusInfo').length - n, 1);
});

test('버스: 휴게소 방향 — 낙동강 823(서울경부)·824(부산)를 짝마다 맞게 고른다', async () => {
  const { bus, db, calls } = setup(routes({
    exp: [term('NAEK010', '서울경부'), term('NAEK050', '부산'), term('NAEK823', '낙동강'), term('NAEK824', '낙동강')],
    sub: SUB_TERMS,
    expTrips: {
      'NAEK010>NAEK823': [brow(202611260800, 202611261000, 15000)],
      'NAEK050>NAEK824': [brow(202611261400, 202611261530, 9000)],
    },
  }));
  const a = await bus.trips(q(SEOUL, NAKDONG), 'ip');
  assert.strictEqual(a.body.status, 'OK');
  assert.deepStrictEqual(a.body.terminals.express, { dep: '서울경부', arr: '낙동강' });
  const b = await bus.trips(q(BUSAN, NAKDONG), 'ip');
  assert.strictEqual(b.body.status, 'OK');
  assert.strictEqual(b.body.trips[0].dep, '202611261400');
  assert.deepStrictEqual(JSON.parse(db.getTransit(pairCache('express', SEOUL, NAKDONG)).json), { a: 'NAEK010', b: 'NAEK823' });
  assert.deepStrictEqual(JSON.parse(db.getTransit(pairCache('express', BUSAN, NAKDONG)).json), { a: 'NAEK050', b: 'NAEK824' });
  // 짝·시간표 캐시로 다시 조회하면 업스트림을 부르지 않는다
  const before = calls.length;
  assert.strictEqual((await bus.trips(q(BUSAN, NAKDONG), 'ip')).cache, 'HIT');
  assert.strictEqual(calls.length, before);
});

test('버스: 짝 캐시가 결과 0건이면 행을 지우고 다른 후보로 다시 찾는다', async () => {
  const { bus, db, op } = setup(routes({
    exp: [term('NAEK010', '서울경부'), term('NAEK040', '전주'), term('NAEK041', '전주')],
    sub: SUB_TERMS,
    expTrips: { 'NAEK010>NAEK041': [brow(202611260900, 202611261130, 12000, '일반')] },
  }));
  db.putTransit(pairCache('express', SEOUL, JEONJU), JSON.stringify({ a: 'NAEK010', b: 'NAEK040' }), NOW);
  db.putTransit('tago-v5|bus|trips|express|NAEK010|NAEK040|20261126', JSON.stringify({ trips: [] }), NOW);
  const r = await bus.trips(q(SEOUL, JEONJU), 'ip');
  assert.strictEqual(r.body.status, 'OK');
  assert.deepStrictEqual(JSON.parse(db.getTransit(pairCache('express', SEOUL, JEONJU)).json), { a: 'NAEK010', b: 'NAEK041' });
  assert.deepStrictEqual(JSON.parse(db.getTransit('tago-v5|bus|trips|express|NAEK010|NAEK041|20261126').json).trips.map((t) => t.charge), [12000]);
  // 040 은 캐시된 빈 결과로 확인했으므로 실제 요청은 041 한 번뿐이다
  assert.strictEqual(op('GetStrtpntAlocFndExpbusInfo').length, 1);
});

test('버스: 검증 중 초당 한도(코드 23)는 재시도 후 그 종류만 오류, 다른 종류가 있으면 200', async () => {
  const quota = () => resp(hdr('23'));
  const { bus, db, op } = setup(routes({
    exp: [term('NAEK010', '서울경부'), ...DONGDAEGU_IDS],
    sub: [term('NAI2', '서울경부'), term('NAI1', '동대구')],
    subTrips: { 'NAI2>NAI1': [brow(202611260900, 202611261130, 12000, '일반')] },
    extra: { GetStrtpntAlocFndExpbusInfo: quota },
  }));
  const r = await bus.trips(q(SEOUL, DONGDAEGU), 'ip');
  assert.strictEqual(r.status, 200); // 시외 쪽이 성공했으므로 200
  assert.strictEqual(r.body.status, 'OK');
  assert.deepStrictEqual(r.body.errors, [MSG.quota]);
  assert.deepStrictEqual(r.body.terminals, { express: null, intercity: { dep: '서울경부', arr: '동대구' } });
  assert.deepStrictEqual(r.body.trips.map((t) => t.kind), ['intercity']);
  // 고속 시간표는 처음 1회 + 재시도 2회에서 멈추고, 오류는 짝/시간표로 캐시되지 않는다
  assert.strictEqual(op('GetStrtpntAlocFndExpbusInfo').length, 3);
  assert.strictEqual(db.getTransit(pairCache('express', SEOUL, DONGDAEGU)), undefined);
  assert.ok(![...db.rows.keys()].some((k) => k.startsWith('tago-v5|bus|trips|express|')));

  // 둘 다 실패하면 첫 실패의 상태(429)와 메시지
  const bad = setup(routes({
    exp: [term('NAEK010', '서울경부'), ...DONGDAEGU_IDS],
    sub: [term('NAI2', '서울경부'), term('NAI1', '동대구')],
    extra: { GetStrtpntAlocFndExpbusInfo: quota, GetStrtpntAlocFndSuberbsBusInfo: quota },
  }));
  const r2 = await bad.bus.trips(q(SEOUL, DONGDAEGU), 'ip');
  assert.strictEqual(r2.status, 429);
  assert.deepStrictEqual(r2.body, { error: MSG.quota });
});

test('버스: 한 종류를 찾을 때 시간표 요청은 20회까지만 (캐시 적중은 세지 않는다)', async () => {
  const exp = [
    ...[0, 1, 2, 3, 4].map((i) => term(`NAEK90${i}`, '가나다')),
    term('NAEK910', '가나다라'),
    term('NAEK911', '가나다라'),
    term('NAEK920', '나다'),
    ...[0, 1, 2].map((i) => term(`NAEK93${i}`, '마바사')),
    term('NAEK940', '마바'),
    term('NAEK941', '바사'),
  ];
  const { bus, op } = setup(routes({ exp, sub: SUB_TERMS }));
  const dep = { name: '가나다', lat: 37.5, lon: 127 };
  const arr = { name: '마바사', lat: 35.9, lon: 128.6 };
  const r = await bus.trips(q(dep, arr), 'ip');
  assert.strictEqual(r.body.status, 'NO_RESULTS');
  assert.strictEqual(op('GetStrtpntAlocFndExpbusInfo').length, 20); // 후보 짝은 40개지만 상한에서 멈춘다
});

test('버스: 같은 쿼리의 동시 요청은 업스트림을 공유하고, 완전 캐시 밖 요청만 IP당 30회로 제한', async () => {
  const slow = () => new Promise((r) => setTimeout(() => r(resp(page([term('NAEK010', '서울경부'), term('NAEK800', '동대구')]))), 5));
  const { bus, calls } = setup(routes({ exp: [], sub: SUB_TERMS, extra: { GetExpBusTrminlList: slow } }));
  const [a, b] = await Promise.all([bus.trips(q(SEOUL, DONGDAEGU), '1.1.1.1'), bus.trips(q(SEOUL, DONGDAEGU), '1.1.1.1')]);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(a.cache, 'MISS');
  assert.strictEqual(calls.length, 3); // 터미널 목록(고속·시외) + 시간표 1회만

  // 첫 요청 1회 + 아래 29회 = 30회 (같은 IP, 모두 캐시 미스: 날짜를 바꾼다 — 조회 기간 밖 미래 날짜는 부르지 않으므로 지난 날짜로)
  for (let i = 1; i <= 29; i++) {
    const r = await bus.trips(q(SEOUL, DONGDAEGU, `202610${String(i).padStart(2, '0')}`), '1.1.1.1');
    assert.strictEqual(r.status, 200, `i=${i}`);
  }
  assert.strictEqual((await bus.trips(q(SEOUL, DONGDAEGU, '20261031'), '1.1.1.1')).status, 429);
  assert.strictEqual((await bus.trips(q(SEOUL, DONGDAEGU, '20261031'), '2.2.2.2')).status, 200); // 다른 IP 는 통과
});

test('버스: 고속·시외를 합쳐 출발 시각 순으로, 14자리 시각·요금 없음 처리', async () => {
  const { bus } = setup(routes({
    exp: [term('NAEK010', '서울경부'), ...DONGDAEGU_IDS],
    sub: [term('NAI2', '서울경부'), term('NAI1', '동대구')],
    expTrips: {
      'NAEK010>NAEK801': [
        brow(20261126133000, 20261126161500, 59800, '우등'),
        brow(20261126150000, 20261126180000, 'x', '일반'), // 요금 없음 -> null
        brow(20261126100000, 20261126120000, -5, '일반'), // 음수 요금 -> null
        { depPlandTime: 'bad', arrPlandTime: 20261126120000, charge: 1 }, // 시각이 잘못되면 버린다
      ],
    },
    subTrips: { 'NAI2>NAI1': [brow(20261126090000, 20261126113000, 12000, '일반')] },
  }));
  const r = await bus.trips(q(SEOUL, DONGDAEGU), 'ip');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'OK');
  assert.deepStrictEqual(r.body.trips.map((t) => [t.kind, t.dep, t.charge]), [
    ['intercity', '202611260900', 12000],
    ['express', '202611261000', null],
    ['express', '202611261330', 59800],
    ['express', '202611261500', null],
  ]);
  assert.deepStrictEqual(r.body.terminals, { express: { dep: '서울경부', arr: '동대구' }, intercity: { dep: '서울경부', arr: '동대구' } });
});

test('버스: 조회 기간 밖 날짜는 그 종류를 부르지 않는다 (고속 2일 뒤, 시외 다음 날까지)', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); throw new Error('부르면 안 됨'); };
  const db = memDbForWindow();
  const bus = createBus({ db, env: { TP_TAGO_KEY: 'k' }, fetchImpl, now: () => NOW, queue: createQueue(0), retryWaitMs: [0, 0] });
  const far = await bus.trips({ depName: '서울경부', depLat: 37.5, depLon: 127, arrName: '부산', arrLat: 35.2, arrLon: 129.1, date: '20261130' }, 'ip');
  assert.strictEqual(far.status, 200);
  assert.deepStrictEqual(far.body.outOfWindow, ['express', 'intercity']);
  assert.strictEqual(far.body.status, 'NO_RESULTS');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(kstYmd(NOW, 0), '20261125');
  assert.strictEqual(kstYmd(NOW, 2), '20261127');
});

function memDbForWindow() {
  const m = new Map();
  return { getTransit: (k) => m.get(k), putTransit: (k, json, at) => m.set(k, { json, created_at: at }), deleteTransit: (k) => m.delete(k), purgeTago: () => {} };
}

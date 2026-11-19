const test = require('node:test');
const assert = require('node:assert');
const { createTago, normTrips, validDate, nameKeys } = require('../server/tago');

// transit_cache 를 흉내 내는 메모리 DB
function memDb() {
  const m = new Map();
  return {
    getTransit: (k) => m.get(k),
    putTransit: (k, json, at) => m.set(k, { json, created_at: at }),
    purgeTago: () => {},
  };
}
const ok = (item, total) => ({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: item === undefined ? '' : { item }, numOfRows: 1000, pageNo: 1, totalCount: total ?? (Array.isArray(item) ? item.length : item ? 1 : 0) } } });
const resp = (body) => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const row = (no, dep, arr, fare) => ({ trainno: no, traingradename: 'KTX', depplandtime: dep, arrplandtime: arr, adultcharge: fare });

function make(handler, env = { TP_TAGO_KEY: ' secretkey ' }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    return handler(new URL(url));
  };
  const t = createTago({ db: memDb(), env, fetchImpl, now: () => 1000 });
  return { t, calls };
}
const Q = { dep: 'NAT010000', arr: 'NAT014445', date: '20261126' };

test('validDate: 실제 달력 날짜만', () => {
  assert.ok(validDate('20261126'));
  assert.ok(validDate('20240229'));
  for (const s of ['20260229', '20261301', '20261132', '2026112', '202611266', 'abcdefgh', '', undefined]) assert.ok(!validDate(s), String(s));
});

test('trips: 잘못된 파라미터는 400', async () => {
  const { t, calls } = make(() => resp(ok([])));
  for (const q of [{}, { ...Q, dep: 'XYZ' }, { ...Q, arr: 'NAT01' }, { ...Q, date: '20260230' }, { ...Q, dep: 'NAT010000&x=1' }]) {
    assert.strictEqual((await t.trips(q, 'ip')).status, 400);
  }
  assert.strictEqual(calls.length, 0);
});

test('키가 없으면 503 (요청 파라미터가 맞아도)', async () => {
  const { t, calls } = make(() => resp(ok([])), {});
  assert.ok(!t.hasKey());
  const r = await t.trips(Q, 'ip');
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error, /TP_TAGO_KEY/);
  assert.strictEqual((await t.stations('ip')).status, 503);
  assert.strictEqual(calls.length, 0);
});

test('normTrips: 한 건 객체, 문자열 요금, 요금 없음, 초 제거, 정렬', async () => {
  const { t } = make(() => resp(ok(row('00105', '20261126133000', '20261126161500', '59800'))));
  assert.ok(t.hasKey());
  const r = await t.trips(Q, 'ip');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { status: 'OK', trips: [{ no: '105', type: 'KTX', dep: '202611261330', arr: '202611261615', charge: 59800 }] });

  const n = normTrips([row('2', '20261126150000', '20261126170000', ''), row('1', '20261126080000', '20261126100000', 'x'), row('3', '20261126110000', '20261126130000', undefined), row('4', 'bad', '20261126130000', '1')]);
  assert.deepStrictEqual(n.trips.map((x) => [x.no, x.charge]), [['1', null], ['3', null], ['2', null]]);
  assert.strictEqual(normTrips([row('1', '20261126080000', '20261126100000', '-5')]).trips[0].charge, null);
});

test('trips: 빈 items 는 NO_RESULTS, 키와 파라미터가 업스트림으로 전달됨', async () => {
  const { t, calls } = make(() => resp(ok(undefined)));
  const r = await t.trips(Q, 'ip');
  assert.deepStrictEqual(r.body, { status: 'NO_RESULTS', trips: [] });
  const u = calls[0];
  assert.strictEqual(u.searchParams.get('serviceKey'), 'secretkey');
  assert.strictEqual(u.searchParams.get('depPlaceId'), 'NAT010000');
  assert.strictEqual(u.searchParams.get('depPlandTime'), '20261126');
  assert.strictEqual(u.searchParams.get('_type'), 'json');
});

test('trips: 여러 페이지를 모두 가져옴', async () => {
  const { t, calls } = make((u) => {
    const p = u.searchParams.get('pageNo');
    return resp(ok(p === '1' ? [row('1', '20261126080000', '20261126100000', '1000')] : [row('2', '20261126070000', '20261126090000', '2000')], 2));
  });
  const r = await t.trips(Q, 'ip');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(r.body.trips.map((x) => x.no), ['2', '1']);
});

test('trips: 캐시 적중이면 업스트림을 다시 부르지 않고, 같은 조건 동시 요청은 한 번만 호출', async () => {
  const { t, calls } = make(() => resp(ok([row('1', '20261126080000', '20261126100000', '1000')])));
  const [a, b] = await Promise.all([t.trips(Q, 'ip'), t.trips(Q, 'ip')]);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(calls.length, 1);
  const c = await t.trips(Q, 'ip');
  assert.strictEqual(c.cache, 'HIT');
  assert.strictEqual(calls.length, 1);
});

test('캐시 TTL: 성공 6시간, 결과 없음 1시간', async () => {
  let clock = 1000;
  const db = memDb();
  let empty = false;
  const fetchImpl = async () => resp(empty ? ok(undefined) : ok([row('1', '20261126080000', '20261126100000', '1')]));
  const t = createTago({ db, env: { TP_TAGO_KEY: 'k' }, fetchImpl, now: () => clock });
  await t.trips(Q, 'ip');
  clock += 5 * 3600 * 1000;
  assert.strictEqual((await t.trips(Q, 'ip')).cache, 'HIT');
  clock += 2 * 3600 * 1000;
  empty = true;
  assert.strictEqual((await t.trips(Q, 'ip')).cache, 'MISS');
  clock += 30 * 60 * 1000;
  assert.strictEqual((await t.trips(Q, 'ip')).cache, 'HIT');
  clock += 40 * 60 * 1000;
  assert.strictEqual((await t.trips(Q, 'ip')).cache, 'MISS');
});

test('오류 매핑: 본문 오류 코드, XML 오류, HTTP 오류, 네트워크, 키 누출 없음', async () => {
  const hdr = (code) => ({ response: { header: { resultCode: code, resultMsg: 'SECRETMSG' } } });
  const xml = (code) => `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>${code}</returnReasonCode><returnAuthMsg>secretkey</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  const cases = [
    [() => resp(hdr('22')), 429],
    [() => resp(hdr('30')), 502],
    [() => resp(hdr('99')), 502],
    [() => resp(xml('30')), 502],
    [() => resp(xml('22')), 429],
    [() => ({ ok: false, status: 500, text: async () => 'boom' }), 502],
    [() => ({ ok: false, status: 429, text: async () => '' }), 429],
    [() => { throw new Error('ECONNRESET secretkey'); }, 502],
    [() => { const e = new Error('x'); e.name = 'AbortError'; throw e; }, 504],
  ];
  for (const [h, status] of cases) {
    const { t } = make(h);
    const r = await t.trips(Q, 'ip');
    assert.strictEqual(r.status, status);
    const s = JSON.stringify(r.body);
    assert.ok(!/secretkey|SECRETMSG|ECONNRESET|boom/.test(s));
    assert.ok(typeof r.body.error === 'string' && r.body.error);
  }
  // NODATA(03)는 오류가 아니라 결과 없음
  const { t } = make(() => resp(hdr('03')));
  assert.strictEqual((await t.trips(Q, 'ip')).body.status, 'NO_RESULTS');
});

test('오류 응답은 캐시하지 않음', async () => {
  let fail = true;
  const { t, calls } = make(() => (fail ? resp({ response: { header: { resultCode: '99' } } }) : resp(ok([row('1', '20261126080000', '20261126100000', '1')]))));
  assert.strictEqual((await t.trips(Q, 'ip')).status, 502);
  fail = false;
  assert.strictEqual((await t.trips(Q, 'ip')).status, 200);
  assert.strictEqual(calls.length, 2);
});

test('stations: 도시별로 모아 정규화하고 캐시', async () => {
  const { t, calls } = make((u) => {
    const op = u.pathname.split('/').pop();
    if (op === 'GetCtyCodeList') return resp(ok([{ citycode: '11', cityname: '서울특별시' }, { citycode: '21', cityname: '부산광역시' }]));
    const c = u.searchParams.get('cityCode');
    if (c === '11') return resp(ok([{ nodeid: 'NAT010000', nodename: '서울' }, { nodeid: 'NAT010091', nodename: '영등포' }, { nodeid: 'bad', nodename: 'x' }]));
    return resp(ok({ nodeid: 'NAT014445', nodename: '부산' })); // 한 건 객체
  });
  const r = await t.stations('ip');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.stations, [
    { id: 'NAT010000', name: '서울', city: '서울특별시', lat: null, lon: null }, // 카카오 키 없음 -> 좌표 없음
    { id: 'NAT010091', name: '영등포', city: '서울특별시', lat: null, lon: null },
    { id: 'NAT014445', name: '부산', city: '부산광역시', lat: null, lon: null },
  ]);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual((await t.stations('ip')).cache, 'HIT');
  assert.strictEqual(calls.length, 3);
});

test('stations: 카카오 키워드 검색으로 좌표를 붙인다 (기차역 + 이름 정확히 일치만)', async () => {
  const doc = (place_name, category_name, y, x) => ({ place_name, category_name, y, x });
  const TRAIN = '교통,수송 > 기차,철도 > 기차역 > KTX정차역';
  const kakao = new Map([
    ['서울역', [doc('서울역 1호선', '교통,수송 > 지하철,전철 > 수도권1호선', '1', '1'), doc('서울역 주차장', '교통,수송 > 교통시설 > 주차장', '2', '2'), doc('서울역', TRAIN, '37.55', '126.97')]],
    ['김천구미역', [doc('김천(구미)역', TRAIN, '36.11', '128.18')]],
    ['판교(경기)역', [doc('판교역(충남)', TRAIN, '9', '9'), doc('판교역(경기)', TRAIN, '37.39', '127.11')]],
    ['춘천역', [doc('남춘천역', TRAIN, '3', '3'), doc('춘천역 경춘선', '교통,수송 > 지하철,전철 > 경춘선', '4', '4')]], // 노선 표기를 떼고 지하철역으로
    ['일산역', [doc('일산역 주차장', '교통,수송 > 교통시설 > 주차장', '5', '5')]], // 일치 없음 -> null (두 번째 검색도 없음)
    ['대전 기차역', [doc('대전', '교통,수송 > 교통시설', '6', '6')]], // 두 번째 검색, 3순위 분류
    ['대전역', [doc('대전역', '교통,수송 > 교통시설 > 터미널', '7', '7'), doc('대전역 1호선', '교통,수송 > 지하철,전철 > 대전1호선', '8', '8')]],
    ['부산역', 'error'],
    ['제주역', 'throw'],
  ]);
  const seen = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'dapi.kakao.com') {
      seen.push(init && init.headers && init.headers.Authorization);
      calls.push(u.searchParams.get('query'));
      const d = kakao.get(u.searchParams.get('query'));
      if (d === 'throw') throw new Error('network');
      if (d === 'error') return { ok: false, status: 500, text: async () => '' };
      return resp({ documents: d || [] });
    }
    if (u.pathname.endsWith('GetCtyCodeList')) return resp(ok([{ citycode: '11', cityname: '서울특별시' }]));
    return resp(ok(['서울', '김천구미', '판교(경기)', '춘천', '부산', '일산', '대전', '제주'].map((n, i) => ({ nodeid: `NAT00000${i}`, nodename: n }))));
  };
  const t = createTago({ db: memDb(), env: { TP_TAGO_KEY: 'k', TP_KAKAO_REST_KEY: ' kk ' }, fetchImpl, now: () => 1000 });
  const r = await t.stations('ip');
  assert.deepStrictEqual(r.body.stations.map((s) => [s.name, s.lat, s.lon]), [
    ['서울', 37.55, 126.97], ['김천구미', 36.11, 128.18], ['판교(경기)', 37.39, 127.11], ['춘천', 4, 4], ['부산', null, null], ['일산', null, null], ['대전', 8, 8], ['제주', null, null],
  ]);
  assert.strictEqual(r.status, 200);
  assert.ok(seen.length >= 8 && seen.every((a) => a === 'KakaoAK kk'));
  assert.ok(calls.includes('판교(경기)역'));
  assert.strictEqual((await t.stations('ip')).cache, 'HIT');
});

test('nameKeys: 괄호를 붙인 이름이 먼저', () => {
  assert.deepStrictEqual(nameKeys('김천(구미)'), ['김천구미', '김천']);
  assert.deepStrictEqual(nameKeys('판교(경기)'), ['판교경기', '판교']);
  assert.deepStrictEqual(nameKeys('서울'), ['서울']);
});

test('stations: 동시 요청은 업스트림을 공유', async () => {
  const { t, calls } = make((u) => (u.pathname.endsWith('GetCtyCodeList') ? resp(ok([{ citycode: '11', cityname: '서울특별시' }])) : resp(ok([{ nodeid: 'NAT010000', nodename: '서울' }]))));
  await Promise.all([t.stations('a'), t.stations('b'), t.stations('c')]);
  assert.strictEqual(calls.length, 2);
});

test('호출 제한: 캐시 미스만 IP당 분당 30회, 캐시 적중은 제한 없음', async () => {
  const { t } = make(() => resp(ok([row('1', '20261126080000', '20261126100000', '1')])));
  for (let i = 1; i <= 30; i++) {
    const r = await t.trips({ ...Q, date: `202612${String(i).padStart(2, '0')}` }, '1.1.1.1');
    assert.strictEqual(r.status, 200, `i=${i}`);
  }
  assert.strictEqual((await t.trips({ ...Q, date: '20261231' }, '1.1.1.1')).status, 429);
  assert.strictEqual((await t.trips({ ...Q, date: '20261231' }, '2.2.2.2')).status, 200); // 다른 IP
  assert.strictEqual((await t.trips({ ...Q, date: '20261201' }, '1.1.1.1')).cache, 'HIT'); // 캐시는 제한과 무관
});

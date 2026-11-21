'use strict';
// train.js 는 브라우저 전역(window.TP)에 붙는 스크립트라 최소 스텁으로 Node에서 로드한다.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../public/js/train.js');
const T = globalThis.TP.train;

test('normName: 공백·괄호·KTX/SRT·역 제거', () => {
  assert.equal(T.normName(' 서울역 '), '서울');
  assert.equal(T.normName('서울 (KTX)'), '서울');
  assert.equal(T.normName('부산역(부산)'), '부산');
  assert.equal(T.normName('수서 SRT'), '수서');
  assert.equal(T.normName('동대구KTX'), '동대구');
  assert.equal(T.normName('역삼'), '역삼');
  assert.equal(T.normName(''), '');
});

test('matchStation: 정규화한 이름이 같을 때만 매칭', () => {
  const st = [{ id: 'NAT010000', name: '서울' }, { id: 'NATH30000', name: '수서' }, { id: 'NAT014445', name: '서울' }];
  assert.equal(T.matchStation(st, '서울역').id, 'NAT010000'); // 이름이 같으면 첫 번째
  assert.equal(T.matchStation(st, '수서역 (SRT)').id, 'NATH30000');
  assert.equal(T.matchStation(st, '서울숲'), null);
  assert.equal(T.matchStation(st, '  '), null);
});

test('timeToMin: YYYYMMDDHHMM -> 자정 기준 분, 다음 날 도착은 dep보다 작아진다', () => {
  assert.equal(T.timeToMin('202611261330'), 810);
  const dep = T.timeToMin('202611262330');
  const arr = T.timeToMin('202611270110');
  assert.equal(dep, 1410);
  assert.equal(arr, 70);
  assert.ok(arr < dep);
});

test('inWindow: 오늘 ~ 오늘+LOOKUP_DAYS', () => {
  const now = new Date(2026, 10, 19, 15, 0); // 2026-11-19
  assert.equal(T.inWindow('20261119', now), true);
  assert.equal(T.inWindow('20261118', now), false);
  assert.equal(T.inWindow('20261217', now), true); // +28일
  assert.equal(T.inWindow('20261218', now), false);
  assert.equal(T.inWindow('', now), false);
  const last = T.lastLookupDate(now);
  assert.equal(`${last.getMonth() + 1}-${last.getDate()}`, '12-17');
});

test('peek: 기간 밖이면 역 목록 없이도 period', () => {
  assert.deepEqual(T.peek({ name: '서울' }, { name: '부산' }, '20000101'), { state: 'none', reason: 'period' });
});

test('normName·matchStation: 괄호를 붙인 이름을 먼저, 없으면 괄호를 뺀 이름', () => {
  assert.equal(T.normName('김천(구미)역'), '김천');
  const st = [{ id: 'A', name: '김천' }, { id: 'B', name: '김천구미' }, { id: 'C', name: '판교(경기)' }, { id: 'D', name: '판교(충남)' }];
  assert.equal(T.matchStation(st, '김천(구미)역').id, 'B');
  assert.equal(T.matchStation(st, '김천역').id, 'A');
  assert.equal(T.matchStation(st, '판교역(경기)').id, 'C');
  assert.equal(T.matchStation(st, '판교(충남)').id, 'D');
  assert.equal(T.matchStation([{ id: 'E', name: '김천(구미)' }, { id: 'A', name: '김천' }], '김천(구미)역').id, 'E');
});

// 좌표가 있는 역 목록을 불러 둔 상태 (이 아래 테스트는 같은 역 목록을 쓴다)
const R = Math.PI / 180;
globalThis.TP.routing = {
  haversine: (a, b) => {
    const h = Math.sin(((b.lat - a.lat) * R) / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(((b.lon - a.lon) * R) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  },
};
const SEOUL = { id: 'S', name: '서울', lat: 37.5547, lon: 126.9707 };
const YONGSAN = { id: 'Y', name: '용산', lat: 37.5299, lon: 126.9647 }; // 서울역에서 약 2.9km
const GWANGMYEONG = { id: 'G', name: '광명', lat: 37.4162, lon: 126.8847 }; // 약 17km
const SUWON = { id: 'W', name: '수원', lat: 37.2660, lon: 127.0001 }; // 약 32km
const GIMCHEON = { id: 'A', name: '김천', lat: 36.1235, lon: 128.1147 };
const GUMI_ST = { id: 'B', name: '김천구미', lat: 36.1135, lon: 128.181 };
const NOPOS = { id: 'N', name: '좌표없음', lat: null, lon: null };

test('nearStations·stationOf: 역 목록 불러오기', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ stations: [SUWON, GWANGMYEONG, NOPOS, YONGSAN, SEOUL, GIMCHEON, GUMI_ST] }) });
  await T.load();
  // 20km 안의 좌표 있는 역만, 가까운 순
  const near = T.nearStations({ name: '서울시청', lat: 37.5663, lon: 126.9779 });
  assert.deepEqual(near.map((c) => c.name), ['서울역', '용산역', '광명역']);
  assert.ok(near[0].distance < near[1].distance && near[1].distance < near[2].distance);
  assert.deepEqual([near[0].lat, near[0].lon, near[0].hub, near[0].station.id], [SEOUL.lat, SEOUL.lon, 'train', 'S']);
  assert.deepEqual(T.nearStations({ name: '제주', lat: 33.5, lon: 126.5 }), []);
  assert.deepEqual(T.nearStations({ name: '이름만' }), []);
  // 좌표가 500m 안이면 이름과 상관없이 그 역, 아니면 이름으로
  assert.equal(T.stationOf({ name: '김천(구미)역', lat: 36.1136, lon: 128.1811 }).id, 'B');
  assert.equal(T.stationOf({ name: '김천(구미)역', lat: 36.0, lon: 128.0 }).id, 'B'); // 가까운 역이 없으면 이름: 괄호를 붙인 이름 먼저
  assert.equal(T.stationOf({ name: '엉뚱한 이름', lat: 37.5548, lon: 126.9708 }).id, 'S');
  assert.equal(T.stationOf({ name: '용산역' }).id, 'Y');
  assert.equal(T.stationOf({ name: '없는역', lat: 33.5, lon: 126.5 }), null);
});

test('withTrains: 열차가 1편 이상이거나 조회에 실패한 후보, 원래 순서(가까운 순) 그대로', () => {
  const cands = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
  const err = { error: 'TAGO 열차 API 호출 한도를 초과했어요. 잠시 후 다시 시도해 주세요.' };
  // 조회 실패(C)는 '열차 없음'이 아니므로 빼지 않는다
  assert.deepEqual(T.withTrains(cands, [3, 0, err, 26]).map((c) => [c.name, c.count]), [['A', 3], ['C', err], ['D', 26]]);
  assert.deepEqual(T.withTrains(cands, [0, 0, 0, 0]), []);
  assert.deepEqual(T.withTrains(cands, [0, null, 0, 0]), []); // 아직 조회 안 함(null)은 빼는 그대로
});

test('searchStations: 이름 포함 검색, 좌표 필수, 가까운 순, 개수 제한', () => {
  // 앞 테스트에서 불러온 역 목록(수원·광명·좌표없음·용산·서울·김천·김천구미)을 쓴다
  const place = { name: '서울시청', lat: 37.5663, lon: 126.9779 };
  assert.deepEqual(T.searchStations(place, '서울').map((c) => c.name), ['서울역']);
  assert.deepEqual(T.searchStations(place, '서울역').map((c) => c.name), ['서울역']); // 끝의 '역' 무시
  const r = T.searchStations(place, '산', 8); // 포함 검색, 좌표 없는 '좌표없음'은 제외
  assert.ok(r.every((c) => c.hub === 'train' && typeof c.distance === 'number'));
  assert.deepEqual(T.searchStations(place, '좌표').map((c) => c.name), []);
  assert.deepEqual(T.searchStations(place, '김천').map((c) => c.name).sort(), ['김천구미역', '김천역']);
  assert.deepEqual(T.searchStations(place, '김천구미').map((c) => c.station.id), ['B']); // 괄호 붙인 이름으로도
  assert.deepEqual(T.searchStations(place, ' ').map((c) => c.name), []);
  const two = T.searchStations(place, '김천');
  assert.deepEqual(two.map((c) => c.distance), [...two.map((c) => c.distance)].sort((a, b) => a - b)); // 가까운 순
  assert.equal(T.searchStations(place, '김천', 1).length, 1);
});

test('load: 서버가 좌표를 다 못 채운 표(incomplete)를 주면 1분 뒤 다시 받고, 다시 받기에 실패해도 받아 둔 표를 계속 쓴다', async () => {
  // 앞 테스트들이 역 목록을 이미 불러온 모듈과 섞이지 않게 새로 불러온다
  const prev = globalThis.TP.train;
  const realNow = Date.now;
  delete require.cache[require.resolve('../public/js/train.js')];
  require('../public/js/train.js');
  const F = globalThis.TP.train;
  let clock = 1_000_000;
  Date.now = () => clock;
  let calls = 0;
  let reply = { stations: [SEOUL], incomplete: 1 };
  globalThis.fetch = async () => { calls++; if (reply === 'fail') throw new Error('down'); return { ok: true, json: async () => reply }; };
  try {
    await F.load();
    assert.equal(F.incomplete(), 1);
    await F.load(); // 1분 전: 다시 받지 않는다
    assert.equal(calls, 1);
    clock += 61_000;
    reply = 'fail';
    await F.load(); // 다시 받기 실패: 받아 둔 표와 빠진 역 표시는 그대로, 실패한 것으로 보지 않는다
    assert.equal(calls, 2);
    assert.equal(F.incomplete(), 1);
    assert.equal(F.loadFailed(), false);
    assert.ok(F.stationOf({ name: '서울역' }));
    clock += 61_000;
    reply = { stations: [SEOUL, GIMCHEON] };
    await F.load(); // 서버가 다 채웠다
    assert.equal(calls, 3);
    assert.equal(F.incomplete(), 0);
    clock += 61_000;
    await F.load(); // 완전한 표는 더 받지 않는다
    assert.equal(calls, 3);
  } finally {
    Date.now = realNow;
    globalThis.TP.train = prev;
  }
});

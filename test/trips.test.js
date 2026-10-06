'use strict';
// trips.js(라우트/카드 요약)와 storage.duplicateTrip 테스트. 브라우저 전역(window.TP)에 붙는 스크립트라 최소 스텁을 만들어 Node에서 로드한다.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
require('../public/js/fare.js');
const TP = globalThis.TP;
TP.routing = { profileFor: () => 'car', haversine: () => 1000, peek: () => null, estimateRoute: () => ({ distance: 1, duration: 1, geometry: [], estimated: true }) };
require('../public/js/planner.js');
require('../public/js/storage.js');
require('../public/js/trips.js');

const T = TP.trips;
const S = TP.store;
const trip = (startDate, names) => ({
  id: 't1', name: '서울', startDate,
  days: names.map((day, i) => ({ id: 'd' + i, startTime: '09:00', items: day.map((n) => ({ id: 'i' + n, name: n })) })),
});

test('parseRoute: 빈 해시/#/는 메인, #/trip/<id>는 여행', () => {
  for (const h of ['', '#', '#/', '#/foo', '#/trip/', undefined, null]) assert.deepEqual(T.parseRoute(h), { name: 'main' }, String(h));
  assert.deepEqual(T.parseRoute('#/trip/abc123'), { name: 'trip', id: 'abc123' });
  assert.deepEqual(T.parseRoute('#/trip/abc123/'), { name: 'trip', id: 'abc123' });
  assert.deepEqual(T.parseRoute('#/trip/a%20b'), { name: 'trip', id: 'a b' });
  assert.deepEqual(T.parseRoute('#/trip/%E0%A4%A'), { name: 'main' }, '깨진 인코딩은 메인');
});

test('tripHash <-> parseRoute 왕복, canonicalHash', () => {
  for (const id of ['abc', 'a b/c', '한글']) assert.deepEqual(T.parseRoute(T.tripHash(id)), { name: 'trip', id });
  assert.equal(T.canonicalHash(''), '#/');
  assert.equal(T.canonicalHash('#'), '#/');
  assert.equal(T.canonicalHash('#/trip/x'), '#/trip/x');
});

test('dateRangeText: 기간/당일/날짜 미정', () => {
  assert.equal(T.dateRangeText(trip('2026-10-10', [[], []])), '10월 10일 (토) – 10월 11일 (일) · 2일');
  assert.equal(T.dateRangeText(trip('2026-10-10', [[]])), '10월 10일 (토) · 1일');
  assert.equal(T.dateRangeText(trip('', [[], [], []])), '날짜 미정 · 3일');
});

test('placePreview / placeCount', () => {
  assert.equal(T.placePreview(trip('', [[], []])), '아직 일정이 없어요');
  assert.equal(T.placePreview(trip('', [['경복궁', '광장시장'], ['DDP']])), '경복궁 · 광장시장 · DDP');
  assert.equal(T.placePreview(trip('', [['a', 'b', 'c'], ['d', 'e']])), 'a · b · c 외 2곳');
  assert.equal(T.placeCount(trip('', [['a', 'b'], ['c']])), 3);
});

test('costText: 조회 중이거나 일정이 없으면 생략', () => {
  assert.equal(T.costText({ items: 3, loadingLegs: 0, total: 67550 }), '약 67,550원');
  assert.equal(T.costText({ items: 3, loadingLegs: 1, total: 100 }), null);
  assert.equal(T.costText({ items: 0, loadingLegs: 0, total: 0 }), null);
  assert.equal(T.costText({ items: 2, loadingLegs: 0, total: 0 }), null, '0원은 생략');
  assert.equal(T.costText(null), null);
});

test('buildTrip: 캐시에 없는 구간은 loading (메인 화면은 이때 비용을 생략)', () => {
  const t = { id: 'x', name: 'n', startDate: '', days: [{ id: 'd', startTime: '09:00', items: [S.newItem({ name: 'a', lat: 37.5, lon: 127 }), S.newItem({ name: 'b', lat: 37.6, lon: 127.1 })] }] };
  const { totals } = TP.planner.buildTrip(t, S.state.settings);
  assert.ok(totals.loadingLegs > 0);
  assert.equal(T.costText(totals), null);
});

test('duplicateTrip: 새 id, 이름에 (사본), 원본은 그대로', () => {
  const src = S.newTrip('부산 여행', '2026-10-10', 2);
  src.days[0].items.push(S.newItem({ name: '해운대', lat: 35.1, lon: 129.1 }));
  const before = JSON.stringify(src);
  const dup = S.duplicateTrip(src);
  assert.equal(JSON.stringify(src), before);
  assert.equal(dup.name, '부산 여행 (사본)');
  assert.notEqual(dup.id, src.id);
  assert.notEqual(dup.days[0].id, src.days[0].id);
  assert.notEqual(dup.days[0].items[0].id, src.days[0].items[0].id);
  assert.equal(dup.days[0].items[0].name, '해운대');
  assert.equal(dup.startDate, '2026-10-10');
  dup.days[0].items[0].name = '바뀜';
  assert.equal(src.days[0].items[0].name, '해운대', '깊은 복사');
  const long = S.duplicateTrip({ ...src, name: 'x'.repeat(80) });
  assert.ok(long.name.length <= 80 && long.name.endsWith(' (사본)'));
});

test('exportJSON(tripId): 그 여행만 내보낸다', () => {
  S.state.trips = [S.newTrip('A', '', 1), S.newTrip('B', '', 1)];
  assert.equal(JSON.parse(S.exportJSON()).trips.length, 2);
  const one = JSON.parse(S.exportJSON(S.state.trips[1].id));
  assert.equal(one.trips.length, 1);
  assert.equal(one.trips[0].name, 'B');
});

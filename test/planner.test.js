'use strict';
// planner.js / storage.js 는 브라우저 전역(window.TP)에 붙는 스크립트라 최소 스텁을 만들어 Node에서 로드한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const fare = require('../public/js/fare.js');
const TP = globalThis.TP;

let route = null; // 테스트가 바꿔 끼우는 캐시 경로 (null = 아직 조회 전)
TP.routing = {
  profileFor: (m) => (m === 'walk' ? 'foot' : m === 'bike' ? 'bike' : m === 'transit' ? 'transit' : 'car'),
  haversine: () => 100000,
  peek: () => route,
  estimateRoute: () => ({ distance: 1000, duration: 60, geometry: [], estimated: true }),
};
require('../public/js/planner.js');
require('../public/js/storage.js');

const P = TP.planner;
const cfg = (people = 1) => ({ ...fare.DEFAULT_CONFIG, people });
const A = { lat: 37.55, lon: 126.97 };
const item = (o) => ({ id: 'b', name: 'B', lat: 35.1, lon: 129.0, stay: 60, cost: 0, parking: 0, modeIn: 'transit', transitIdx: null, legMin: null, legCost: null, ...o });
// 대중교통 조회 실패 후 자동차 경로로 대체된 상태 (서울 -> 부산 약 400km, 4시간 30분)
const carFallback = (km = 400, sec = 16200) => ({ distance: km * 1000, duration: sec, geometry: [], estimated: false, fallbackReason: '경로 없음' });

test('도시 간 대중교통 대체: 시간은 자동차 기준, 요금은 미정', () => {
  route = carFallback();
  const leg = P.computeLeg(A, item(), cfg(2), 540);
  assert.equal(leg.interCity, true);
  assert.equal(leg.durationMin, 270);
  assert.equal(leg.cost.unknown, true);
  assert.equal(leg.cost.total, 0);
  assert.equal(leg.cost.perPerson, 0);
  assert.deepEqual(leg.override, { min: false, cost: false });
});

test('도시 간 기준 이하면 기존 추정식(속도 + 오버헤드)', () => {
  route = carFallback(30, 2400);
  const leg = P.computeLeg(A, item(), cfg(), 540);
  assert.equal(leg.interCity, false);
  assert.equal(leg.cost.unknown, false);
  assert.equal(leg.durationMin, Math.ceil((30 / 22) * 60 + 10 - 1e-9));
  assert.ok(leg.cost.total > 0);
});

test('직접 입력: 시간은 소요시간, 요금은 대중교통 1인 x 인원', () => {
  route = carFallback();
  const leg = P.computeLeg(A, item({ legMin: 160, legCost: 59800 }), cfg(3), 540);
  assert.equal(leg.durationMin, 160);
  assert.equal(leg.cost.perPerson, 59800);
  assert.equal(leg.cost.total, 59800 * 3);
  assert.equal(leg.cost.unknown, false);
  assert.deepEqual(leg.override, { min: true, cost: true });
});

test('직접 입력: 시간만 넣으면 요금은 여전히 미정', () => {
  route = carFallback();
  const leg = P.computeLeg(A, item({ legMin: 0 }), cfg(), 540);
  assert.equal(leg.durationMin, 0);
  assert.equal(leg.cost.unknown, true);
  assert.deepEqual(leg.override, { min: true, cost: false });
});

test('직접 입력: 택시는 차량 1대 총액, 자가용은 연료·주차를 대체', () => {
  route = { distance: 10000, duration: 1200, geometry: [], estimated: false };
  const taxi = P.computeLeg(A, item({ modeIn: 'taxi', legCost: 30000 }), cfg(3), 540);
  assert.equal(taxi.cost.total, 30000);
  assert.equal(taxi.cost.perPerson, 10000);
  const car = P.computeLeg(A, item({ modeIn: 'car', parking: 5000, legCost: 12000 }), cfg(2), 540);
  assert.equal(car.cost.total, 12000);
  assert.equal(car.cost.fuel, 0);
  assert.equal(car.cost.parking, 0);
  const walk = P.computeLeg(A, item({ modeIn: 'walk', legCost: 1000 }), cfg(2), 540);
  assert.equal(walk.cost.total, 2000);
});

test('카카오 실경로에 요금이 없으면 거리 추정 대신 미정 (직접 입력하면 반영)', () => {
  const r = (o) => ({ type: 'BUS_AND_SUBWAY', totalDistance: 60000, totalTime: 4800, transfers: 1, fare: null, fareMin: null, fareMax: null, steps: [], ...o });
  const withRoutes = (routes) => ({ distance: 60000, duration: 4800, geometry: [], estimated: false, transit: { landingURL: null, routes, defaultIdx: 0 } });
  route = withRoutes([r()]);
  const leg = P.computeLeg(A, item(), cfg(2), 540);
  assert.equal(leg.noFare, true);
  assert.equal(leg.cost.unknown, true);
  assert.equal(leg.cost.total, 0);
  assert.equal(leg.durationMin, 80); // 시간은 카카오 값 그대로
  const fixed = P.computeLeg(A, item({ legCost: 17000 }), cfg(2), 540);
  assert.equal(fixed.cost.unknown, false);
  assert.equal(fixed.cost.total, 34000);
  route = withRoutes([r({ fare: 1500 })]);
  assert.equal(P.computeLeg(A, item(), cfg(), 540).noFare, false);
  route = withRoutes([r({ fareMin: 17500, fareMax: 20500 })]);
  const ranged = P.computeLeg(A, item(), cfg(), 540);
  assert.equal(ranged.noFare, false);
  assert.equal(ranged.cost.total, 20500); // 기본: 최대값
});

test('조회 중(loading)에는 도시 간으로 판단하지 않는다', () => {
  route = null;
  const leg = P.computeLeg(A, item(), cfg(), 540);
  assert.equal(leg.loading, true);
  assert.equal(leg.interCity, false);
});

test('buildDay: 미정 구간은 합계에서 제외하고 개수를 센다, 직접 입력은 도착 시각에 반영', () => {
  route = carFallback();
  const day = (o) => ({ startTime: '09:00', items: [item({ id: 'a', modeIn: null, stay: 30 }), item(o)] });
  const s = fare.DEFAULT_CONFIG;
  const settings = { ...s, people: 1 };
  const d1 = P.buildDay(day({}), 0, settings);
  assert.equal(d1.stats.unknownCostLegs, 1);
  assert.equal(d1.stats.transport, 0);
  assert.equal(d1.rows[1].arrival, 540 + 30 + 270);
  const d2 = P.buildDay(day({ legMin: 160, legCost: 59800 }), 0, settings);
  assert.equal(d2.stats.unknownCostLegs, 0);
  assert.equal(d2.stats.transport, 59800);
  assert.equal(d2.rows[1].arrival, 540 + 30 + 160);
  const trip = P.buildTrip({ days: [day({})] }, settings);
  assert.equal(trip.totals.unknownCostLegs, 1);
});

test('normItem: legMin/legCost 검증, 이전 데이터는 null', () => {
  const base = { name: 'x', lat: 1, lon: 2 };
  const old = TP.store.normItem(base);
  assert.equal(old.legMin, null);
  assert.equal(old.legCost, null);
  const ok = TP.store.normItem({ ...base, legMin: 160, legCost: 59800 });
  assert.equal(ok.legMin, 160);
  assert.equal(ok.legCost, 59800);
  for (const bad of [-1, 1.5, '30', NaN, 4321]) assert.equal(TP.store.normItem({ ...base, legMin: bad }).legMin, null);
  for (const bad of [-1, 2.5, '100', 1e8 + 1]) assert.equal(TP.store.normItem({ ...base, legCost: bad }).legCost, null);
});

test('legCost: override는 unknown보다 우선', () => {
  const c = fare.legCost({ mode: 'transit', distanceM: 400000, unknown: true, override: 1000 }, cfg(2));
  assert.equal(c.unknown, false);
  assert.equal(c.total, 2000);
});

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

// ---- 고정 시작/종료 시각 (TP-009) ----
// 이동 시간을 20분으로 고정해 도착 예정을 계산하기 쉽게 한다 (직접 입력 legMin)
const fixedDay = (items, startTime = '09:00') => ({ startTime, items });
const first = (o) => item({ id: 'a', modeIn: null, stay: 30, ...o }); // 09:00 도착, 09:30 출발
const second = (o) => item({ id: 'b', legMin: 20, stay: 60, ...o }); // 09:50 도착 예정
const build = (items, startTime) => P.buildDay(fixedDay(items, startTime), 0, { ...fare.DEFAULT_CONFIG, people: 1 });

test('고정 시각 없음: 기존 연쇄 계산 그대로, 여유/늦음 없음', () => {
  const d = build([first(), second()]);
  assert.equal(d.rows[0].arrival, 540);
  assert.equal(d.rows[0].departure, 570);
  assert.equal(d.rows[1].est, 590);
  assert.equal(d.rows[1].arrival, 590);
  assert.equal(d.rows[1].departure, 650);
  for (const r of d.rows) assert.deepEqual([r.waitMin, r.lateMin, r.endLateMin], [0, 0, 0]);
  assert.equal(d.stats.waitMin, 0);
  assert.equal(d.stats.lateCount, 0);
  assert.equal(d.stats.end, 650);
});

test('고정 시작이 도착 예정보다 늦으면 여유 시간만큼 기다리고 뒤 일정이 밀린다', () => {
  const d = build([first(), second({ fixedStart: '10:30' }), item({ id: 'c', legMin: 10, stay: 20 })]);
  const r = d.rows[1];
  assert.equal(r.est, 590);
  assert.equal(r.arrival, 630);
  assert.equal(r.waitMin, 40);
  assert.equal(r.lateMin, 0);
  assert.equal(r.departure, 690);
  assert.equal(d.rows[2].arrival, 700);
  assert.equal(d.stats.waitMin, 40);
  assert.equal(d.stats.lateCount, 0);
});

test('고정 시작보다 늦게 도착하면 늦음 (시작은 도착 시각)', () => {
  const d = build([first(), second({ fixedStart: '09:30' })]);
  const r = d.rows[1];
  assert.equal(r.arrival, 590);
  assert.equal(r.lateMin, 20);
  assert.equal(r.waitMin, 0);
  assert.equal(r.departure, 650);
  assert.equal(d.stats.lateCount, 1);
});

test('고정 종료 + 체류: 시작 = 종료 - 체류로 역산해 여유 표시', () => {
  const d = build([first(), second({ fixedEnd: '11:00' })]); // 체류 60분 -> 목표 시작 10:00
  const r = d.rows[1];
  assert.equal(r.est, 590);
  assert.equal(r.arrival, 600);
  assert.equal(r.waitMin, 10);
  assert.equal(r.departure, 660);
  assert.equal(r.endLateMin, 0);
});

test('고정 종료 + 체류: 역산한 시작보다 늦게 도착하면 늦음, 종료 시각은 유지', () => {
  const d = build([first(), second({ fixedEnd: '10:30' })]); // 목표 시작 09:30, 도착 예정 09:50
  const r = d.rows[1];
  assert.equal(r.arrival, 590);
  assert.equal(r.lateMin, 20);
  assert.equal(r.departure, 630);
  assert.equal(d.stats.lateCount, 1);
});

test('첫 장소: 고정 종료만 있으면 종료 - 체류에 시작', () => {
  const r = build([first({ fixedEnd: '10:00' })], '07:00').rows[0]; // 체류 30분
  assert.equal(r.arrival, 570);
  assert.equal(r.departure, 600);
  assert.deepEqual([r.waitMin, r.lateMin], [0, 0]);
});

test('고정 시작과 종료 모두', () => {
  const d = build([first(), second({ fixedStart: '10:00', fixedEnd: '11:30' })]);
  const r = d.rows[1];
  assert.equal(r.arrival, 600);
  assert.equal(r.waitMin, 10);
  assert.equal(r.departure, 690);
});

test('고정 종료가 도착보다 이르면 종료 지연 경고, 출발은 도착 시각', () => {
  const d = build([first(), second({ fixedEnd: '09:40' })]);
  const r = d.rows[1];
  assert.equal(r.arrival, 590);
  assert.equal(r.lateMin, 70); // 목표 시작 08:40 (09:40 - 60분)
  assert.equal(r.departure, 590);
  assert.equal(r.endLateMin, 10);
  assert.equal(d.stats.lateCount, 1);
});

test('첫 장소: 고정 시작이 없으면 day.startTime, 있으면 고정 시작 (여유/늦음 없음)', () => {
  assert.equal(build([first()], '10:15').rows[0].arrival, 615);
  const r = build([first({ fixedStart: '08:00' })], '10:15').rows[0];
  assert.equal(r.arrival, 480);
  assert.equal(r.departure, 510);
  assert.deepEqual([r.waitMin, r.lateMin], [0, 0]);
});

test('고정 시각이 있어도 구간 계산은 앞 장소의 실제 출발을 쓴다 (택시 심야할증 시각)', () => {
  route = { distance: 10000, duration: 1200, geometry: [], estimated: false };
  const dayItems = (fs) => [first({ fixedStart: fs, stay: 0 }), item({ id: 'b', modeIn: 'taxi', stay: 10 })];
  const day = build(dayItems('21:50'), '09:00');
  const noon = build(dayItems(null), '09:00');
  assert.ok(day.rows[1].leg.cost.total >= noon.rows[1].leg.cost.total);
});

test('normItem: 고정 시각 검증', () => {
  const base = { name: 'x', lat: 1, lon: 2 };
  const old = TP.store.normItem(base);
  assert.equal(old.fixedStart, null);
  assert.equal(old.fixedEnd, null);
  const ok = TP.store.normItem({ ...base, fixedStart: '09:30', fixedEnd: '11:00' });
  assert.deepEqual([ok.fixedStart, ok.fixedEnd], ['09:30', '11:00']);
  for (const bad of ['', '9:30', '24:00', '09:60', 930, null, 'abc']) {
    const n = TP.store.normItem({ ...base, fixedStart: bad, fixedEnd: bad });
    assert.deepEqual([n.fixedStart, n.fixedEnd], [null, null]);
  }
  // 종료 <= 시작이면 종료를 버린다
  assert.equal(TP.store.normItem({ ...base, fixedStart: '10:00', fixedEnd: '10:00' }).fixedEnd, null);
  assert.equal(TP.store.normItem({ ...base, fixedStart: '10:00', fixedEnd: '09:00' }).fixedEnd, null);
  assert.equal(TP.store.normItem({ ...base, fixedStart: '10:00', fixedEnd: '09:00' }).fixedStart, '10:00');
  // 시작 없이 종료만 있으면 그대로
  assert.equal(TP.store.normItem({ ...base, fixedEnd: '09:00' }).fixedEnd, '09:00');
});

test('legColor: 전체 표시면 일차 색, 한 일차만 보이면 구간 순서대로 돌려 쓴다', () => {
  const { legColor, LEG_COLORS } = TP.planner;
  assert.equal(legColor('#123456', 3, true), '#123456');
  assert.equal(legColor('#123456', 0, false), LEG_COLORS[0]);
  assert.equal(legColor('#123456', LEG_COLORS.length, false), LEG_COLORS[0]);
  // 이웃한 구간은 항상 다른 색, 팔레트에 중복 없음
  for (let i = 0; i < LEG_COLORS.length * 2; i++) assert.notEqual(legColor('#000', i, false), legColor('#000', i + 1, false));
  assert.equal(new Set(LEG_COLORS).size, LEG_COLORS.length);
});

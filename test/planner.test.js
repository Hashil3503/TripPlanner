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

let hav = 100000; // 테스트가 바꾸는 직선거리(m)
let route = null; // 테스트가 바꿔 끼우는 캐시 경로 (null = 아직 조회 전)
TP.routing = {
  profileFor: (m) => (m === 'walk' ? 'foot' : m === 'bike' ? 'bike' : m === 'transit' ? 'transit' : 'car'),
  haversine: () => hav,
  peek: () => route,
  estimateRoute: () => ({ distance: 1000, duration: 60, geometry: [], estimated: true }),
  NO_ROUTE_REASON: '대중교통 경로 없음(도시 간 이동·너무 가까운 거리 등)',
};
require('../public/js/planner.js');
require('../public/js/storage.js');

const P = TP.planner;
const cfg = (people = 1) => ({ ...fare.DEFAULT_CONFIG, people });
const A = { lat: 37.55, lon: 126.97 };
const item = (o) => ({ id: 'b', name: 'B', lat: 35.1, lon: 129.0, stay: 60, cost: 0, parking: 0, modeIn: 'transit', transitIdx: null, legMin: null, legCost: null, ...o });
// 대중교통 조회 실패 후 대체 경로(도보/자동차) 상태 (서울 -> 부산 약 400km, 4시간 30분)
const carFallback = (km = 400, sec = 16200) => ({ distance: km * 1000, duration: sec, geometry: [], estimated: false, fallbackReason: '경로 없음' });

test('대중교통 대체: 거리와 무관하게 대체 경로의 시간을 쓰고 요금은 미정', () => {
  for (const [km, sec] of [[400, 16200], [30, 2400]]) {
    route = carFallback(km, sec);
    const leg = P.computeLeg(A, item(), cfg(2), 540);
    assert.equal(leg.durationMin, Math.ceil(sec / 60));
    assert.equal(leg.cost.unknown, true);
    assert.equal(leg.cost.total, 0);
    assert.equal(leg.cost.perPerson, 0);
    assert.deepEqual(leg.override, { min: false, cost: false });
  }
});

test('대중교통 대체: 가까우면 자동차 기준 + nearWalk, 멀면 nearWalk 아님', () => {
  route = carFallback(3, 600);
  hav = 1500;
  assert.equal(P.computeLeg(A, item(), cfg(), 540).nearWalk, true);
  hav = 2000;
  assert.equal(P.computeLeg(A, item(), cfg(), 540).nearWalk, true); // 경계 포함
  hav = 2001;
  assert.equal(P.computeLeg(A, item(), cfg(), 540).nearWalk, false);
  hav = 100000;
  assert.equal(P.computeLeg(A, item(), cfg(), 540).nearWalk, false);
});

test('noRoute: 카카오가 경로 없음이라고 답한 경우만 true', () => {
  route = { ...carFallback(), fallbackReason: TP.routing.NO_ROUTE_REASON };
  assert.equal(P.computeLeg(A, item(), cfg(), 540).noRoute, true);
  route = { ...carFallback(), fallbackReason: '대중교통 정보를 불러오지 못했어요 (서버 연결 실패)' };
  assert.equal(P.computeLeg(A, item(), cfg(), 540).noRoute, false);
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

test('조회 중(loading)에는 경로 없음으로 판단하지 않고 미정 구간으로 세지 않는다', () => {
  route = null;
  const leg = P.computeLeg(A, item(), cfg(), 540);
  assert.equal(leg.loading, true);
  assert.equal(leg.noRoute, false);
  const d = P.buildDay({ startTime: '09:00', items: [item({ id: 'a', modeIn: null, stay: 30 }), item()] }, 0, { ...fare.DEFAULT_CONFIG, people: 1 });
  assert.equal(d.stats.loadingLegs, 1);
  assert.equal(d.stats.unknownCostLegs, 0);
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

test('자가용: 경로의 고속도로 거리로 통행료 추정 (TP-004)', () => {
  route = { distance: 10000, duration: 1200, geometry: [], estimated: false, tollKm: 100 };
  const leg = P.computeLeg(A, item({ modeIn: 'car' }), cfg(), 540);
  assert.equal(leg.cost.toll, 5300);
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

test('stepName: 버스는 묶인 노선 번호를 모두 보여준다', () => {
  assert.equal(P.stepName({ type: 'BUS', guidance: '', vehicles: ['6015', '6701', 'N6701(심야)'] }), '6015·6701·N6701(심야)');
  assert.equal(P.stepName({ type: 'SUBWAY', guidance: '', vehicles: ['1호선', '4호선', '공항철도'] }), '1호선·4호선');
});

test('buildTrip: 마지막 장소 체류가 자정을 넘기면 다음 날 맨 앞에 이어진 체류 행을 붙이고 그 종료 시각에 시작한다', () => {
  route = { distance: 1000, duration: 600, geometry: [] };
  const hotel = { id: 'h', name: '숙소', lat: 35.1, lon: 129.0, stay: 720, cost: 10000, parking: 0, category: 'stay' };
  const cafe = { id: 'c', name: '카페', lat: 35.2, lon: 129.1, stay: 60, cost: 0, parking: 0, category: 'cafe', modeIn: 'walk' };
  const trip = { days: [{ startTime: '21:00', items: [hotel] }, { startTime: '09:00', items: [cafe] }] };
  const m = P.buildTrip(trip, cfg());
  const d2 = m.days[1];
  assert.equal(d2.rows.length, 2);
  assert.equal(d2.rows[0].carry, true);
  assert.equal(d2.rows[0].departure, 21 * 60 + 720 - 1440); // 09:00
  assert.equal(d2.rows[1].leg.from, hotel);
  assert.equal(d2.stats.extra, 0); // 숙소 비용은 전날에만
  assert.equal(m.totals.items, 2);
  // 다음 날 첫 장소가 이미 같은 숙소면 중복으로 붙이지 않는다
  const t2 = { days: [{ startTime: '21:00', items: [hotel] }, { startTime: '09:00', items: [{ ...hotel, id: 'h2' }, cafe] }] };
  assert.equal(P.buildTrip(t2, cfg()).days[1].rows[0].carry, undefined);
  route = null;
});

// ---- 열차·버스(TP-018-1) ----
const svc = (dep, arr, o) => ({ kind: 'train', type: 'KTX', grade: null, no: '105', dep, arr, ...o });
const hubItem = (mode, o) => item({ id: 'b', modeIn: mode, stay: 60, ...o });

test('열차: 편이 있으면 소요시간은 도착-출발, 요금은 직접 입력 1인 x 인원, 거리는 직선거리 x 우회계수', () => {
  route = null; // 경로를 조회하지 않는다
  const leg = P.computeLeg(A, hubItem('train', { legService: svc(600, 730), legCost: 59800 }), cfg(2), 600);
  assert.equal(leg.mode, 'train');
  assert.equal(leg.loading, false);
  assert.equal(leg.durationMin, 130);
  assert.equal(leg.distance, 100000 * fare.DEFAULT_CONFIG.est.detour);
  assert.equal(leg.cost.perPerson, 59800);
  assert.equal(leg.cost.total, 59800 * 2);
  assert.equal(leg.noService, false);
  assert.equal(leg.curve, true);
  // 편 소요 시간은 legMin 직접 입력을 따르지 않는다
  assert.equal(P.computeLeg(A, hubItem('train', { legService: svc(600, 730), legMin: 5 }), cfg(), 600).durationMin, 130);
});

test('열차: 요금 입력이 없으면 요금 미정, 외부(조회) 요금·편을 넘기면 그대로 반영', () => {
  const leg = P.computeLeg(A, hubItem('train', { legService: svc(600, 730) }), cfg(3), 600);
  assert.equal(leg.cost.unknown, true);
  assert.equal(leg.cost.total, 0);
  const api = P.computeLeg(A, hubItem('train'), cfg(3), 600, { service: svc(600, 700), fare: 30000 });
  assert.equal(api.durationMin, 100);
  assert.equal(api.cost.total, 90000);
});

test('열차·버스: 자정을 넘기는 편은 다음 날 도착으로 계산', () => {
  assert.equal(P.computeLeg(A, hubItem('train', { legService: svc(1380, 60) }), cfg(), 1380).durationMin, 120);
  route = { distance: 300000, duration: 9000, geometry: [], estimated: false };
  const bus = P.computeLeg(A, hubItem('bus', { legService: svc(1410, 30, { kind: 'express', grade: '심야우등', no: null, type: null }) }), cfg(), 1410);
  assert.equal(bus.durationMin, 60);
  assert.equal(bus.distance, 100000 * fare.DEFAULT_CONFIG.est.detour); // 버스도 노선 경로를 몰라 직선거리 x 우회계수 (도로 경로 무시)
  route = null;
});

test('열차·버스: 편이 없으면 시간 0(미정)·요금 미정, 경로를 조회하지 않는다', () => {
  route = null;
  for (const mode of ['train', 'bus']) {
    const leg = P.computeLeg(A, hubItem(mode), cfg(2), 600);
    assert.equal(leg.noService, true);
    assert.equal(leg.durationMin, 0);
    assert.equal(leg.loading, false);
    assert.equal(leg.cost.unknown, true);
    assert.equal(leg.distance, 100000 * fare.DEFAULT_CONFIG.est.detour);
  }
});

test('buildDay: 편 출발 시각이 앞 장소의 종료 시각 - 일찍 도착하면 대기, 도착은 출발 + 소요', () => {
  const d = build([first(), hubItem('train', { legService: svc(600, 730) })]); // 역 도착 09:00, 출발 10:00 -> 체류 시간과 상관없이 60분 대기
  const r0 = d.rows[0];
  assert.equal(r0.departure, 600);
  assert.equal(r0.svcWaitMin, 60);
  assert.equal(r0.svcMissMin, 0);
  assert.deepEqual(r0.anchor, { dep: 600, mode: 'train' });
  assert.equal(d.rows[1].leg.depMin, 600);
  assert.equal(d.rows[1].arrival, 730);
  assert.equal(d.stats.travelMin, 130);
});

test('buildDay: 출발 시각이 지난 뒤 도착하면 놓침, 이후 시각은 그 편 기준으로 계속 계산', () => {
  const d = build([first(), hubItem('bus', { legService: svc(555, 700, { kind: 'express' }) })]); // 09:00 도착, 체류 30분, 버스 09:15 출발
  // 첫 장소는 도착(=시작)이 09:00이라 놓치지 않고 체류가 잘린다
  assert.equal(d.rows[0].svcMissMin, 0);
  assert.equal(d.rows[0].departure, 555);
  const d2 = build([first({ fixedStart: '09:30' }), hubItem('bus', { legService: svc(555, 700) })]);
  assert.equal(d2.rows[0].svcMissMin, 15);
  assert.equal(d2.rows[0].departure, 570);
  assert.equal(d2.rows[1].arrival, 700); // 출발 09:15 기준
});

test('buildDay: 편이 정해진 열차 앞 장소의 fixedEnd는 무시, 편이 없으면 평소 계산 (시간 0)', () => {
  const d = build([first({ fixedEnd: '09:20' }), hubItem('train', { legService: svc(600, 700) })]);
  assert.equal(d.rows[0].departure, 600);
  assert.equal(d.rows[0].endLateMin, 0);
  const none = build([first(), hubItem('train')]); // 편 미정: 앞 장소는 닻이 없고 다음 장소는 역 출발 시각에 도착
  assert.equal(none.rows[0].anchor, null);
  assert.equal(none.rows[1].arrival, 570);
  assert.equal(none.rows[1].leg.durationMin, 0);
});

test('buildTrip: 열차·버스 비용은 byMode에 따로 집계', () => {
  const trip = { days: [{ startTime: '09:00', items: [first(), hubItem('train', { legService: svc(600, 700), legCost: 50000 })] }] };
  const m = P.buildTrip(trip, cfg(2));
  assert.equal(m.totals.byMode.train, 100000);
  assert.equal(m.totals.byMode.bus, 0);
});

test('normItem: 열차·버스 편과 hub를 검증해 보존', () => {
  const base = { name: 'x', lat: 1, lon: 2 };
  const n = TP.store.normItem({ ...base, modeIn: 'train', hub: 'train', legService: { kind: 'bus', type: ' KTX ', no: '105', grade: '우등', dep: 600, arr: 730 } });
  assert.deepEqual(n.legService, { kind: 'train', type: 'KTX', grade: null, no: '105', dep: 600, arr: 730 });
  assert.equal(n.hub, 'train');
  const b = TP.store.normItem({ ...base, modeIn: 'bus', legService: { kind: 'express', grade: '우등', type: 'KTX', dep: 0, arr: 1439 } });
  assert.deepEqual(b.legService, { kind: 'express', type: null, grade: '우등', no: null, dep: 0, arr: 1439 });
  assert.equal(TP.store.normItem({ ...base, modeIn: 'bus', legService: { kind: 'etc', dep: 1, arr: 2 } }).legService.kind, null);
  assert.equal(TP.store.normItem({ ...base, modeIn: 'bus', legService: { dep: 1, arr: 2, grade: 'x'.repeat(50) } }).legService.grade.length, 20);
  for (const bad of [{ dep: 600 }, { dep: 1440, arr: 1 }, { dep: -1, arr: 1 }, { dep: 1.5, arr: 2 }, { dep: '600', arr: 700 }, null, 'x']) {
    assert.equal(TP.store.normItem({ ...base, modeIn: 'train', legService: bad }).legService, null);
  }
  // 열차·버스가 아닌 이동수단이면 편은 버린다
  assert.equal(TP.store.normItem({ ...base, modeIn: 'walk', legService: { dep: 1, arr: 2 } }).legService, null);
  assert.equal(TP.store.normItem({ ...base, hub: 'plane' }).hub, null);
  assert.equal(TP.store.newItem({}).legService, null);
});

// ---- 열차 시간표 조회 연동 (TP-018-1 3단계) ----
const trip = (no, dep, arr, charge = 50000) => ({ no, type: 'KTX', dep, arr, charge });
const TRIPS = [trip('101', 480, 600, 40000), trip('103', 570, 700, 50000), trip('105', 600, 730, 60000)]; // 08:00, 09:30, 10:00
const lookupDay = (items) => P.buildDay(fixedDay(items), 0, cfg(2), null, '20261125');
const withLookup = (lk, fn) => {
  TP.train = { peek: () => lk };
  try { return fn(); } finally { delete TP.train; }
};
const OK = { state: 'ok', trips: TRIPS };

test('열차 기본 편: 역 도착 + 체류 이후 첫 열차, 요금은 API 1인 요금 x 인원, 닻도 기본 편 출발에 맞춘다', () => {
  withLookup(OK, () => {
    // 09:00 도착 + 체류 30분 = 09:30 -> 103편(09:30). 체류가 31분이면 105편
    const m = lookupDay([first(), hubItem('train')]);
    const leg = m.rows[1].leg;
    assert.equal(leg.serviceDefault, true);
    assert.equal(leg.service.no, '103');
    assert.equal(leg.apiFare, true);
    assert.equal(leg.cost.total, 100000);
    assert.deepEqual(m.rows[0].anchor, { dep: 570, mode: 'train' });
    assert.equal(m.rows[0].departure, 570);
    assert.equal(m.rows[1].arrival, 700); // dep + 소요
    assert.equal(lookupDay([first({ stay: 31 }), hubItem('train')]).rows[1].leg.service.no, '105');
  });
});

test('열차 기본 편: 이후 출발 열차가 없으면 편 미정(none-left), 앞 장소 닻 없음', () => {
  withLookup(OK, () => {
    const m = lookupDay([first({ stay: 200 }), hubItem('train')]);
    assert.equal(m.rows[1].leg.noService, true);
    assert.deepEqual(m.rows[1].leg.lookup, { state: 'none', reason: 'none-left' });
    assert.equal(m.rows[0].anchor, null);
  });
});

test('열차 저장된 편: 시간표에 있으면 요금만 맞추고 편은 그대로, 없으면 svcNotListed (자동 교체 없음)', () => {
  withLookup(OK, () => {
    const hit = lookupDay([first(), hubItem('train', { legService: svc(600, 730) })]).rows[1].leg;
    assert.equal(hit.serviceDefault, false);
    assert.equal(hit.svcNotListed, false);
    assert.equal(hit.apiFare, true);
    assert.equal(hit.cost.perPerson, 60000);
    // 직접 입력한 요금이 우선
    const own = lookupDay([first(), hubItem('train', { legService: svc(600, 730), legCost: 1000 })]).rows[1].leg;
    assert.equal(own.cost.perPerson, 1000);
    assert.equal(own.apiFare, false);
    const miss = lookupDay([first(), hubItem('train', { legService: svc(615, 730) })]).rows[1].leg;
    assert.equal(miss.svcNotListed, true);
    assert.equal(miss.service.dep, 615);
    assert.equal(miss.cost.unknown, true);
  });
});

test('열차 조회: loading 이면 구간도 loading, 기간 밖이면 period 이유와 함께 편 미정', () => {
  withLookup({ state: 'loading' }, () => assert.equal(lookupDay([first(), hubItem('train')]).rows[1].leg.loading, true));
  withLookup({ state: 'none', reason: 'period' }, () => {
    const leg = lookupDay([first(), hubItem('train')]).rows[1].leg;
    assert.equal(leg.loading, false);
    assert.equal(leg.noService, true);
    assert.equal(leg.lookup.reason, 'period');
  });
  // 날짜가 없으면(ymd 없음) 조회하지 않는다
  withLookup(OK, () => assert.equal(P.buildDay(fixedDay([first(), hubItem('train')]), 0, cfg()).rows[1].leg.noService, true));
});

test('buildDay: 편 출발이 도착 후 10분 이내면 svcTight, 11분이면 아니고, 놓치면 놓침 경고만', () => {
  const at = (dep) => build([first(), hubItem('train', { legService: svc(dep, dep + 100) })]).rows[0]; // 역 도착 09:00 (540)
  assert.equal(at(545).svcTight, true);
  assert.equal(at(550).svcTight, true);
  assert.equal(at(540).svcTight, true);
  assert.equal(at(551).svcTight, false);
  const missed = at(530);
  assert.equal(missed.svcTight, false);
  assert.equal(missed.svcMissMin, 10);
  assert.equal(P.TIGHT_TRANSFER_MIN, 10);
});

test('busGrades: 종류별 TAGO 등급 목록, 종류 미선택이면 비어 있다', () => {
  const g = TP.planner.busGrades;
  assert.deepEqual(g('express'), ['일반', '고속', '우등', '프리미엄', '일반심야', '심야고속', '심야우등', '심야프리미엄']);
  assert.deepEqual(g('intercity'), ['일반', '우등', '프리미엄', '심야일반', '심야우등', '심야프리', '주말프리', '주말심프']);
  assert.deepEqual(g(''), []);
  assert.deepEqual(g(null), []);
});

test('fmtStay / parseStay: 분과 HH:MM(00:00~24:00) 변환 및 잘못된 형식 거부', () => {
  const { fmtStay, parseStay } = TP.fmt;
  assert.equal(fmtStay(0), '00:00');
  assert.equal(fmtStay(90), '01:30');
  assert.equal(fmtStay(1440), '24:00');
  assert.equal(fmtStay(-10), '00:00');
  assert.equal(fmtStay(2000), '24:00');
  assert.equal(parseStay(''), 0);
  assert.equal(parseStay('  '), 0);
  assert.equal(parseStay('01:30'), 90);
  assert.equal(parseStay('1:30'), 90);
  assert.equal(parseStay('00:00'), 0);
  assert.equal(parseStay('24:00'), 1440);
  for (const bad of ['24:01', '25:00', '1:60', '90', '0130', 'abc', '-1:00']) {
    assert.equal(parseStay(bad), null, `expected null for ${bad}`);
  }
});

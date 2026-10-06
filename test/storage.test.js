'use strict';
// storage.js 는 브라우저 전역(window.TP)에 붙는 스크립트라 최소 스텁(메모리 localStorage)을 만들어 Node에서 로드한다.
const test = require('node:test');
const assert = require('node:assert/strict');

const mem = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
};
require('../public/js/fare.js');
require('../public/js/storage.js');
require('../public/js/sample.js');
const S = globalThis.TP.store;

const GUEST_KEY = 'tripplanner.state.v1';
const CLEANUP_KEY = 'tripplanner.cleanup.autoTrip';
const item = (name) => ({ id: 'i' + name, name, lat: 37.5, lon: 127, category: 'sight', stay: 60, memo: '', cost: 0, parking: 0, modeIn: null });
const placeholder = (id = 'ph') => ({ id, name: '새 여행', startDate: '', days: [{ id: 'd', startTime: '09:00', items: [] }] });
const real = (id = 'real') => ({ id, name: '부산 여행', startDate: '2026-10-01', days: [{ id: 'd1', startTime: '09:00', items: [item('해운대')] }] });
const seed = (obj) => mem.set(GUEST_KEY, JSON.stringify(obj));
const reset = () => mem.clear();

test('isPlaceholder: 이름 새 여행 + 날짜 없음 + 1일 + 일정 0개만 해당', () => {
  assert.equal(S.isPlaceholder(placeholder()), true);
  assert.equal(S.isPlaceholder(S.newTrip('새 여행', '', 1)), true);
  assert.equal(S.isPlaceholder({ ...placeholder(), startDate: '2026-10-01' }), false, '날짜가 있으면 자리표시가 아니다');
  assert.equal(S.isPlaceholder({ ...placeholder(), name: '제주 여행' }), false);
  assert.equal(S.isPlaceholder({ ...placeholder(), days: [...placeholder().days, { id: 'd2', items: [] }] }), false, '2일이면 아니다');
  assert.equal(S.isPlaceholder({ ...placeholder(), days: [{ id: 'd', items: [item('a')] }] }), false, '일정이 있으면 아니다');
  assert.equal(S.isPlaceholder(null), false);
  assert.equal(S.isPlaceholder(TP_sample()), false);
});
const TP_sample = () => globalThis.TP.sample.create();

test('load: 저장된 것이 없으면 여행 0개, 샘플을 만들지 않는다', () => {
  reset();
  S.load();
  assert.equal(S.state.trips.length, 0);
  assert.equal(S.state.currentTripId, null);
  assert.equal(S.currentTrip(), null);
  assert.equal(S.currentDay(), null);
});

test('load: 자리표시 여행과 손대지 않은 샘플은 정리하고 진짜 여행만 남긴다', () => {
  reset();
  seed({ trips: [placeholder(), TP_sample(), real()], currentTripId: 'ph', dayIndex: 3, settings: {} });
  S.load();
  assert.deepEqual(S.state.trips.map((t) => t.id), ['real']);
  assert.equal(S.state.currentTripId, 'real');
  assert.equal(S.state.dayIndex, 0);
  const saved = JSON.parse(mem.get(GUEST_KEY));
  assert.deepEqual(saved.trips.map((t) => t.id), ['real'], '정리 결과를 저장한다');
});

test('load: 정리를 마친 뒤 직접 만든 샘플은 다시 로드해도 남는다', () => {
  reset();
  S.load(); // 정리 완료 표시
  assert.equal(mem.get(CLEANUP_KEY), '1');
  const sample = TP_sample();
  seed({ trips: [sample], currentTripId: sample.id });
  S.load();
  assert.equal(S.state.trips.length, 1);
  assert.equal(S.isSample(S.state.trips[0]), true);
});

test('load: 저장된 빈 목록(trips: [])은 그대로 비어 있다', () => {
  reset();
  mem.set(CLEANUP_KEY, '1');
  seed({ trips: [], currentTripId: null, dayIndex: 0, settings: {} });
  S.load();
  assert.equal(S.state.trips.length, 0);
  assert.equal(S.currentTrip(), null);
});

test('빈 상태 저장 후 다시 불러와도 비어 있고, 사용자 캐시도 빈 목록을 인정한다', () => {
  reset();
  S.load();
  S.saveNow();
  S.load();
  assert.equal(S.state.trips.length, 0);
  mem.set('tripplanner.state.v1.user.kim', JSON.stringify({ trips: [], currentTripId: null }));
  assert.equal(S.useUserCache('kim'), true);
  assert.equal(S.state.trips.length, 0);
  assert.equal(S.useUserCache('nobody'), false);
  S.load(); // 이후 테스트를 위해 게스트 키로 복귀
});

test('loadFromServer: 서버 여행이 0개면 빈 상태 (새 여행을 만들지 않는다)', () => {
  reset();
  S.loadFromServer('kim', [], null);
  assert.equal(S.state.trips.length, 0);
  assert.equal(S.state.currentTripId, null);
  S.load();
});

test('todayYmd: 이 기기의 로컬 날짜 형식', () => {
  assert.match(S.todayYmd(), /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date();
  assert.equal(S.todayYmd(), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
});

test('daySpan: 시작~종료 일수 (월/연 경계, 윤년, 30일 제한 판단)', () => {
  assert.equal(S.daySpan('2026-10-01', '2026-10-01'), 1);
  assert.equal(S.daySpan('2026-10-01', '2026-10-03'), 3);
  assert.equal(S.daySpan('2026-01-30', '2026-02-02'), 4, '월 경계');
  assert.equal(S.daySpan('2026-12-30', '2027-01-02'), 4, '연 경계');
  assert.equal(S.daySpan('2028-02-28', '2028-03-01'), 3, '윤년');
  assert.equal(S.daySpan('2026-03-01', '2026-03-30'), 30);
  assert.equal(S.daySpan('2026-03-01', '2026-03-31'), 31);
  assert.equal(S.MAX_DAYS, 30);
  assert.equal(S.daySpan('2026-10-05', '2026-10-01'), -3, '종료가 시작보다 앞');
  assert.ok(isNaN(S.daySpan('', '2026-10-01')));
  assert.ok(isNaN(S.daySpan('2026-02-30', '2026-03-01')), '없는 날짜');
  assert.ok(isNaN(S.daySpan('2026-10-01', 'abc')));
});

test('addDays: 종료일 = 시작일 + 일수 - 1', () => {
  assert.equal(S.addDays('2026-10-01', 0), '2026-10-01');
  assert.equal(S.addDays('2026-10-30', 2), '2026-11-01');
  assert.equal(S.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(S.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(S.addDays('bad', 1), '');
  // 왕복: 시작일과 일수로 만든 종료일의 일수가 다시 같은 값이 된다
  for (const n of [1, 2, 7, 30]) assert.equal(S.daySpan('2026-10-25', S.addDays('2026-10-25', n - 1)), n);
});

test('normItem: 고정 시각 정규화, 옛 데이터는 null, 샘플 지문에 반영', () => {
  const base = { name: 'x', lat: 1, lon: 2 };
  const legacy = S.normItem(base);
  assert.deepEqual([legacy.fixedStart, legacy.fixedEnd], [null, null]);
  assert.deepEqual([S.normItem({ ...base, fixedStart: '25:00', fixedEnd: 'x' }).fixedStart, S.normItem({ ...base, fixedEnd: '7:00' }).fixedEnd], [null, null]);
  const swapped = S.normItem({ ...base, fixedStart: '12:00', fixedEnd: '11:00' });
  assert.deepEqual([swapped.fixedStart, swapped.fixedEnd], ['12:00', null]);
  assert.deepEqual([S.newItem().fixedStart, S.newItem().fixedEnd], [null, null]);
  const t = globalThis.TP.sample.create();
  t.days[0].items[0].fixedStart = '09:30';
  assert.equal(S.isSample(t), false);
});

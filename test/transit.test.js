const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../server/transit');
const F = require('../public/js/fare');

const kakao = (fare) => ({
  status: 'OK',
  routes: [{ properties: { type: 'BUS', totalDistance: 1000, totalTime: 600, transfers: 0, fare }, steps: [] }],
});
const first = (fare) => normalize(kakao(fare)).routes[0];
// steps가 비어 있어도 totalTime > 0 이면 유지된다

test('normalize: 단일 요금 value', () => {
  const r = first({ value: 1550 });
  assert.deepStrictEqual([r.fare, r.fareMin, r.fareMax], [1550, null, null]);
});

test('normalize: min/max 범위', () => {
  const r = first({ min: 2350, max: 3300 });
  assert.deepStrictEqual([r.fare, r.fareMin, r.fareMax], [null, 2350, 3300]);
});

test('normalize: value가 있으면 범위는 무시', () => {
  const r = first({ value: 1500, min: 2350, max: 3300 });
  assert.deepStrictEqual([r.fare, r.fareMin, r.fareMax], [1500, null, null]);
});

test('normalize: min > max 는 바꿔서 정리, 소수는 반올림', () => {
  const r = first({ min: 3300.4, max: 2349.6 });
  assert.deepStrictEqual([r.fare, r.fareMin, r.fareMax], [null, 2350, 3300]);
});

test('normalize: min == max 는 단일 요금', () => {
  const r = first({ min: 1800, max: 1800 });
  assert.deepStrictEqual([r.fare, r.fareMin, r.fareMax], [1800, null, null]);
});

test('normalize: 요금 없음/이상한 값은 전부 null', () => {
  for (const f of [undefined, null, {}, 'x', { min: 100 }, { min: -1, max: 200 }, { min: 'a', max: 'b' }, { value: -5 }, { min: NaN, max: 10 }]) {
    const r = first(f);
    assert.deepStrictEqual([r.fare, r.fareMin, r.fareMax], [null, null, null], JSON.stringify(f));
  }
});

const cfg = (rangePick, people = 1) => ({ ...F.DEFAULT_CONFIG, people, transit: { ...F.DEFAULT_CONFIG.transit, rangePick } });
const opts = { mode: 'transit', distanceM: 5000, fareMin: 2350, fareMax: 3300 };

test('legCost: 범위 요금은 rangePick 기준 (기본 최대)', () => {
  assert.strictEqual(F.DEFAULT_CONFIG.transit.rangePick, 1);
  assert.strictEqual(F.legCost(opts, F.DEFAULT_CONFIG).perPerson, 3300);
  assert.strictEqual(F.legCost(opts, cfg(0)).perPerson, 2350);
  assert.strictEqual(F.legCost(opts, cfg(0.5)).perPerson, 2830); // 2825 -> 10원 반올림
  assert.strictEqual(F.legCost(opts, cfg(1)).perPerson, 3300);
});

test('legCost: 인원수만큼 곱함', () => {
  const c = F.legCost(opts, cfg(1, 3));
  assert.strictEqual(c.perPerson, 3300);
  assert.strictEqual(c.total, 9900);
});

test('legCost: 단일 요금이 범위보다 우선, 둘 다 없거나 잘못된 범위면 거리 추정', () => {
  assert.strictEqual(F.legCost({ ...opts, fare: 1550 }, cfg(1)).perPerson, 1550);
  const est = F.transitFare(5);
  assert.strictEqual(F.legCost({ mode: 'transit', distanceM: 5000 }, cfg(1)).perPerson, est);
  assert.strictEqual(F.legCost({ mode: 'transit', distanceM: 5000, fareMin: 3000, fareMax: 2000 }, cfg(1)).perPerson, est);
  assert.strictEqual(F.legCost({ mode: 'transit', distanceM: 5000, fareMin: null, fareMax: null }, cfg(1)).perPerson, est);
});

test('snapRangePick: 0 / 0.5 / 1 로 보정', () => {
  assert.deepStrictEqual([undefined, 'x', -1, 0.1, 0.4, 0.6, 0.9, 5].map(F.snapRangePick), [1, 1, 0, 0, 0.5, 0.5, 1, 1]);
});

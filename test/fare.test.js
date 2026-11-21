'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fare = require('../public/js/fare.js');

test('tollRoadKm: 이름에 고속도로가 있는 구간만 합산 (이름 없이 번호만 있는 국도는 세지 않는다)', () => {
  const steps = [
    { name: '경부고속도로', ref: '1', distance: 100000 },
    { name: '', ref: '1', distance: 1479 }, // 광주 시내 국도 1호선: OSM에 이름 태그가 빠져 번호만 온다
    { name: '만덕대로', ref: '14', distance: 3000 },
    { name: '', ref: '', distance: 2000 },
  ];
  assert.equal(fare.tollRoadKm(steps), 100);
  assert.equal(fare.tollRoadKm(null), 0);
});

test('tollFare: 기본요금 + km당 요금, 100원 단위', () => {
  assert.equal(fare.tollFare(0), 0);
  assert.equal(fare.tollFare(343), 16100);
});

test('legCost 자가용: 연료비 + 주차비 + 통행료', () => {
  const c = fare.legCost({ mode: 'car', distanceM: 100000, parking: 5000, tollKm: 100 });
  assert.equal(c.toll, 5300);
  assert.equal(c.total, c.fuel + 5000 + 5300);
});

test('legCost 자가용: 직접 입력은 연료비·통행료·주차비를 모두 대체', () => {
  const c = fare.legCost({ mode: 'car', distanceM: 100000, parking: 5000, tollKm: 100, override: 12000 });
  assert.equal(c.toll, 0);
  assert.equal(c.total, 12000);
});

test('legCost 택시: 미터 요금 + 통행료(고속도로 거리 추정), 고속도로가 없으면 통행료 0, 직접 입력은 대체', () => {
  const meter = fare.taxiFare(100000, 720);
  const c = fare.legCost({ mode: 'taxi', distanceM: 100000, depMin: 720, tollKm: 100 });
  assert.equal(c.toll, 5300);
  assert.equal(c.total, meter + 5300);
  const noHighway = fare.legCost({ mode: 'taxi', distanceM: 100000, depMin: 720 });
  assert.equal(noHighway.toll, 0);
  assert.equal(noHighway.total, meter);
  assert.equal(fare.legCost({ mode: 'taxi', distanceM: 100000, depMin: 720, tollKm: 100, override: 50000 }).total, 50000);
});

test('legCost 열차·버스: 1인 요금 x 인원, 요금을 모르면 미정, 직접 입력은 1인 기준', () => {
  const cfg = { ...fare.DEFAULT_CONFIG, people: 3 };
  for (const mode of ['train', 'bus']) {
    const c = fare.legCost({ mode, distanceM: 300000, fare: 30000 }, cfg);
    assert.equal(c.total, 90000);
    assert.equal(c.perPerson, 30000);
    assert.equal(fare.legCost({ mode, distanceM: 300000 }, cfg).unknown, true);
    assert.equal(fare.legCost({ mode, override: 20000 }, cfg).total, 60000);
  }
  assert.deepEqual(fare.MODES.map((m) => m.id), ['walk', 'bike', 'transit', 'taxi', 'car', 'train', 'bus']);
  assert.equal(fare.DEFAULT_CONFIG.est.detour, 1.26);
});

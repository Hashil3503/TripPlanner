'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fare = require('../public/js/fare.js');

test('tollRoadKm: 이름에 고속도로가 있거나 이름 없이 번호만 있는 구간을 합산', () => {
  const steps = [
    { name: '경부고속도로', ref: '1', distance: 100000 },
    { name: '', ref: '55', distance: 50000 },
    { name: '만덕대로', ref: '14', distance: 3000 },
    { name: '', ref: '', distance: 2000 },
  ];
  assert.equal(fare.tollRoadKm(steps), 150);
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

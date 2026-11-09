'use strict';
// routing.js 는 브라우저 전역(window.TP)에 붙는 스크립트라 최소 스텁(메모리 localStorage)을 만들어 Node에서 로드한다.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const fare = require('../public/js/fare.js');
globalThis.TP.fare = fare;
require('../public/js/routing.js');

const R = globalThis.TP.routing;
const settings = { ...fare.DEFAULT_CONFIG };
// 위도 1도 ≈ 111.19km
const at = (lat) => ({ lat, lon: 127 });
const A = at(37);

test('fallbackProfile: 직선거리 2km 이하는 도보, 초과는 자동차', () => {
  assert.equal(R.fallbackProfile(A, at(37.01), settings), 'foot'); // 약 1.1km
  assert.equal(R.fallbackProfile(A, at(37.0179), settings), 'foot'); // 약 2.0km 경계
  assert.equal(R.fallbackProfile(A, at(37.03), settings), 'car'); // 약 3.3km
  assert.equal(R.fallbackProfile(A, at(35.1), settings), 'car'); // 약 211km
});

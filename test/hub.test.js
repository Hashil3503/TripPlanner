'use strict';
// 역·터미널 판별(hubOf / 카카오 카테고리)과 역 끼워 넣기(planHubInsert). 브라우저 스크립트를 최소 스텁으로 Node에서 로드한다.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
require('../public/js/fare.js');
const TP = globalThis.TP;
TP.kakao = { load: async () => false, status: () => ({ state: 'idle' }) };
TP.routing = { haversine: () => 0 };
require('../public/js/storage.js');
require('../public/js/geocode.js');
require('../public/js/train.js');
require('../public/js/planner.js');
const P = TP.planner;

test('hubOfCategory: 기차역·버스터미널만, 지하철·주차장은 아님', () => {
  const h = TP.geocode.hubOfCategory;
  assert.equal(h('교통,수송 > 기차,철도 > 기차역 > KTX정차역'), 'train');
  assert.equal(h('교통,수송 > 교통시설 > 고속,시외버스터미널'), 'bus');
  assert.equal(h('교통,수송 > 지하철,전철 > 수도권1호선'), null);
  assert.equal(h('교통,수송 > 교통시설 > 주차장'), null);
  assert.equal(h(undefined), null);
});

const it = (name, lat, lon, o) => TP.store.newItem({ id: name, name, lat, lon, ...o });
const A = it('경복궁', 37.58, 126.97);
const B = it('해운대', 35.16, 129.16, { modeIn: 'train', legMin: 5, legCost: 100 });
const SEOUL = { name: '서울역', lat: 37.5547, lon: 126.9707 };
const BUSAN = { name: '부산역', lat: 35.1151, lon: 129.0422 };

test('hubOf: hub 필드 > 버스 이름 패턴, 기차역은 역 목록이 있어야 이름으로 판별', () => {
  assert.equal(P.hubOf(it('x', 0, 0, { hub: 'train' })), 'train');
  assert.equal(P.hubOf(it('동서울종합터미널', 0, 0)), 'bus');
  assert.equal(P.hubOf(it('대구서부정류장', 0, 0)), 'bus');
  assert.equal(P.hubOf(it('인천공항터미널', 0, 0)), null);
  assert.equal(P.hubOf(A), null);
  assert.deepEqual(P.hubMissing(A, B, 'train'), { dep: true, arr: true });
  assert.deepEqual(P.hubMissing(it('s', 0, 0, { hub: 'train' }), B, 'train'), { dep: false, arr: true });
  assert.deepEqual(P.hubMissing(A, it('t', 0, 0, { hub: 'bus' }), 'bus'), { dep: true, arr: false });
});

test('planHubInsert 3: 출발·도착 둘 다 -> from, 출발역, 도착역(열차), to(자동)', () => {
  const out = P.planHubInsert([A, B], 1, 'train', { dep: SEOUL, arr: BUSAN });
  assert.deepEqual(out.map((x) => x.name), ['경복궁', '서울역', '부산역', '해운대']);
  assert.equal(out[1].modeIn, null);
  assert.equal(out[2].modeIn, 'train');
  assert.equal(out[1].hub, 'train');
  assert.equal(out[2].hub, 'train');
  assert.equal(out[1].stay, 0);
  assert.equal(out[3].modeIn, null);
  assert.equal(out[3].legMin, null);
  assert.equal(out[3].legCost, null);
  assert.equal(A.hub, null); // 원본은 건드리지 않는다
});

test('planHubInsert 1: 출발역만 -> 도착(이미 역)에 모드가 남는다', () => {
  const to = it('부산역', BUSAN.lat, BUSAN.lon, { hub: 'train', modeIn: 'train' });
  const out = P.planHubInsert([A, to], 1, 'train', { dep: SEOUL });
  assert.deepEqual(out.map((x) => x.name), ['경복궁', '서울역', '부산역']);
  assert.equal(out[2].modeIn, 'train');
  assert.equal(out[1].modeIn, null);
});

test('planHubInsert 2: 도착역만 -> 출발(이미 역) 뒤에 도착역(열차), 원래 도착지는 자동', () => {
  const from = it('서울역', SEOUL.lat, SEOUL.lon, { hub: 'train' });
  const out = P.planHubInsert([from, B], 1, 'train', { arr: BUSAN });
  assert.deepEqual(out.map((x) => x.name), ['서울역', '부산역', '해운대']);
  assert.equal(out[1].modeIn, 'train');
  assert.equal(out[2].modeIn, null);
});

test('planHubInsert: 이웃과 같은 장소(≈10m)면 중복해서 넣지 않고 그 장소를 역으로 쓴다', () => {
  const near = it('서울역 광장', SEOUL.lat + 0.00005, SEOUL.lon);
  const out = P.planHubInsert([near, B], 1, 'train', { dep: SEOUL, arr: BUSAN });
  assert.deepEqual(out.map((x) => x.name), ['서울역 광장', '부산역', '해운대']);
  assert.equal(out[0].hub, 'train');
  const busanPlace = it('부산', BUSAN.lat, BUSAN.lon, { modeIn: 'train' });
  const out2 = P.planHubInsert([A, busanPlace], 1, 'train', { dep: SEOUL, arr: BUSAN });
  assert.deepEqual(out2.map((x) => x.name), ['경복궁', '서울역', '부산']);
  assert.equal(out2[2].modeIn, 'train');
  assert.equal(out2[2].hub, 'train');
});

test('planHubInsert: 뒤 장소와 하루 중간 위치 보존', () => {
  const C = it('C', 1, 1);
  const D = it('D', 2, 2);
  const out = P.planHubInsert([C, A, B, D], 2, 'bus', { dep: SEOUL, arr: BUSAN });
  assert.deepEqual(out.map((x) => x.name), ['C', '경복궁', '서울역', '부산역', '해운대', 'D']);
  assert.equal(out[3].modeIn, 'bus');
  assert.equal(out[3].hub, 'bus');
});

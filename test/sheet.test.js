'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUi() {
  const ctx = {
    window: {},
    addEventListener: () => {},
    document: { addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    Math,
  };
  ctx.window = ctx;
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ui.js'), 'utf8');
  vm.runInNewContext(code, ctx);
  return ctx.TP.ui;
}

const ui = loadUi();

test('snapSheetHeight: 닫힘·중간(50%)·최대(88%) 자석 스냅과 자유 높이 유지', () => {
  const H = 800;
  const BAR = 54;
  // 닫힘 영역(bar + 40px 이하) -> 닫힘
  assert.equal(ui.snapSheetHeight(54, H, BAR, 0), 54);
  assert.equal(ui.snapSheetHeight(90, H, BAR, 0), 54);
  // 중간(400px ± 28px) -> 400px
  assert.equal(ui.snapSheetHeight(380, H, BAR, 0), 400);
  assert.equal(ui.snapSheetHeight(420, H, BAR, 0), 400);
  // 최대(82% = 656px 이상) -> 88% (704px)
  assert.equal(ui.snapSheetHeight(660, H, BAR, 0), 704);
  assert.equal(ui.snapSheetHeight(790, H, BAR, 0), 704);
  // 중간 구간(예: 250px, 550px) -> 자유 높이 그대로 유지
  assert.equal(ui.snapSheetHeight(250, H, BAR, 0), 250);
  assert.equal(ui.snapSheetHeight(550, H, BAR, 0), 550);
});

test('snapSheetHeight: 빠른 플릭은 단계별(닫힘 <-> 중간 <-> 최대)로 이동한다', () => {
  const H = 800;
  const BAR = 54;
  // 아래로 빠른 플릭 (velocity > 0)
  assert.equal(ui.snapSheetHeight(600, H, BAR, 0.8), 400); // 최대 쪽 -> 중간
  assert.equal(ui.snapSheetHeight(350, H, BAR, 0.8), 54);  // 중간 이하 -> 닫힘
  // 위로 빠른 플릭 (velocity < 0)
  assert.equal(ui.snapSheetHeight(120, H, BAR, -0.8), 400); // 닫힘 쪽 -> 중간
  assert.equal(ui.snapSheetHeight(450, H, BAR, -0.8), 704); // 중간 이상 -> 최대
});

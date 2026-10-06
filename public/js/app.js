/* app.js - UI 조립: 렌더링, 이벤트, 다이얼로그. 사용자 입력 텍스트는 textContent로만 삽입한다. */
(function () {
  'use strict';
  const TP = window.TP;
  const S = TP.store;
  const P = TP.planner;
  const F = TP.fmt;
  const MODES = TP.fare.MODES;

  const $ = (sel, root = document) => root.querySelector(sel);
  const UI = TP.ui;
  const icon = UI.icon;

  /** DOM 생성 헬퍼 (innerHTML 미사용) */
  function el(tag, props, children) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'style') n.style.cssText = v; // 내부에서 만든 색상 값만 사용
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of [].concat(children == null ? [] : children)) if (c != null && c !== false) n.append(c);
    return n;
  }

  // ---- 앱 상태(저장 안 함) ----
  let model = null; // 마지막 계산 결과
  let selectedId = null;
  let focusedLeg = null; // 지도에서 누른 경로 구간 키 (사이드바에서 강조)
  let focusedLegDay = -1; // 강조한 구간의 일차: 다른 일차로 바뀌면 강조를 푼다
  let dragging = false;
  let pendingRender = false;
  const inflight = new Set(); // 경로 조회 중인 구간 key
  let editingItemId = null;
  let tripDialogMode = 'new';
  let editingTripId = null; // 여행 수정 다이얼로그가 가리키는 여행 (메인 카드에서는 현재 여행이 아닐 수 있다)
  let view = null; // 현재 화면: 'main'(내 여행) | 'trip'(여행 편집) | null(시작 전)
  let shownTripId = null; // 여행 화면에 열린 여행
  let authReady = false; // 서버 세션 확인이 끝났는지: 그 전에는 없는 여행 주소를 메인으로 바꾸지 않는다
  let mapStarted = false;

  // ---- 이동 구간 접기/펼치기 ----
  // 전체 기본값은 localStorage, 구간별 예외는 이번 방문 동안만 메모리에 둔다 (키: 여행 id + 도착 장소 id)
  const LEGS_KEY = 'tripplanner.legsCollapsed';
  const legOverride = new Map();
  let legsCollapsedDefault = (function () {
    try {
      return localStorage.getItem(LEGS_KEY) === '1';
    } catch (e) {
      return false; // 저장소를 못 쓰면 기본(펼침)
    }
  })();

  const trip = () => S.currentTrip();
  const day = () => S.currentDay();
  const settings = () => S.state.settings;
  const won = F.fmtWon;
  const colorOf = (i) => P.DAY_COLORS[i % P.DAY_COLORS.length];
  /** 지도 선과 사이드바 구간이 같은 색을 쓰도록 한 곳에서 정한다 (legIndex: 그 일차에서 구간의 순서) */
  const legColorOf = (dayIndex, legIndex) => P.legColor(colorOf(dayIndex), legIndex, S.state.showAll);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // =====================================================================
  // 렌더링
  // =====================================================================
  function renderAll(opts) {
    opts = opts || {};
    if (view !== 'trip') {
      renderMain(); // 메인 화면에서는 지도·일정을 그리지 않는다
      return;
    }
    if (!trip()) {
      applyRoute({ force: true }); // 여행 화면인데 여행이 없어짐 -> 메인으로
      return;
    }
    S.clampDay();
    if (focusedLeg && focusedLegDay !== S.state.dayIndex) focusedLeg = null;
    model = P.buildTrip(trip(), settings());
    $('#tripHeading').textContent = `${trip().name} 일정 편집`;
    document.title = `${trip().name} - 여행 플래너`;
    renderTripSelect();
    renderDayTabs();
    renderToolbar();
    renderSchedule();
    renderSummary();
    renderMap(!!opts.fit);
    ensureRoutes();
    updateStatus();
  }

  let rafId = 0;
  function scheduleRender() {
    if (dragging) {
      pendingRender = true;
      return;
    }
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => { if (view === 'trip') renderAll(); }); // 메인 화면으로 나갔으면 그릴 필요 없다
  }

  /** 여행 선택 드롭다운: 버튼에 현재 여행 이름, 메뉴에 여행 목록 */
  function renderTripSelect() {
    const cur = trip();
    // 여행이 없으면 선택/수정/삭제/내보내기를 막고 '새 여행'과 '가져오기'만 남긴다
    $('#tripMenuBtn').disabled = !cur;
    $('#btnEditTrip').disabled = !cur;
    $('#btnDeleteTrip').disabled = !cur;
    $('#btnExport').disabled = !cur;
    $('#tripLabel').textContent = cur ? cur.name : '여행 없음';
    $('#tripMenuBtn').title = cur ? `여행 선택 · ${cur.name}` : '여행이 없어요';
    const key = (cur ? cur.id : '') + '\n' + S.state.trips.map((t) => t.id + '\t' + t.name).join('\n');
    if (renderTripSelect.key === key) return; // 열려 있는 메뉴를 불필요하게 다시 그리지 않는다
    renderTripSelect.key = key;
    $('#tripMenu').replaceChildren(...S.state.trips.map((t) =>
      el('button', {
        type: 'button',
        class: 'menu-item',
        role: 'menuitemradio',
        'aria-checked': String(cur && t.id === cur.id),
        onclick: () => selectTrip(t.id),
      }, [el('span', { class: 'menu-label', text: t.name }), icon('check', 'menu-check')])
    ));
  }

  /** 헤더 여행 드롭다운: 주소를 바꾸면 라우터가 그 여행을 연다 */
  function selectTrip(id) {
    if (!trip() || id === trip().id) return;
    navigate(TP.trips.tripHash(id));
  }

  // =====================================================================
  // 화면 전환 (해시 라우트): '#/' 메인(내 여행), '#/trip/<id>' 여행 편집
  // =====================================================================
  /** 주소를 바꿔 화면을 옮긴다. 이미 그 주소면 다시 그리기만 한다. replace: 뒤로 가기 기록을 남기지 않는다 */
  function navigate(hash, replace) {
    if (TP.trips.canonicalHash(location.hash) === hash) {
      applyRoute({ force: true });
    } else if (replace) {
      history.replaceState(null, '', hash);
      applyRoute({ force: true });
    } else {
      location.hash = hash; // hashchange가 applyRoute를 부른다
    }
  }

  function setView(v) {
    view = v;
    document.body.dataset.view = v;
    $('#mainView').hidden = v !== 'main';
    $('#tripView').hidden = v !== 'trip';
    UI.closeMenus();
  }

  /** 지도는 여행 화면에 처음 들어갈 때 만든다 (메인만 쓰는 방문에서는 카카오 SDK도 불러오지 않는다) */
  function ensureMap() {
    if (mapStarted) return;
    mapStarted = true;
    TP.map.init('map', {
      onSelect: (id, dayIndex) => {
        if (dayIndex !== S.state.dayIndex) {
          S.state.dayIndex = dayIndex;
          S.save();
          renderAll();
        }
        selectItem(id, { scroll: true, pan: true, popup: true });
      },
      onAddPlace: addPlace,
      onLegSelect: focusLeg,
      onMapBlank: () => setFocusedLeg(null),
    });
  }

  /** 라우트 제목으로 포커스를 옮긴다 (화면 전환을 스크린리더/키보드 사용자에게 알린다) */
  function focusHeading() {
    const h = view === 'trip' ? $('#tripHeading') : S.state.trips.length ? $('#mainTitle') : $('#homeTitle');
    if (h) h.focus({ preventScroll: true });
  }

  /** 현재 주소를 해석해 화면을 맞춘다. 없는 여행 주소(삭제됨/다른 계정)와 여행 0개는 메인. force: 같은 화면이어도 다시 그린다 */
  function applyRoute(opts) {
    opts = opts || {};
    const r = TP.trips.parseRoute(location.hash);
    const t = r.name === 'trip' ? S.state.trips.find((x) => x.id === r.id) || null : null;
    // 계정 확인 전에는 주소를 건드리지 않는다 (로그인 사용자의 여행이 곧 불러와질 수 있다)
    if (r.name === 'trip' && !t && authReady) history.replaceState(null, '', TP.trips.MAIN_HASH);
    const target = t ? 'trip' : 'main';
    const viewChanged = view !== target;
    const tripChanged = target === 'trip' && shownTripId !== t.id;
    if (!viewChanged && !tripChanged && !opts.force) return;
    const first = view === null;
    if (target === 'trip') {
      if (S.state.currentTripId !== t.id) {
        S.state.currentTripId = t.id;
        S.state.dayIndex = 0;
        S.save();
      }
      if (tripChanged) selectedId = null;
      shownTripId = t.id;
      setView('trip');
      ensureMap();
      renderAll({ fit: viewChanged || tripChanged }); // 숨겨져 있던 지도는 보이게 된 뒤에 맞춘다
    } else {
      shownTripId = null;
      setView('main');
      renderAll();
    }
    if (!first && (viewChanged || tripChanged)) focusHeading();
  }

  // ---- 메인 화면 ----
  const tripColor = (id) => {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return P.DAY_COLORS[h % P.DAY_COLORS.length];
  };
  let cardMenus = []; // 다시 그릴 때 등록을 풀어 줄 카드 메뉴들

  function renderMain() {
    const trips = S.state.trips;
    const empty = trips.length === 0;
    $('#mainList').hidden = empty;
    $('#homeView').hidden = !empty;
    $('#mainCount').textContent = `총 ${trips.length}개`;
    document.title = '내 여행 - 여행 플래너';
    for (const m of cardMenus) m.destroy();
    cardMenus = [];
    $('#tripGrid').replaceChildren(...trips.map(buildTripCard));
  }

  function buildTripCard(t, idx) {
    // 합계는 캐시된 경로만으로 계산한다 (메인 화면은 경로 조회 요청을 보내지 않는다). 조회 전인 구간이 있으면 비용은 생략
    let totals = null;
    try {
      totals = P.buildTrip(t, settings()).totals;
    } catch (e) {
      totals = null;
    }
    const cost = TP.trips.costText(totals);
    const count = TP.trips.placeCount(t);
    const dates = TP.trips.dateRangeText(t);
    const menuId = 'tripCardMenu' + idx;
    const btn = el('button', { type: 'button', class: 'icon-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, 'aria-label': `${t.name} 메뉴`, title: '여행 메뉴' }, icon('more'));
    const item = (ico, label, fn, cls) => el('button', { type: 'button', class: 'menu-item' + (cls ? ' ' + cls : ''), role: 'menuitem', onclick: fn }, [icon(ico), label]);
    const panel = el('div', { class: 'menu', id: menuId, role: 'menu', 'aria-label': `${t.name} 메뉴`, hidden: true }, [
      item('pencil', '이름·날짜 수정', () => openTripDialog('edit', t.id)),
      item('copy', '복제', () => duplicateTripAction(t.id)),
      item('download', '내보내기', () => exportFile(t.id)),
      el('div', { class: 'menu-sep', role: 'separator' }),
      item('trash', '삭제', () => deleteTrip(t.id), 'danger'),
    ]);
    cardMenus.push(UI.menu(btn, panel, { align: 'end' }));
    return el('li', { class: 'trip-card', style: `--card:${tripColor(t.id)}`, dataset: { id: t.id } }, [
      el('h3', { class: 'tc-name' }, el('a', { class: 'tc-link', href: TP.trips.tripHash(t.id), 'aria-label': `${t.name} 열기, ${dates}, 장소 ${count}곳`, text: t.name })),
      el('p', { class: 'tc-date' }, [icon('calendar'), dates]),
      el('p', { class: 'tc-places', text: TP.trips.placePreview(t) }),
      el('p', { class: 'tc-meta' }, [
        el('span', {}, ['장소 ', el('b', { text: String(count) }), '곳']),
        cost ? el('span', { class: 'tc-cost', title: totals.unknownCostLegs ? '요금을 알 수 없는 구간은 합계에서 뺐어요' : '', text: cost + (totals.unknownCostLegs ? ' + 미정' : '') }) : null,
      ]),
      el('div', { class: 'menu-wrap tc-more' }, [btn, panel]),
    ]);
  }

  /** 카드 메뉴의 복제: 원본 바로 뒤에 새 id로 복사본을 만들고 메인에 머문다 */
  function duplicateTripAction(id) {
    const i = S.state.trips.findIndex((x) => x.id === id);
    if (i < 0) return;
    const copy = S.duplicateTrip(S.state.trips[i]);
    S.state.trips.splice(i + 1, 0, copy);
    S.save();
    renderAll();
    toast(`"${copy.name}" 을(를) 만들었어요`);
    const link = $(`#tripGrid [data-id="${CSS.escape(copy.id)}"] .tc-link`);
    if (link) link.focus();
  }

  function renderDayTabs() {
    const nav = $('#dayTabs');
    const t = trip();
    const tabs = t.days.map((d, i) =>
      el('button', {
        type: 'button',
        class: 'day-tab' + (i === S.state.dayIndex ? ' active' : ''),
        role: 'tab',
        'aria-selected': String(i === S.state.dayIndex),
        onclick: () => {
          S.state.dayIndex = i;
          selectedId = null;
          S.save();
          renderAll({ fit: true });
        },
      }, [el('span', { class: 'dot', style: `background:${colorOf(i)}` }), `${i + 1}일차`])
    );
    if (t.days.length < 30) {
      tabs.push(el('button', { type: 'button', class: 'day-tab add', title: '하루 추가', 'aria-label': '하루 추가', onclick: addDay }, icon('plus')));
    }
    nav.replaceChildren(...tabs);
    // 선택한 탭이 가로 스크롤 영역 밖이면 보이게 맞춘다
    const active = nav.querySelector('.day-tab.active');
    if (active) {
      const a = active.getBoundingClientRect();
      const n = nav.getBoundingClientRect();
      if (a.left < n.left) nav.scrollLeft += a.left - n.left - 8;
      else if (a.right > n.right) nav.scrollLeft += a.right - n.right + 8;
    }
  }

  function renderToolbar() {
    const i = S.state.dayIndex;
    $('#dayLabel').textContent = `${i + 1}일차`;
    $('#dayDate').textContent = F.fmtDate(F.dayDate(trip(), i));
    if (document.activeElement !== $('#peopleInput')) $('#peopleInput').value = settings().people;
    $('#showAll').checked = S.state.showAll;
    $('#btnDeleteDay').hidden = trip().days.length <= 1;
    renderLegsToggle();
  }

  // ---- 일정 목록 (타임라인) ----
  function renderSchedule() {
    const dm = model.days[S.state.dayIndex];
    const list = $('#itemList');
    const color = colorOf(dm.dayIndex);
    list.style.setProperty('--day', color);
    list.style.setProperty('--day-ink', UI.inkOn(color));
    bindLineHot(list);
    list.replaceChildren(...dm.rows.map((row, idx) => buildItem(row, idx, dm)));
    $('#emptyMsg').hidden = dm.rows.length > 0;
  }

  function buildItem(row, idx, dm) {
    const item = row.item;
    const stay = row.departure - row.arrival; // 종료 시각을 고정하면 체류 시간은 시각 차이로 정해진다
    const pin = (fixed) => (fixed ? [icon('lock', 'fixed-ico')] : []);
    const timeParts = stay > 0
      ? [el('span', { class: item.fixedStart ? 'fixed' : '' }, [...pin(item.fixedStart), F.fmtTime(row.arrival)]), ' – ',
        el('span', { class: item.fixedEnd ? 'fixed' : '' }, [...pin(item.fixedEnd), F.fmtTime(row.departure)]), ` · ${stay}분 체류`]
      : [el('span', { class: item.fixedStart ? 'fixed' : '' }, [...pin(item.fixedStart), F.fmtTime(row.arrival)]), ' 도착 · 체류 없음'];
    const gapNote = row.waitMin > 0
      ? el('div', { class: 'item-gap wait' }, [icon('clock'), `여유 ${row.waitMin}분 (도착 예정 ${F.fmtTime(row.est)})`])
      : row.endLateMin > 0 // 종료 시각까지 지난 경우가 더 심각하므로 먼저 표시
        ? el('div', { class: 'item-gap late' }, [icon('alert'), `종료 시각보다 ${row.endLateMin}분 늦게 도착해요 (도착 예정 ${F.fmtTime(row.est)})`])
        : row.lateMin > 0
          ? el('div', { class: 'item-gap late' }, [icon('alert'), `${row.lateMin}분 늦음 (도착 예정 ${F.fmtTime(row.est)})`])
          : null;

    const costChips = [];
    if (item.cost > 0) costChips.push(el('span', { class: 'cost-chip' }, [icon('ticket'), `입장/기타 ${won(item.cost)}${settings().people > 1 ? '/인' : ''}`]));
    if (item.parking > 0) costChips.push(el('span', { class: 'cost-chip' }, [icon('car'), `주차 ${won(item.parking)}`]));

    const card = el('div', {
      class: 'item-card',
      tabindex: '0',
      onclick: () => selectItem(item.id, { pan: true, popup: true }),
      onkeydown: (e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          selectItem(item.id, { pan: true, popup: true });
        }
      },
    }, [
      el('span', { class: 'drag-handle', title: '끌어서 순서 변경', 'aria-label': '끌어서 순서 변경' }, icon('grip')),
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title' }, [UI.catIcon(item.category), el('span', { class: 'name', text: item.name })]),
        el('div', { class: 'item-times' + (row.late ? ' late' : '') }, [
          icon(row.late ? 'alert' : 'clock'),
          el('span', { class: 'times-text' }, timeParts),
        ]),
        gapNote,
        item.memo ? el('div', { class: 'item-memo', text: item.memo }) : null,
        costChips.length ? el('div', { class: 'item-costs' }, costChips) : null,
      ]),
      el('div', { class: 'item-actions' }, [
        el('button', { type: 'button', class: 'icon-btn sm', title: '수정', 'aria-label': `${item.name} 수정`, onclick: (e) => { e.stopPropagation(); openItemDialog(item.id); } }, icon('pencil')),
        el('button', { type: 'button', class: 'icon-btn sm danger', title: '삭제', 'aria-label': `${item.name} 삭제`, onclick: (e) => { e.stopPropagation(); deleteItem(item.id); } }, icon('trash')),
      ]),
    ]);

    // 구간 순서: 첫 장소를 뺀 모든 장소에 들어오는 구간이 있으므로 들어오는 구간은 idx - 1, 나가는 구간은 idx
    const next = dm.rows[idx + 1];
    const last = idx === dm.rows.length - 1;
    return el('li', {
      class: 'item' + (item.id === selectedId ? ' selected' : '') + (row.late ? ' over-midnight' : ''),
      // 장소 옆 타임라인 선도 들어오는/나가는 구간 색으로 이어지게
      style: (idx > 0 ? `--prev-leg:${legColorOf(dm.dayIndex, idx - 1)};` : '') + (last ? '' : `--next-leg:${legColorOf(dm.dayIndex, idx)}`),
      dataset: { id: item.id },
    }, [
      row.leg ? buildLeg(row.leg, item, legColorOf(dm.dayIndex, idx - 1), idx) : null,
      el('div', { class: 'stop' }, [
        // 노드 위아래 타임라인 선: 눌러서 해당 구간을 접고 펴는 클릭 영역 (키보드는 구간의 .leg-line 버튼이 맡는다)
        row.leg ? lineSeg('in', legKey(item.id)) : null,
        next && next.leg ? lineSeg('out', legKey(next.item.id)) : null,
        buildNode(idx),
        card,
      ]),
    ]);
  }

  /** 타임라인 노드 (표시 전용) */
  function buildNode(idx) {
    return el('span', { class: 'node', text: String(idx + 1) });
  }

  /** 노드 위(in)/아래(out)의 선 조각. 같은 구간의 .leg-line과 data-line-for를 공유해 함께 강조된다. */
  function lineSeg(dir, key) {
    return el('div', {
      class: 'line-seg ' + dir,
      'aria-hidden': 'true',
      dataset: { lineFor: key },
      onclick: () => {
        const legEl = document.querySelector(`#itemList .leg[data-key="${CSS.escape(key)}"]`);
        if (legEl) toggleLeg(legEl);
      },
    });
  }

  /** 같은 구간(A→B)의 선 조각 전체를 함께 굵게 */
  function setLineHot(key, on) {
    for (const n of document.querySelectorAll(`#itemList [data-line-for="${CSS.escape(key)}"]`)) n.classList.toggle('hot', on);
  }

  function bindLineHot(list) {
    if (list.dataset.lineHot) return;
    list.dataset.lineHot = '1';
    const keyOf = (t) => {
      const n = t instanceof Element ? t.closest('[data-line-for]') : null;
      return n ? n.dataset.lineFor : null;
    };
    const over = (e) => { const k = keyOf(e.target); if (k && k !== keyOf(e.relatedTarget)) setLineHot(k, true); };
    const out = (e) => { const k = keyOf(e.target); if (k && k !== keyOf(e.relatedTarget)) setLineHot(k, false); };
    list.addEventListener('mouseover', over);
    list.addEventListener('mouseout', out);
    list.addEventListener('focusin', over);
    list.addEventListener('focusout', out);
  }

  /** 카카오 요금 범위 표시: '2,350~3,300원' */
  const rangeText = (min, max) => `${Math.round(min).toLocaleString('ko-KR')}~${won(max)}`;
  const RANGE_PICK_LABEL = { 0: '최소값', 0.5: '중간값', 1: '최대값' };
  const rangePickLabel = () => RANGE_PICK_LABEL[TP.fare.snapRangePick(settings().transit.rangePick)];

  function legCostText(leg) {
    const c = leg.cost;
    if (c.unknown) return '요금 미정';
    const people = settings().people;
    const share = people > 1 ? ` (1인 ${won(c.perPerson)})` : '';
    switch (leg.mode) {
      case 'walk':
      case 'bike':
        return '0원';
      case 'transit':
        return `${won(c.total)}${share}` + (leg.transitReal && leg.transitReal.fareRange ? ` · 요금 ${rangeText(leg.transitReal.fareRange.min, leg.transitReal.fareRange.max)}` : '');
      case 'taxi':
        return `${won(c.total)}${share}`;
      case 'car':
        return `${won(c.total)}${share}`;
      default:
        return '';
    }
  }

  const legKey = (itemId) => trip().id + ':' + itemId;
  const isLegCollapsed = (itemId) => {
    const k = legKey(itemId);
    return legOverride.has(k) ? legOverride.get(k) : legsCollapsedDefault;
  };

  /** 접힌 행의 짧은 비용 (걷기/자전거는 0원) */
  /** 접힌 행 비용: 요금 범위 경로는 합계 기준값 대신 범위(인원 합)를 보여준다 */
  function legCostShort(leg) {
    if (leg.cost.unknown) return '요금 미정';
    if (leg.mode === 'walk' || leg.mode === 'bike') return '0원';
    const fr = leg.transitReal && leg.transitReal.fareRange;
    if (fr && !leg.override.cost) {
      const people = Math.max(1, Math.round(settings().people || 1));
      return rangeText(fr.min * people, fr.max * people);
    }
    return won(leg.cost.total);
  }

  /** 구간 DOM의 접힘 상태를 맞춘다: 안 보이는 쪽은 inert로 포커스/스크린리더에서 제외 */
  function applyLegDom(legEl, collapsed) {
    legEl.dataset.collapsed = String(collapsed);
    const line = legEl.querySelector('.leg-line');
    line.setAttribute('aria-expanded', String(!collapsed));
    const label = line.dataset.label + (collapsed ? ' 펼치기' : ' 접기') + line.dataset.sum;
    line.title = label;
    line.setAttribute('aria-label', label);
    legEl.querySelector('.leg-pane-min').inert = !collapsed;
    legEl.querySelector('.leg-pane-full').inert = collapsed;
  }

  function toggleLeg(legEl) {
    const collapsed = legEl.dataset.collapsed !== 'true';
    legOverride.set(legEl.dataset.key, collapsed);
    applyLegDom(legEl, collapsed);
    if (collapsed && legEl.dataset.key === focusedLeg) setFocusedLeg(null);
    renderLegsToggle();
  }

  /** 오늘 일차 구간이 하나라도 펼쳐져 있으면 "모두 접기", 아니면 "모두 펼치기" */
  function renderLegsToggle() {
    const btn = $('#btnLegsToggle');
    if (!btn || !model) return;
    const legs = model.days[S.state.dayIndex].rows.filter((r) => r.leg);
    btn.hidden = legs.length === 0;
    const anyOpen = legs.some((r) => !isLegCollapsed(r.item.id));
    btn.dataset.action = anyOpen ? 'collapse' : 'expand';
    btn.querySelector('span').textContent = anyOpen ? '모두 접기' : '모두 펼치기';
    btn.title = anyOpen ? '이동 구간 상세를 모두 접어요' : '이동 구간 상세를 모두 펼쳐요';
    btn.querySelector('use').setAttribute('href', anyOpen ? '#i-chevrons-down-up' : '#i-chevrons-up-down');
  }

  function setAllLegs(collapsed) {
    legsCollapsedDefault = collapsed;
    legOverride.clear();
    try {
      localStorage.setItem(LEGS_KEY, collapsed ? '1' : '0');
    } catch (e) {
      /* 이번 방문에만 적용 */
    }
    for (const legEl of document.querySelectorAll('#itemList .leg')) applyLegDom(legEl, collapsed);
    if (collapsed) setFocusedLeg(null);
    renderLegsToggle();
  }

  /** 장소 사이의 이동 구간: 타임라인 위의 가벼운 연결 행. 접으면 한 줄(이동수단·시간·비용)만 남는다. */
  const INTERCITY_HINT = '카카오 대중교통은 도시 간 경로(KTX·고속버스 등)를 알려주지 않아요. 시간·요금을 직접 입력해 주세요';
  const NOFARE_HINT = '카카오가 이 경로의 요금을 알려주지 않아 합계에서 뺐어요. 요금을 알면 직접 입력해 주세요';

  function buildLeg(leg, item, color, idx) {
    const modes = MODES.map((m) => {
      const on = m.id === leg.mode;
      return el('button', {
        type: 'button',
        class: `seg-btn m-${m.id}` + (on ? ' active' : ''),
        title: m.label,
        'aria-label': m.label,
        'aria-pressed': String(on),
        onclick: () => setMode(item.id, m.id),
      }, [UI.modeIcon(m.id), on ? el('span', { class: 'seg-label', text: m.label }) : null]);
    });

    const tags = [];
    const notes = []; // 접힌 행의 경고 아이콘에 담을 안내
    if (leg.loading) tags.push(el('span', { class: 'tag loading' }, [el('span', { class: 'spinner' }), ' 계산 중…']));
    else if (leg.estimated) {
      tags.push(el('span', { class: 'tag warn', text: '추정(직선거리 기반)' }));
      notes.push('추정(직선거리 기반)');
    }
    if (leg.transit) {
      tags.push(el('span', { class: 'tag', title: leg.fallbackReason || '', text: '대중교통 추정' }));
      if (!(leg.override.min && leg.override.cost)) notes.push('대중교통 추정'); // 시간·요금을 모두 직접 입력했으면 접힌 행 경고는 생략
    }
    if (leg.cost.unknown) {
      const t = leg.interCity ? '도시 간 · 요금 미정' : '요금 미정';
      tags.push(el('span', { class: 'tag warn', title: leg.interCity ? INTERCITY_HINT : NOFARE_HINT, text: t }));
      notes.push(t);
    }
    if (leg.override.min || leg.override.cost) {
      const what = leg.override.min && leg.override.cost ? '시간·요금' : leg.override.min ? '시간' : '요금';
      tags.push(el('span', { class: 'tag accent', title: `${what}을 직접 입력한 값이에요`, text: '직접 입력' }));
      notes.push(`${what} 직접 입력`);
    }
    if (leg.transitReal && leg.transitReal.fareRange) {
      const fr = leg.transitReal.fareRange;
      tags.push(el('span', { class: 'tag', title: `카카오가 요금을 ${rangeText(fr.min, fr.max)} 범위로 알려줘 합계에는 ${rangePickLabel()}을 반영했어요`, text: '요금 범위' }));
      notes.push(`요금 범위(${rangePickLabel()} 반영)`);
    }
    if (leg.cost.surchargeRate > 0) {
      const t = `심야할증 +${Math.round(leg.cost.surchargeRate * 100)}%`;
      tags.push(el('span', { class: 'tag warn', text: t }));
      notes.push(t);
    }

    const details = [];
    if (leg.override.cost) {
      details.push(leg.mode === 'taxi' || leg.mode === 'car' ? '직접 입력한 요금은 차량 1대 총액으로 봐요' : '직접 입력한 요금은 1인 기준이에요');
    } else if (leg.mode === 'car') {
      details.push(`연료비 ${won(leg.cost.fuel)}` + (leg.cost.parking ? ` + 주차 ${won(leg.cost.parking)}` : '') + ' · 통행료 미포함');
    } else if (leg.mode === 'taxi' && settings().people > 1) {
      details.push('택시 요금은 인원이 나눠 낸다고 가정');
    } else if (leg.transit && leg.fallbackReason) {
      details.push(leg.fallbackReason);
    }

    const top = [el('div', { class: 'seg leg-modes', role: 'group', 'aria-label': '이동수단' }, modes)];
    if (!leg.auto) top.push(el('button', { type: 'button', class: 'link auto-btn', title: '거리에 따라 자동 선택', text: '자동 선택', onclick: () => setMode(item.id, null) }));

    const bodyId = 'leg-body-' + item.id;
    const modeLabel = (MODES.find((m) => m.id === leg.mode) || {}).label || '';
    const summaryText = `${F.fmtDuration(leg.durationMin)} · ${legCostShort(leg)}`;
    const warnText = notes.join(', ');

    // 구간 영역 전체가 토글: 선 버튼(키보드 포함)이나 빈 곳을 누르면 접고 편다. 안쪽의 다른 컨트롤과 텍스트 선택은 제외
    const legEl = el('div', {
      class: 'leg' + (leg.loading ? ' is-loading' : '') + (legKey(item.id) === focusedLeg ? ' focused' : ''),
      style: `--leg:${color}`,
      dataset: { key: legKey(item.id), lineFor: legKey(item.id) },
      onclick: (e) => {
        const ctl = e.target.closest('button, a, select, input, textarea, label, dialog');
        if (ctl && !ctl.classList.contains('leg-line')) return;
        const sel = window.getSelection && window.getSelection();
        if (!ctl && sel && String(sel) && e.currentTarget.contains(sel.anchorNode)) return; // 구간 안 글자를 드래그해 선택한 경우
        toggleLeg(e.currentTarget);
      },
    }, [
      // 구간 선: 이 구간을 접고 펴는 유일한 컨트롤 (노드 A 중심에서 노드 B 중심까지)
      el('button', {
        type: 'button',
        class: 'leg-line',
        'data-leg-toggle': '',
        'aria-controls': bodyId,
        'data-line-for': legKey(item.id),
        'data-label': `${idx}→${idx + 1} 이동 정보`,
        'data-sum': `: ${modeLabel} ${summaryText}` + (leg.loading ? ', 계산 중' : '') + (warnText ? `, ${warnText}` : ''),
      }),
      // 접힌 상태: 이동수단 아이콘 + 시간 · 비용 (+ 경고). 누를 수 없는 요약 행
      el('div', { class: 'leg-pane leg-pane-min' }, el('div', { class: 'leg-pane-in' },
        el('div', { class: 'leg-summary' }, [
          UI.modeIcon(leg.mode, `leg-mode-ico m-${leg.mode}`),
          el('span', { class: 'leg-sum-text', text: summaryText }),
          leg.loading ? el('span', { class: 'tag loading' }, [el('span', { class: 'spinner' }), ' 계산 중…']) : null,
          warnText ? el('span', { class: 'leg-warn', title: warnText }, icon('alert')) : null,
        ]))),
      // 펼친 상태: 기존 상세 내용
      el('div', { class: 'leg-pane leg-pane-full', id: bodyId }, el('div', { class: 'leg-pane-in' },
        el('div', { class: 'leg-content' }, [
          el('div', { class: 'leg-top' }, top),
          el('div', { class: 'leg-info-row' }, [
            el('div', { class: 'leg-info' }, [
              el('span', { class: 'leg-stat', text: F.fmtDuration(leg.durationMin) }),
              el('span', { class: 'leg-stat', text: F.fmtDist(leg.distance) }),
              el('span', { class: 'leg-stat cost', text: legCostText(leg) }),
              ...tags,
            ]),
          ]),
          leg.transitReal ? buildTransitRoute(leg.transitReal, item) : null,
          details.length ? el('div', { class: 'leg-detail', text: details.join(' · ') }) : null,
          el('div', { class: 'leg-edit-row' }, el('button', {
            type: 'button',
            class: 'link leg-edit' + (leg.cost.unknown ? ' strong' : ''),
            onclick: () => openLegDialog(item.id),
          }, [icon('pencil'), leg.override.min || leg.override.cost ? '직접 입력 수정' : leg.cost.unknown ? '직접 입력' : '시간·요금 직접 입력'])),
        ]))),
    ]);
    applyLegDom(legEl, isLegCollapsed(item.id));
    return legEl;
  }

  /** 대중교통 실경로: 노선 배지 + 대안 경로 선택 + 카카오맵 링크 */
  function buildTransitRoute(tr, item) {
    const r = tr.route;
    const label = (x, i) => {
      const fare = x.fare != null ? won(x.fare) : x.fareMin != null && x.fareMax != null ? rangeText(x.fareMin, x.fareMax) : '요금 미상';
      return `${P.routeTypeLabel(x)} ${F.fmtDuration(Math.ceil(x.totalTime / 60 - 1e-9))} ${fare}` + (x.transfers > 0 ? ` · 환승 ${x.transfers}회` : '') + (i === tr.defaultIdx ? ' (최단)' : '');
    };
    const row = [];
    if (tr.routes.length > 1) {
      const sel = el('select', { class: 'alt-select', title: '다른 대중교통 경로 선택', 'aria-label': '대중교통 경로 선택' },
        tr.routes.map((x, i) => el('option', { value: String(i), text: label(x, i) })));
      sel.value = String(tr.idx);
      sel.addEventListener('change', () => setTransitIdx(item.id, Number(sel.value)));
      row.push(sel);
    }
    if (tr.landingURL) row.push(el('a', { class: 'ext-link', href: tr.landingURL, target: '_blank', rel: 'noopener' }, ['카카오맵에서 보기', icon('external')]));
    return el('div', { class: 'leg-transit' }, [
      el('div', { class: 'leg-route' }, [UI.routePills(r), el('span', { class: 'route-meta', text: r.transfers > 0 ? `환승 ${r.transfers}회` : '환승 없음' })]),
      row.length ? el('div', { class: 'leg-alt' }, row) : null,
    ]);
  }

  // ---- 요약 ----
  const tile = (label, value, sub, cls) =>
    el('div', { class: 'tile' + (cls ? ' ' + cls : '') }, [el('span', { class: 'tile-label', text: label }), el('strong', { class: 'tile-value', text: value }), sub ? el('span', { class: 'tile-sub', text: sub }) : null]);

  const BAR_ROWS = [
    { id: 'walk', label: '도보', ico: 'walk' },
    { id: 'bike', label: '자전거', ico: 'bike' },
    { id: 'transit', label: '대중교통', ico: 'bus' },
    { id: 'taxi', label: '택시', ico: 'taxi' },
    { id: 'car', label: '자가용(연료·주차)', ico: 'car' },
    { id: 'extra', label: '입장·기타', ico: 'ticket' },
  ];

  const unknownNote = (n) => `요금 미정 구간 ${n}개 제외`;

  function renderSummary() {
    const idx = S.state.dayIndex;
    const dm = model.days[idx];
    const s = dm.stats;
    const people = model.people;

    const dayBox = $('#daySummary');
    const dayKids = [
      el('h3', {}, [el('span', { class: 'dot', style: `background:${colorOf(idx)}` }), `${idx + 1}일차 요약`]),
      el('div', { class: 'tiles' }, [
        tile('이동 시간', F.fmtDuration(s.travelMin)),
        tile('이동 거리', F.fmtDist(s.distance)),
        tile('교통비', won(s.transport), people > 1 ? `1인 ${won(s.transport / people)}` : ''),
        tile('입장·기타', won(s.extra), people > 1 ? `1인 ${won(s.extra / people)}` : ''),
        tile('하루 합계', won(s.total), people > 1 ? `1인 ${won(s.total / people)}` : '', 'accent total'),
      ]),
    ];
    if (dm.rows.length) dayKids.push(el('p', { class: 'summary-note' }, [icon('clock'), `일정 종료 예정 ${F.fmtTime(s.end)}`]));
    if (s.unknownCostLegs) dayKids.push(el('p', { class: 'summary-note warn' }, [icon('alert'), `${unknownNote(s.unknownCostLegs)} · 이동 구간의 직접 입력으로 채울 수 있어요`]));
    if (s.waitMin > 0) dayKids.push(el('p', { class: 'summary-note' }, [icon('clock'), `여유 시간 합계 ${F.fmtDuration(s.waitMin)}`]));
    if (s.lateCount > 0) dayKids.push(el('p', { class: 'warn-box' }, [icon('alert'), el('span', { text: `고정 시각에 늦는 장소가 ${s.lateCount}곳 있어요. 순서나 체류 시간을 조정해 보세요.` })]));
    if (s.late) dayKids.push(el('p', { class: 'warn-box' }, [icon('alert'), el('span', { text: `이 날의 일정이 자정을 넘깁니다 (종료 ${F.fmtTime(s.end)}). 체류 시간이나 순서를 조정해 보세요.` })]));
    dayBox.replaceChildren(...dayKids);

    // 여행 전체
    const t = model.totals;
    const rows = BAR_ROWS.map((r) => ({ ...r, value: r.id === 'extra' ? t.extra : t.byMode[r.id] }));
    const max = Math.max(...rows.map((r) => r.value), 1);

    const bars = rows.filter((r) => r.value > 0).map((r) =>
      el('div', { class: 'bar-row' }, [
        el('div', { class: 'bar-top' }, [
          el('span', { class: 'bar-label' }, [icon(r.ico, `m-${r.id}`), r.label]),
          el('span', { class: 'bar-value', text: `${won(r.value)} (${Math.round((r.value / t.total) * 100)}%)` }),
        ]),
        el('div', { class: 'bar-track' }, [el('div', { class: `bar-fill bar-${r.id}`, style: `width:${Math.max(2, (r.value / max) * 100)}%` })]),
      ])
    );

    const dayRows = model.days.map((d, i) =>
      el('button', {
        type: 'button',
        class: 'day-row' + (i === idx ? ' active' : ''),
        onclick: () => { S.state.dayIndex = i; selectedId = null; S.save(); renderAll({ fit: true }); },
      }, [
        el('span', { class: 'dot', style: `background:${colorOf(i)}` }),
        el('span', { class: 'day-row-name', text: `${i + 1}일차` }),
        el('strong', { class: 'day-row-total', text: won(d.stats.total) }),
        el('span', { class: 'day-row-sub', text: `${d.rows.length}곳 · ${F.fmtDuration(d.stats.travelMin)} · ${F.fmtDist(d.stats.distance)}` + (d.stats.unknownCostLegs ? ` · ${unknownNote(d.stats.unknownCostLegs)}` : '') }),
      ])
    );

    $('#tripSummary').replaceChildren(
      el('h3', { text: `여행 전체 (${people}명)` }),
      el('div', { class: 'tiles' }, [
        tile('총 이동 시간', F.fmtDuration(t.travelMin)),
        tile('총 이동 거리', F.fmtDist(t.distance)),
        tile('총 교통비', won(t.transport)),
        tile('총 입장·기타', won(t.extra)),
        tile('전체 합계', won(t.total), `1인당 합계 ${won(t.perPerson)}`, 'accent total'),
      ]),
      el('h4', { text: '비용 구성' }),
      bars.length ? el('div', { class: 'bars' }, bars) : el('p', { class: 'muted small', text: '아직 계산된 비용이 없어요.' }),
      el('h4', { text: '일차별 합계' }),
      el('div', { class: 'day-rows' }, dayRows),
      ...(t.unknownCostLegs ? [el('p', { class: 'summary-note warn' }, [icon('alert'), `${unknownNote(t.unknownCostLegs)} (도시 간 이동은 요금을 직접 입력해 주세요)`])] : []),
      el('p', { class: 'muted small fine-print', text: '※ 대중교통은 카카오맵 실경로·요금(교통카드 성인 기준)이며, 조회가 안 되면 추정값입니다(도시 간 이동은 요금 미정으로 두고 합계에서 제외해요). 이동 구간의 「직접 입력」으로 시간·요금을 바꿀 수 있습니다. 요금이 범위로 오는 경로는 설정에서 고른 기준(기본 최대값)으로 계산합니다. 택시 요금은 추정치이고 통행료(고속도로)는 포함되지 않습니다. 택시·자가용은 차량 1대를 인원이 나눠 쓴다고 가정합니다.' })
    );
  }

  function updateStatus() {
    const status = $('#status');
    const retry = $('#btnRetry');
    const failed = model ? model.totals.failedLegs : 0;
    if (inflight.size > 0) {
      status.replaceChildren(el('span', { class: 'spinner' }), ` 경로 계산 중… (${inflight.size})`);
      status.className = 'status busy';
      retry.hidden = true;
    } else if (failed > 0) {
      status.replaceChildren(icon('alert'), ` ${failed}개 구간은 경로 조회 실패로 추정값 사용`);
      status.className = 'status warn';
      retry.hidden = false;
    } else {
      status.textContent = '';
      status.className = 'status';
      retry.hidden = true;
    }
    $('#statusRow').hidden = inflight.size === 0 && failed === 0;
  }

  // ---- 지도 ----
  function renderMap(fit) {
    const groups = [];
    (model ? model.days : []).forEach((dm, i) => {
      const active = i === S.state.dayIndex;
      if (!S.state.showAll && !active) return;
      groups.push({
        dayIndex: i,
        color: colorOf(i),
        active,
        points: dm.rows.map((r, n) => ({ item: r.item, number: n + 1, arrival: r.arrival })),
        legs: dm.rows.filter((r) => r.leg).map((r, n) => ({ leg: r.leg, color: legColorOf(i, n) })),
      });
    });
    TP.map.render({ groups, selectedId, focusedLegId: focusedLeg ? focusedLeg.slice(focusedLeg.indexOf(':') + 1) : null });
    if (fit) TP.map.fit();
  }

  // ---- 경로 비동기 조회: 캐시에 없는 구간만 요청하고, 도착하는 대로 다시 그린다 ----
  function ensureRoutes() {
    for (const dm of model.days) {
      const prio = dm.dayIndex === S.state.dayIndex ? 0 : 1;
      for (const r of dm.rows) {
        const leg = r.leg;
        if (!leg || !leg.loading) continue;
        const k = TP.routing.key(leg.from, leg.to, leg.profile);
        if (inflight.has(k)) continue;
        inflight.add(k);
        TP.routing.get(leg.from, leg.to, leg.profile, prio).then(() => {
          inflight.delete(k);
          scheduleRender();
        });
      }
    }
  }

  // =====================================================================
  // 동작
  // =====================================================================
  function selectItem(id, o) {
    o = o || {};
    selectedId = id;
    setFocusedLeg(null, -1, false); // 아래에서 지도를 다시 그린다
    for (const n of document.querySelectorAll('#itemList .item.selected')) n.classList.remove('selected');
    const li = $(`#itemList [data-id="${CSS.escape(id)}"]`);
    if (li) {
      li.classList.add('selected');
      if (o.scroll) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    renderMap(false);
    if (o.pan) TP.map.panToItem(id, !!o.popup);
  }

  /** 지도에서 누른 경로: 그 일차로 바꾸고 사이드바에서 구간을 펼쳐 강조한 뒤 보이게 스크롤 */
  function focusLeg(itemId, dayIndex) {
    if (dayIndex !== S.state.dayIndex) {
      S.state.dayIndex = dayIndex;
      S.save();
      renderAll();
    }
    const key = legKey(itemId);
    const legEl = document.querySelector(`#itemList .leg[data-key="${CSS.escape(key)}"]`);
    if (!legEl) return;
    if ($('#sideLeft').classList.contains('is-collapsed')) $('#toggleLeft').click(); // 접힌 일정 사이드바는 펼친다
    if (legEl.dataset.collapsed === 'true') toggleLeg(legEl);
    setFocusedLeg(key, dayIndex);
    legEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** 강조는 장소 선택·지도 빈 곳 클릭·그 구간 접기·일차 전환 때 풀린다 */
  function setFocusedLeg(key, dayIndex, redraw = true) {
    if (key === focusedLeg) return;
    focusedLeg = key;
    focusedLegDay = key ? dayIndex : -1;
    for (const n of document.querySelectorAll('#itemList .leg')) n.classList.toggle('focused', n.dataset.key === key);
    if (redraw) renderMap(false); // 지도 경로의 네온 강조도 함께 갱신
  }

  function setMode(itemId, mode) {
    const it = day().items.find((x) => x.id === itemId);
    if (!it) return;
    it.modeIn = mode;
    it.transitIdx = null;
    clearLegOverride(it); // 요금 의미가 이동수단마다 달라 직접 입력값도 초기화
    S.save();
    renderAll();
  }

  function clearLegOverride(it) {
    if (it) {
      it.legMin = null;
      it.legCost = null;
    }
  }

  function setTransitIdx(itemId, idx) {
    const it = day().items.find((x) => x.id === itemId);
    if (!it) return;
    it.transitIdx = Number.isInteger(idx) && idx >= 0 ? idx : null;
    S.save();
    renderAll();
  }

  function addPlace(p) {
    if (!trip()) {
      // 지도 클릭 팝업 등 여행 없이 들어온 추가 요청: 여행부터 만들도록 안내
      toast('먼저 여행을 만들어 주세요');
      openTripDialog('new');
      return;
    }
    const d = day();
    const it = S.newItem({ name: String(p.name || '새 장소').slice(0, 100), lat: p.lat, lon: p.lon, category: p.category && p.category !== 'etc' ? p.category : 'sight' });
    d.items.push(it);
    selectedId = it.id;
    S.save();
    hideResults();
    $('#searchInput').value = '';
    renderAll({ fit: true });
    selectItem(it.id, { scroll: true });
    toast(`"${it.name}" 을(를) ${S.state.dayIndex + 1}일차에 추가했어요`);
  }

  function deleteItem(id) {
    const d = day();
    const it = d.items.find((x) => x.id === id);
    if (!it || !confirm(`"${it.name}" 일정을 삭제할까요?`)) return;
    clearLegOverride(d.items[d.items.indexOf(it) + 1]); // 다음 장소의 앞 장소가 바뀌므로 직접 입력값을 되돌린다
    d.items = d.items.filter((x) => x.id !== id);
    if (selectedId === id) selectedId = null;
    S.save();
    renderAll({ fit: true });
  }

  function addDay() {
    const t = trip();
    if (t.days.length >= 30) return;
    t.days.push(S.newDay());
    S.state.dayIndex = t.days.length - 1;
    selectedId = null;
    S.save();
    renderAll({ fit: true });
  }

  function deleteDay() {
    const t = trip();
    if (t.days.length <= 1) return;
    const d = day();
    if (!confirm(`${S.state.dayIndex + 1}일차${d.items.length ? ` (일정 ${d.items.length}개)` : ''}를 삭제할까요?`)) return;
    t.days.splice(S.state.dayIndex, 1);
    S.clampDay();
    selectedId = null;
    S.save();
    renderAll({ fit: true });
  }

  /** 드래그로 순서 변경. 앞 장소가 바뀐 구간은 이동수단을 자동으로 되돌린다. */
  function reorder(oldIndex, newIndex) {
    const items = day().items;
    const predOf = () => new Map(items.map((it, i) => [it.id, i ? items[i - 1].id : null]));
    const before = predOf();
    items.splice(newIndex, 0, items.splice(oldIndex, 1)[0]);
    const after = predOf();
    for (const it of items) {
      if (before.get(it.id) !== after.get(it.id)) {
        it.modeIn = null;
        it.transitIdx = null;
        clearLegOverride(it);
      }
    }
    S.save();
  }

  // ---- 검색 ----
  let searchTimer = null;
  let searchAbort = null;
  let searchSeq = 0;

  const resultsBox = () => $('#searchResults');
  function hideResults() {
    resultsBox().hidden = true;
    resultsBox().replaceChildren();
  }
  const showMessage = (text, cls) => {
    resultsBox().hidden = false;
    resultsBox().replaceChildren(el('li', { class: 'result-msg ' + (cls || ''), text }));
  };

  async function runSearch(q) {
    if (searchAbort) searchAbort.abort();
    const ctrl = new AbortController();
    searchAbort = ctrl;
    const seq = ++searchSeq;
    showMessage('검색 중…', 'loading');
    try {
      const results = await TP.geocode.search(q, ctrl.signal);
      if (seq !== searchSeq) return;
      if (!results.length) return showMessage('검색 결과가 없어요. 다른 키워드로 시도해 보세요.');
      resultsBox().hidden = false;
      resultsBox().replaceChildren(
        el('li', { class: 'results-head' }, [
          el('span', { text: `검색 결과 ${results.length}개` }),
          el('button', { type: 'button', class: 'icon-btn sm', title: '검색 결과 닫기', 'aria-label': '검색 결과 닫기', onclick: hideResults }, icon('x')),
        ]),
        ...results.map((r) =>
          el('li', { class: 'result' }, [
            UI.catIcon(r.category),
            el('button', { type: 'button', class: 'result-main', title: '지도에서 보기', onclick: () => TP.map.showPlace(r, true) }, [
              el('span', { class: 'result-head' }, [
                el('span', { class: 'result-name', text: r.name }),
                el('span', { class: 'result-tag', text: r.source === 'kakao' ? '카카오' : 'OSM' }),
              ]),
              el('span', { class: 'result-sub', text: r.displayName }),
            ]),
            el('button', { type: 'button', class: 'btn primary small', title: '일정에 추가', onclick: () => addPlace(r) }, [icon('plus'), '추가']),
          ])
        )
      );
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (seq !== searchSeq) return;
      showMessage('검색에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error');
    }
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = $('#searchInput').value.trim();
    if (q.length < 2) {
      if (searchAbort) searchAbort.abort();
      searchSeq++;
      hideResults();
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), TP.geocode.debounceMs()); // 디바운스 (카카오 300ms / Nominatim 700ms)
  }

  // ---- 다이얼로그 ----
  function openTripDialog(mode, id) {
    const t = mode === 'new' ? null : S.state.trips.find((x) => x.id === (id || (trip() && trip().id))) || null;
    if (mode !== 'new' && !t) return;
    tripDialogMode = mode;
    editingTripId = t ? t.id : null;
    // 종료일은 저장하지 않고 시작일 + 일수 - 1 로 구한다 (옛 여행처럼 시작일이 없으면 둘 다 비워 두고 입력받는다)
    const start = t ? t.startDate : S.todayYmd();
    $('#tripDialogTitle').textContent = t ? '여행 수정' : '새 여행';
    $('#tripName').value = t ? t.name : '새 여행';
    $('#tripStart').value = start;
    $('#tripEnd').value = start ? S.addDays(start, t ? t.days.length - 1 : 0) : '';
    syncTripDates();
    showTripError('');
    $('#tripDialog').showModal();
    $('#tripName').select();
  }

  function showTripError(msg) {
    const p = $('#tripError');
    p.textContent = msg;
    p.hidden = !msg;
  }

  /** 시작일이 바뀌면 종료일의 최소값을 맞추고, 종료일이 비었거나 시작일보다 앞서면 시작일로 당긴다. 총 일수를 안내한다. */
  function syncTripDates(fromStart) {
    const start = $('#tripStart').value;
    const end = $('#tripEnd');
    end.min = start;
    if (fromStart && start && (!end.value || end.value < start)) end.value = start;
    const n = S.daySpan(start, end.value);
    $('#tripSpan').textContent = n >= 1 && n <= S.MAX_DAYS ? `총 ${n}일 (${n > 1 ? `${n - 1}박 ${n}일` : '당일치기'})` : `여행 기간은 최대 ${S.MAX_DAYS}일까지 정할 수 있어요.`;
  }

  function validateTrip(name, start, end) {
    if (!name) return '여행 이름을 입력해 주세요.';
    if (!start) return '시작일을 선택해 주세요.';
    if (!end) return '종료일을 선택해 주세요.';
    const n = S.daySpan(start, end);
    if (isNaN(n)) return '올바른 날짜를 입력해 주세요.';
    if (n < 1) return '종료일은 시작일 이후여야 해요.';
    if (n > S.MAX_DAYS) return `여행 기간은 최대 ${S.MAX_DAYS}일이에요.`;
    return '';
  }

  function submitTrip() {
    const name = $('#tripName').value.trim();
    const start = $('#tripStart').value;
    const end = $('#tripEnd').value;
    const err = validateTrip(name, start, end);
    if (err) return showTripError(err);
    showTripError('');
    const days = S.daySpan(start, end);
    let newId = null;
    if (tripDialogMode === 'new') {
      const t = S.newTrip(name, start, days);
      S.state.trips.push(t);
      S.state.currentTripId = t.id;
      S.state.dayIndex = 0;
      newId = t.id;
    } else {
      const t = S.state.trips.find((x) => x.id === editingTripId);
      if (!t) return $('#tripDialog').close();
      if (days < t.days.length) {
        const lost = t.days.slice(days).reduce((n, d) => n + d.items.length, 0);
        if (lost && !confirm(`여행 기간을 줄이면 ${days + 1}일차 이후의 일정 ${lost}개가 삭제됩니다. 계속할까요?`)) return;
        t.days.length = days;
      }
      while (t.days.length < days) t.days.push(S.newDay());
      t.name = name;
      t.startDate = start;
    }
    selectedId = null;
    S.save();
    $('#tripDialog').close();
    if (newId) navigate(TP.trips.tripHash(newId)); // 새 여행은 바로 편집 화면으로
    else renderAll({ fit: view === 'trip' });
  }

  /** 여행 삭제 (id 없으면 현재 여행). 편집 화면에서 지웠으면 메인으로 나간다 (어떤 여행도 자동으로 열지 않는다) */
  function deleteTrip(id) {
    const t = S.state.trips.find((x) => x.id === (id || (trip() && trip().id)));
    if (!t || !confirm(`"${t.name}" 여행을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    S.state.trips = S.state.trips.filter((x) => x.id !== t.id);
    if (S.state.currentTripId === t.id) {
      S.state.currentTripId = S.state.trips.length ? S.state.trips[0].id : null;
      S.state.dayIndex = 0;
    }
    selectedId = null;
    S.save();
    if (view === 'trip' && shownTripId === t.id) navigate(TP.trips.MAIN_HASH, true);
    else renderAll();
  }

  /** '샘플 여행': 서울 1박 2일 샘플을 여행 목록에 추가하고 그 여행을 연다 */
  function createSampleTrip() {
    const t = TP.sample.create();
    S.state.trips.push(t);
    S.state.currentTripId = t.id;
    S.state.dayIndex = 0;
    selectedId = null;
    S.save();
    navigate(TP.trips.tripHash(t.id));
    toast('샘플 여행을 만들었어요. 마음대로 고쳐 보세요');
  }

  function openItemDialog(id) {
    const it = day().items.find((x) => x.id === id);
    if (!it) return;
    editingItemId = id;
    $('#itemName').value = it.name;
    $('#itemLat').value = it.lat;
    $('#itemLon').value = it.lon;
    $('#itemCat').value = it.category;
    $('#itemStay').value = it.stay;
    $('#itemStay').disabled = false; // 이전에 연 장소의 상태를 지운다
    delete $('#itemStay').dataset.saved;
    $('#itemFixedStart').value = it.fixedStart || '';
    $('#itemFixedEnd').value = it.fixedEnd || '';
    const first = day().items[0] === it;
    const hint = '시작·종료·체류 중 두 개를 정하면 나머지는 자동으로 계산해요. 정한 시작보다 일찍 도착하면 그 시각까지 기다려요.';
    $('#itemTimeHint').textContent = first && !it.fixedStart && !it.fixedEnd ? `시각을 비우면 ${day().startTime}(자동)에 시작해요. ${hint}` : hint;
    showItemError('');
    syncItemTimeFields();
    $('#itemCost').value = it.cost;
    $('#itemParking').value = it.parking;
    $('#itemMemo').value = it.memo;
    $('#itemDay').replaceChildren(...trip().days.map((d, i) => {
      const date = F.fmtDate(F.dayDate(trip(), i));
      return el('option', { value: String(i), text: `${i + 1}일차${date ? ' · ' + date : ''}`, selected: i === S.state.dayIndex });
    }));
    $('#itemDay').value = String(S.state.dayIndex);
    $('#itemDialog').showModal();
  }

  function showItemError(msg) {
    const p = $('#itemError');
    p.textContent = msg;
    p.hidden = !msg;
  }

  /** 시작·종료·체류 중 두 개를 정하면 나머지는 계산된다. 시작·종료를 모두 정하면 체류는 그 차이로 보여주고 입력을 막는다 */
  function syncItemTimeFields() {
    const stay = $('#itemStay');
    const fs = $('#itemFixedStart').value;
    const fe = $('#itemFixedEnd').value;
    const both = !!(fs && fe);
    if (both && !stay.disabled) stay.dataset.saved = stay.value; // 시각을 지우면 원래 체류 시간으로 되돌린다
    if (!both && stay.disabled && stay.dataset.saved != null) stay.value = stay.dataset.saved;
    if (both && fe > fs) stay.value = F.parseTime(fe) - F.parseTime(fs);
    stay.disabled = both;
    stay.title = both ? '시작·종료 시각을 정해서 체류 시간은 그 차이로 계산돼요' : '';
    showItemError('');
  }

  function submitItem() {
    const it = day().items.find((x) => x.id === editingItemId);
    if (!it) return $('#itemDialog').close();
    const fs = $('#itemFixedStart').value || null;
    const fe = $('#itemFixedEnd').value || null;
    if (fs && fe && fe <= fs) return showItemError('종료 시각은 시작 시각보다 늦어야 해요.');
    const nn = (id, def, min, max) => {
      const v = Number($(id).value);
      return isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    };
    it.name = $('#itemName').value.trim().slice(0, 100) || '이름 없는 장소';
    it.lat = nn('#itemLat', it.lat, -90, 90);
    it.lon = nn('#itemLon', it.lon, -180, 180);
    it.category = $('#itemCat').value;
    if (!(fs && fe)) it.stay = Math.round(nn('#itemStay', 60, 0, 1440)); // 둘 다 정하면 체류는 시각 차이로 계산되므로 기존 값을 보존
    it.fixedStart = fs;
    it.fixedEnd = fe;
    it.cost = Math.round(nn('#itemCost', 0, 0, 1e9));
    it.parking = Math.round(nn('#itemParking', 0, 0, 1e9));
    it.memo = $('#itemMemo').value.slice(0, 500);
    const target = Number($('#itemDay').value);
    if (target !== S.state.dayIndex && trip().days[target]) {
      clearLegOverride(day().items[day().items.indexOf(it) + 1]);
      day().items = day().items.filter((x) => x !== it);
      it.modeIn = null;
      it.transitIdx = null;
      clearLegOverride(it);
      trip().days[target].items.push(it);
      toast(`${target + 1}일차로 이동했어요`);
    }
    S.save();
    $('#itemDialog').close();
    renderAll({ fit: target !== S.state.dayIndex });
  }

  // ---- 구간 시간·요금 직접 입력 ----
  let editingLegId = null;
  const LEG_COST_HELP = {
    transit: ['대중교통 요금 (1인, 원)', '인원 수만큼 곱해서 합계에 반영해요.'],
    walk: ['요금 (1인, 원)', '인원 수만큼 곱해서 합계에 반영해요.'],
    bike: ['요금 (1인, 원)', '인원 수만큼 곱해서 합계에 반영해요.'],
    taxi: ['택시 요금 (차량 1대 총액, 원)', '인원이 나눠 낸다고 보고 총액 그대로 합계에 반영해요.'],
    car: ['자가용 비용 (차량 1대 총액, 원)', '연료비·주차비를 대신하는 총액이에요. 통행료가 있다면 함께 넣어 주세요.'],
  };

  function openLegDialog(itemId) {
    const d = day();
    const i = d.items.findIndex((x) => x.id === itemId);
    if (i < 1) return;
    const it = d.items[i];
    const leg = P.computeLeg(d.items[i - 1], { ...it, legMin: null, legCost: null }, settings(), 0); // 자동 계산값(placeholder)과 이동수단 확인용
    editingLegId = itemId;
    const [label, help] = LEG_COST_HELP[leg.mode] || LEG_COST_HELP.transit;
    $('#legDialogSub').textContent = `${d.items[i - 1].name} → ${it.name}`;
    $('#legMin').value = it.legMin == null ? '' : it.legMin;
    $('#legMin').placeholder = `자동 ${leg.durationMin}`;
    $('#legCostLabel').textContent = label;
    $('#legCostHelp').textContent = help;
    $('#legCost').value = it.legCost == null ? '' : it.legCost;
    $('#legDialog').showModal();
  }

  function submitLeg(clear) {
    const it = day().items.find((x) => x.id === editingLegId);
    if (!it) return $('#legDialog').close();
    const opt = (sel, max) => {
      const raw = $(sel).value.trim();
      const v = Number(raw);
      return clear || raw === '' || !isFinite(v) ? null : Math.round(Math.min(max, Math.max(0, v)));
    };
    it.legMin = opt('#legMin', 1440 * 3);
    it.legCost = opt('#legCost', 1e8);
    S.save();
    $('#legDialog').close();
    renderAll();
  }

  // ---- 설정 ----
  const SETTINGS_SCHEMA = [
    { group: '여행', fields: [{ path: 'people', label: '여행 인원', unit: '명', min: 1, step: 1, int: true }] },
    {
      group: '대중교통 요금 범위',
      fields: [
        { path: 'transit.rangePick', label: '요금이 범위로 올 때 합계 기준', options: [[0, '최소'], [0.5, '중간값'], [1, '최대']] },
      ],
    },
    {
      group: '대중교통 추정 (1인, 교통카드 · 조회 실패 시 추정에만 사용)',
      fields: [
        { path: 'transit.baseFare', label: '기본요금', unit: '원', min: 0, step: 50 },
        { path: 'transit.baseKm', label: '기본요금 적용 거리', unit: 'km', min: 0, step: 1 },
        { path: 'transit.stepKm', label: '추가요금 단위 거리 (기본~상한)', unit: 'km', min: 0.5, step: 0.5 },
        { path: 'transit.stepFee', label: '단위당 추가요금', unit: '원', min: 0, step: 50 },
        { path: 'transit.stepMaxKm', label: '추가요금 구간 상한', unit: 'km', min: 0, step: 1 },
        { path: 'transit.farStepKm', label: '상한 초과 단위 거리', unit: 'km', min: 0.5, step: 0.5 },
        { path: 'transit.farStepFee', label: '상한 초과 단위 요금', unit: '원', min: 0, step: 50 },
      ],
    },
    {
      group: '택시 (서울 중형)',
      fields: [
        { path: 'taxi.baseFare', label: '기본요금', unit: '원', min: 0, step: 100 },
        { path: 'taxi.baseMeters', label: '기본요금 거리', unit: 'm', min: 0, step: 100 },
        { path: 'taxi.stepMeters', label: '추가요금 단위 거리', unit: 'm', min: 1, step: 1 },
        { path: 'taxi.stepFee', label: '단위당 추가요금', unit: '원', min: 0, step: 100 },
        { path: 'taxi.surcharge20', label: '심야할증 (22~23시, 02~04시)', unit: '%', min: 0, step: 5, scale: 100 },
        { path: 'taxi.surcharge40', label: '심야할증 (23~02시)', unit: '%', min: 0, step: 5, scale: 100 },
      ],
    },
    {
      group: '자가용 (통행료 미포함)',
      fields: [
        { path: 'car.efficiency', label: '연비', unit: 'km/L', min: 0.5, step: 0.5 },
        { path: 'car.fuelPrice', label: '유가', unit: '원/L', min: 0, step: 10 },
      ],
    },
    {
      group: '이동 시간 추정',
      fields: [
        { path: 'est.autoWalkKm', label: '자동 선택: 도보 기준 거리', unit: 'km', min: 0, step: 0.1 },
        { path: 'est.interCityKm', label: '도시 간 이동으로 볼 거리 (대중교통 조회 실패 시)', unit: 'km', min: 1, step: 5 },
        { path: 'est.transitSpeed', label: '대중교통 평균 속도', unit: 'km/h', min: 1, step: 1 },
        { path: 'est.transitOverheadMin', label: '대중교통 대기·환승 시간', unit: '분', min: 0, step: 1 },
        { path: 'est.walk', label: '도보 속도 (조회 실패 시)', unit: 'km/h', min: 0.5, step: 0.5 },
        { path: 'est.bike', label: '자전거 속도 (조회 실패 시)', unit: 'km/h', min: 1, step: 1 },
        { path: 'est.car', label: '자동차 속도 (조회 실패 시)', unit: 'km/h', min: 1, step: 1 },
        { path: 'est.detour', label: '직선거리 → 도로거리 보정 계수', unit: '배', min: 1, step: 0.05 },
      ],
    },
  ];

  const getPath = (obj, path) => path.split('.').reduce((o, k) => o[k], obj);
  function setPath(obj, path, v) {
    const ks = path.split('.');
    const last = ks.pop();
    ks.reduce((o, k) => o[k], obj)[last] = v;
  }
  const round4 = (n) => Math.round(n * 10000) / 10000;

  function buildSettingsFields() {
    const box = $('#settingsFields');
    box.replaceChildren(...SETTINGS_SCHEMA.map((g) =>
      el('fieldset', {}, [
        el('legend', { text: g.group }),
        ...g.fields.map((f) =>
          el('label', { class: 'field-row' }, [
            el('span', { text: f.label }),
            f.options ? el('span', { class: 'field-input' }, [
              el('select', { name: f.path }, f.options.map(([v, t]) => el('option', { value: String(v), text: t, selected: v === TP.fare.snapRangePick(getPath(settings(), f.path)) }))),
            ]) : el('span', { class: 'field-input' }, [
              el('input', { type: 'number', name: f.path, min: f.min, step: f.step, required: true, value: String(round4(getPath(settings(), f.path) * (f.scale || 1))) }),
              el('span', { class: 'unit', text: f.unit }),
            ]),
          ])
        ),
      ])
    ));
  }

  function refreshKakaoStatus() {
    const box = $('#kakaoKeyStatus');
    const G = TP.kakao;
    const show = () => {
      const st = G.status();
      box.textContent =
        st.state === 'ready' ? '현재 카카오 지도/검색 사용 중' :
        st.state === 'failed' ? `카카오 SDK 로드 실패 - 지도를 표시할 수 없고 OSM 검색을 사용 중 (${st.error})` :
        st.state === 'loading' ? '카카오 SDK 로드 중…' :
        '키가 없어 지도를 표시할 수 없고 OSM(Nominatim) 검색을 사용 중';
    };
    show();
    if (G.status().state === 'loading') G.load().then(show);
  }

  function openSettings() {
    buildSettingsFields();
    refreshKakaoStatus();
    $('#settingsDialog').showModal();
  }

  function submitSettings() {
    for (const g of SETTINGS_SCHEMA) {
      for (const f of g.fields) {
        if (f.options) {
          const sel = $(`#settingsFields select[name="${f.path}"]`);
          setPath(settings(), f.path, TP.fare.snapRangePick(Number(sel.value)));
          continue;
        }
        const input = $(`#settingsFields input[name="${f.path}"]`);
        let v = Number(input.value);
        if (!isFinite(v)) continue;
        v = Math.max(f.min, v) / (f.scale || 1);
        if (f.int) v = Math.round(v);
        setPath(settings(), f.path, v);
      }
    }
    S.save();
    $('#settingsDialog').close();
    renderAll();
    toast('설정을 저장했어요');
  }

  // ---- 테마 표시 (헤더 아이콘 + 메뉴/설정의 선택 상태) ----
  const THEME_LABEL = { system: '시스템', light: '라이트', dark: '다크' };
  const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
  function renderThemeUI(pref) {
    pref = pref || TP.theme.get();
    $('#themeIcon').setAttribute('href', '#i-' + THEME_ICON[pref]);
    const label = '테마: ' + THEME_LABEL[pref];
    $('#themeBtn').title = label;
    $('#themeBtn').setAttribute('aria-label', label);
    for (const b of document.querySelectorAll('[data-theme-choice]')) {
      const on = b.dataset.themeChoice === pref;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('active', on);
    }
  }

  // ---- 내보내기 / 가져오기 ----
  /** tripId를 주면 그 여행만, 없으면 모든 여행을 내보낸다 */
  function exportFile(tripId) {
    if (!S.state.trips.length) return toast('내보낼 여행이 없어요');
    const one = typeof tripId === 'string' ? S.state.trips.find((x) => x.id === tripId) : null;
    if (typeof tripId === 'string' && !one) return;
    const blob = new Blob([S.exportJSON(one && one.id)], { type: 'application/json' });
    const name = one ? one.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) : '';
    const a = el('a', { href: URL.createObjectURL(blob), download: `trip-planner-${name ? name + '-' : ''}${S.todayYmd()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('파일이 너무 커요 (5MB 이하)');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const n = S.importJSON(String(reader.result));
        selectedId = null;
        // 하나면 바로 열고, 여러 개면 메인에서 목록으로 보여준다
        navigate(n === 1 ? TP.trips.tripHash(S.state.currentTripId) : TP.trips.MAIN_HASH);
        toast(`여행 ${n}개를 가져왔어요`);
      } catch (e) {
        toast(e.message || '가져오기에 실패했어요');
      }
    };
    reader.onerror = () => toast('파일을 읽을 수 없어요');
    reader.readAsText(file);
  }

  // =====================================================================
  // 로그인 / 회원가입 / 저장 상태
  // =====================================================================
  const BANNER_KEY = 'tripplanner.hideGuestBanner';
  const USER_RE = /^[a-zA-Z0-9_]{3,20}$/;
  let authMode = 'login';

  function bannerHidden() {
    try {
      return localStorage.getItem(BANNER_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function renderAuth() {
    const u = TP.auth.current();
    $('#authGuest').hidden = !!u;
    $('#guestMenuWrap').hidden = !!u;
    $('#authUser').hidden = !u;
    $('#userName').textContent = u ? u.username : '';
    $('#userNameMenu').textContent = u ? u.username : '';
    $('#userAvatar').textContent = u ? Array.from(u.username)[0].toUpperCase() : '';
    $('#userBtn').title = u ? '계정: ' + u.username : '계정';
    $('#userBtn').setAttribute('aria-label', u ? '계정 메뉴 (' + u.username + ')' : '계정 메뉴');
    if (u && !$('#userMenu').hidden) UI.closeMenus();
    $('#guestBanner').hidden = !!u || bannerHidden();
    // 홈 화면의 로그인 안내는 상단 배너가 이미 보일 때는 겹치지 않게 숨긴다
    $('#homeGuestNote').hidden = !!u || !bannerHidden();
  }

  function renderSaveStatus(st) {
    const b = $('#saveStatus');
    b.hidden = st.state === 'idle' || !TP.auth.current();
    b.className = 'save-status ' + st.state;
    const text = st.state === 'saving' ? '저장 중…' : st.state === 'saved' ? '저장됨' : st.state === 'error' ? '저장 실패 - 다시 시도' : '';
    b.querySelector('.save-text').textContent = text;
    b.setAttribute('aria-label', text);
    b.title = st.state === 'error' ? st.message || text : text;
    b.disabled = st.state !== 'error';
  }

  function setAuthMode(mode) {
    authMode = mode;
    for (const t of document.querySelectorAll('#authTabs .tab')) {
      const on = t.dataset.mode === mode;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    $('#authTitle').textContent = mode === 'login' ? '로그인' : '회원가입';
    $('#authPass2Row').hidden = mode === 'login';
    $('#authHint').hidden = mode === 'login';
    $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#authSubmit').textContent = mode === 'login' ? '로그인' : '가입하고 시작하기';
    showAuthError('');
  }

  function showAuthError(msg) {
    const p = $('#authError');
    p.textContent = msg;
    p.hidden = !msg;
  }

  function openAuth(mode) {
    $('#authForm').reset();
    setAuthMode(mode);
    $('#authDialog').showModal();
    $('#authName').focus();
  }

  function validateAuth(name, pass, pass2) {
    if (!name) return '아이디를 입력해 주세요.';
    if (!USER_RE.test(name)) return '아이디는 3~20자의 영문, 숫자, 밑줄(_)만 사용할 수 있어요.';
    if (!pass) return '비밀번호를 입력해 주세요.';
    if (authMode === 'signup') {
      if (pass.length < 8 || pass.length > 72) return '비밀번호는 8~72자로 입력해 주세요.';
      if (pass !== pass2) return '비밀번호 확인이 일치하지 않아요.';
    }
    return '';
  }

  async function submitAuth() {
    const name = $('#authName').value.trim();
    const pass = $('#authPass').value;
    const err = validateAuth(name, pass, $('#authPass2').value);
    if (err) return showAuthError(err);
    showAuthError('');
    const btn = $('#authSubmit');
    btn.disabled = true;
    const signingUp = authMode === 'signup';
    try {
      const r = signingUp ? await TP.auth.signup(name, pass) : await TP.auth.login(name, pass);
      $('#authDialog').close();
      $('#authForm').reset();
      toast(signingUp ? `${r.username}님, 가입을 환영해요` : `${r.username}님, 환영해요`);
    } catch (e) {
      showAuthError(e.message || '요청에 실패했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      btn.disabled = false;
    }
  }

  function showPwError(msg) {
    const p = $('#pwError');
    p.textContent = msg;
    p.hidden = !msg;
  }

  function openPassword() {
    $('#pwForm').reset();
    showPwError('');
    $('#pwDialog').showModal();
    $('#pwCur').focus();
  }

  async function submitPassword() {
    const cur = $('#pwCur').value;
    const next = $('#pwNew').value;
    let err = '';
    if (!cur) err = '현재 비밀번호를 입력해 주세요.';
    else if (next.length < 8 || next.length > 72) err = '새 비밀번호는 8~72자로 입력해 주세요.';
    else if (next !== $('#pwNew2').value) err = '새 비밀번호 확인이 일치하지 않아요.';
    if (err) return showPwError(err);
    showPwError('');
    const btn = $('#pwSubmit');
    btn.disabled = true;
    try {
      await TP.auth.changePassword(cur, next);
      $('#pwDialog').close();
      $('#pwForm').reset();
      toast('비밀번호를 변경했어요');
    } catch (e) {
      showPwError(e.message || '요청에 실패했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      btn.disabled = false;
    }
  }

  function bindAuth() {
    $('#btnLogin').addEventListener('click', () => openAuth('login'));
    $('#btnSignup').addEventListener('click', () => openAuth('signup'));
    $('#btnLoginMenu').addEventListener('click', () => openAuth('login'));
    $('#btnSignupMenu').addEventListener('click', () => openAuth('signup'));
    $('#btnBannerLogin').addEventListener('click', () => openAuth('login'));
    $('#btnBannerClose').addEventListener('click', () => {
      try {
        localStorage.setItem(BANNER_KEY, '1');
      } catch (e) {
        /* 이번 방문에만 숨김 */
      }
      $('#guestBanner').hidden = true;
      $('#homeGuestNote').hidden = !!TP.auth.current();
    });
    $('#btnHomeLogin').addEventListener('click', () => openAuth('login'));
    $('#btnPassword').addEventListener('click', openPassword);
    $('#pwForm').addEventListener('submit', (e) => { e.preventDefault(); submitPassword(); });
    $('#btnLogout').addEventListener('click', async () => {
      if (await TP.auth.logout()) toast('로그아웃했어요');
    });
    for (const t of document.querySelectorAll('#authTabs .tab')) t.addEventListener('click', () => setAuthMode(t.dataset.mode));
    $('#authForm').addEventListener('submit', (e) => { e.preventDefault(); submitAuth(); });
    $('#saveStatus').addEventListener('click', () => TP.auth.retry());

    TP.auth.on('status', renderSaveStatus);
    TP.auth.on('notice', toast);
    TP.auth.on('change', () => {
      // 로그인/로그아웃/서버 데이터 로드로 여행 목록이 바뀜
      selectedId = null;
      TP.map.clearExtra();
      renderAuth();
      renderSaveStatus(TP.auth.status());
      applyRoute({ force: true }); // 새 여행 목록에 맞게 주소를 다시 확인 (없는 여행이면 메인)
    });
    renderAuth();
    renderSaveStatus(TP.auth.status());
  }

  // =====================================================================
  // 초기화
  // =====================================================================
  function bind() {
    UI.initSidebars();
    // 헤더 드롭다운 메뉴들 (Esc/바깥 클릭으로 닫힘, 화살표 키 이동)
    UI.menu($('#tripMenuBtn'), $('#tripMenu'), { align: 'start' });
    UI.menu($('#tripMoreBtn'), $('#tripMoreMenu'), { align: 'start' });
    UI.menu($('#themeBtn'), $('#themeMenu'), { align: 'end' });
    UI.menu($('#guestMenuBtn'), $('#guestMenu'), { align: 'end' });
    UI.menu($('#userBtn'), $('#userMenu'), { align: 'end' });

    // 테마 (헤더 메뉴와 설정 창의 선택이 같은 값을 공유)
    for (const b of document.querySelectorAll('[data-theme-choice]')) b.addEventListener('click', () => TP.theme.set(b.dataset.themeChoice));
    TP.theme.onChange(renderThemeUI);
    renderThemeUI();

    $('#btnNewTrip').addEventListener('click', () => openTripDialog('new'));
    $('#btnEditTrip').addEventListener('click', () => openTripDialog('edit'));
    $('#btnDeleteTrip').addEventListener('click', () => deleteTrip());
    $('#btnHomeNew').addEventListener('click', () => openTripDialog('new'));
    $('#btnMainNew').addEventListener('click', () => openTripDialog('new'));
    $('#btnMainSample').addEventListener('click', createSampleTrip);
    $('#btnMainImport').addEventListener('click', () => $('#fileImport').click());
    $('#btnHomeSample').addEventListener('click', createSampleTrip);
    $('#btnHomeImport').addEventListener('click', () => $('#fileImport').click());
    $('#btnDeleteDay').addEventListener('click', deleteDay);
    $('#btnLegsToggle').addEventListener('click', (e) => setAllLegs(e.currentTarget.dataset.action === 'collapse'));
    $('#btnRetry').addEventListener('click', () => { TP.routing.clearFailures(); renderAll(); });

    $('#itemFixedEnd').addEventListener('input', syncItemTimeFields);
    $('#itemFixedStart').addEventListener('input', syncItemTimeFields);
    $('#peopleInput').addEventListener('change', (e) => {
      settings().people = Math.min(99, Math.max(1, Math.round(Number(e.target.value) || 1)));
      S.save();
      renderAll();
    });
    $('#showAll').addEventListener('change', (e) => {
      S.state.showAll = e.target.checked;
      S.save();
      renderMap(true);
    });

    // 검색
    $('#searchInput').addEventListener('input', onSearchInput);
    $('#searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        const q = e.target.value.trim();
        if (q.length >= 1) runSearch(q);
      } else if (e.key === 'Escape') hideResults();
    });
    $('#btnSearch').addEventListener('click', () => {
      clearTimeout(searchTimer);
      const q = $('#searchInput').value.trim();
      if (q) runSearch(q);
    });

    // 다이얼로그
    for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
    $('#tripForm').addEventListener('submit', (e) => { e.preventDefault(); submitTrip(); });
    $('#tripStart').addEventListener('input', () => { syncTripDates(true); showTripError(''); });
    $('#tripEnd').addEventListener('input', () => { syncTripDates(false); showTripError(''); });
    $('#legForm').addEventListener('submit', (e) => { e.preventDefault(); submitLeg(false); });
    $('#btnLegClear').addEventListener('click', () => submitLeg(true));
    $('#itemForm').addEventListener('submit', (e) => { e.preventDefault(); submitItem(); });
    $('#settingsForm').addEventListener('submit', (e) => { e.preventDefault(); submitSettings(); });
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnSettingsMenu').addEventListener('click', openSettings);
    $('#btnResetSettings').addEventListener('click', () => {
      if (!confirm('모든 설정을 기본값으로 되돌릴까요?')) return;
      S.resetSettings();
      buildSettingsFields();
    });

    $('#btnExport').addEventListener('click', () => exportFile());
    $('#btnImport').addEventListener('click', () => $('#fileImport').click());
    $('#fileImport').addEventListener('change', (e) => {
      importFile(e.target.files[0]);
      e.target.value = '';
    });

    bindAuth();

    $('#itemCat').replaceChildren(...TP.CATEGORIES.map((c) => el('option', { value: c.id, text: c.label })));

    // 스크롤하면 고정된 검색 바 아래에 그림자 (데스크톱은 패널이, 모바일은 .layout이 스크롤된다)
    const panel = $('#panel');
    const searchBar = $('#searchBar');
    const onScroll = () => searchBar.classList.toggle('scrolled', panel.scrollTop > 4 || panel.getBoundingClientRect().top < searchBar.getBoundingClientRect().top - 4);
    panel.addEventListener('scroll', onScroll, { passive: true });
    $('.layout').addEventListener('scroll', onScroll, { passive: true });
  }

  function initSortable() {
    if (!window.Sortable) return;
    Sortable.create($('#itemList'), {
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'drag-ghost',
      onStart: () => { dragging = true; },
      onEnd: (evt) => {
        dragging = false;
        pendingRender = false;
        if (evt.oldIndex !== evt.newIndex && evt.oldIndex != null) reorder(evt.oldIndex, evt.newIndex);
        renderAll(); // 순서가 바뀌었으니 구간/시간/비용을 다시 계산
      },
    });
  }

  function start() {
    S.load();
    TP.auth.restore(); // 마지막 로그인 사용자의 캐시가 있으면 서버 확인 전에 먼저 표시
    bind();
    initSortable();
    window.addEventListener('hashchange', () => applyRoute());
    applyRoute(); // 첫 화면: 주소에 맞는 여행 화면, 아니면 메인 (지도는 여행 화면에 들어갈 때 만든다)
    // 서버 세션 확인 + 서버 데이터 불러오기 (게스트면 아무 일도 없음). 끝나면 주소가 올바른지 한 번 더 확인한다
    TP.auth.init().finally(() => {
      authReady = true;
      applyRoute();
    });
  }

  document.addEventListener('DOMContentLoaded', start);
})();

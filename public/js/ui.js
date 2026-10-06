/* ui.js - 공용 UI 도구: 아이콘(SVG 스프라이트), 테마(시스템/라이트/다크), 드롭다운 메뉴, 노선 배지.
 * 스프라이트는 index.html 맨 위의 <symbol id="i-이름"> 정의를 <use>로 참조한다. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // =====================================================================
  // 아이콘
  // =====================================================================
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  const MODE_ICON = { walk: 'walk', bike: 'bike', transit: 'bus', taxi: 'taxi', car: 'car' };
  const CAT_ICON = { sight: 'landmark', food: 'utensils', stay: 'bed', cafe: 'coffee', shop: 'bag', etc: 'map-pin' };
  const modeIcon = (id, cls) => icon(MODE_ICON[id] || 'bus', cls);

  /** 카테고리 아이콘: 색이 입혀진 작은 원형 칩 */
  function catIcon(id) {
    const n = document.createElement('span');
    n.className = 'cat-ico cat-' + (CAT_ICON[id] ? id : 'etc');
    n.append(icon(CAT_ICON[id] || 'map-pin'));
    return n;
  }

  // =====================================================================
  // 색상 도우미: 배경색 위에 올릴 글자색 (흰색 대비가 3:1 이상이면 흰색)
  // =====================================================================
  function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 0;
    const v = [0, 2, 4].map((i) => {
      const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  const inkOn = (hex) => (1.05 / (luminance(hex) + 0.05) >= 3.3 ? '#ffffff' : '#111827');

  // =====================================================================
  // 노선 배지 ("5호선", "7212")
  // =====================================================================
  const LINE_COLORS = [
    [/공항철도/, '#0090d2'], [/신분당/, '#d31145'], [/경의|중앙선/, '#77c4a3'], [/수인|분당/, '#e6a100'], [/경춘/, '#0c8e72'],
    [/우이/, '#b0ce18'], [/신림/, '#6789ca'], [/의정부/, '#fd8100'], [/에버라인|용인/, '#56ad2d'], [/김포/, '#a17800'], [/서해/, '#81a914'],
    [/GTX/i, '#9a6292'], [/^1호선$/, '#0052a4'], [/^2호선$/, '#00a84d'], [/^3호선$/, '#ef7c1c'], [/^4호선$/, '#00a5de'], [/^5호선$/, '#996cac'],
    [/^6호선$/, '#cd7c2f'], [/^7호선$/, '#747f00'], [/^8호선$/, '#e6186c'], [/^9호선$/, '#bdb092'],
  ];
  const lineColor = (name) => {
    for (const [re, c] of LINE_COLORS) if (re.test(name)) return c;
    return null;
  };

  /** 대중교통 경로의 탑승 구간을 작은 색 배지로 (도보 구간 생략, 탑승이 없으면 도보) */
  function routePills(route) {
    const box = document.createElement('span');
    box.className = 'route-pills';
    const rides = route.steps.filter((s) => s.type !== 'WALKING');
    if (!rides.length) {
      const p = document.createElement('span');
      p.className = 'line-pill walk';
      p.append(icon('walk'), document.createTextNode('도보'));
      box.append(p);
      return box;
    }
    rides.forEach((s, i) => {
      if (i > 0) box.append(icon('chevron-right', 'pill-sep'));
      const p = document.createElement('span');
      const isSubway = s.type === 'SUBWAY';
      p.className = 'line-pill ' + (isSubway ? 'subway' : 'bus');
      const name = TP.planner.stepName(s);
      const c = isSubway ? lineColor(name) : null;
      if (c) {
        p.style.setProperty('--pill-bg', c);
        p.style.setProperty('--pill-fg', inkOn(c));
        p.classList.add('has-color');
      }
      p.append(icon(isSubway ? 'train' : 'bus'), document.createTextNode(name));
      box.append(p);
    });
    return box;
  }

  // =====================================================================
  // 테마: 'system' | 'light' | 'dark'  (html[data-theme]는 light/dark로 해석된 값)
  // =====================================================================
  const THEME_KEY = 'tripplanner.theme';
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const themeListeners = [];

  function getPref() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch (e) {
      /* 저장소를 못 쓰면 시스템 설정 */
    }
    return 'system';
  }
  const resolve = (pref) => (pref === 'dark' || (pref === 'system' && mq && mq.matches) ? 'dark' : 'light');

  function applyTheme(pref) {
    const r = document.documentElement;
    r.setAttribute('data-theme', resolve(pref));
    r.setAttribute('data-theme-pref', pref);
    themeListeners.forEach((fn) => fn(pref, resolve(pref)));
  }

  function setTheme(pref) {
    if (!['system', 'light', 'dark'].includes(pref)) return;
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch (e) {
      /* 이번 방문에만 적용 */
    }
    applyTheme(pref);
  }

  if (mq) {
    const onSystem = () => {
      if (getPref() === 'system') applyTheme('system');
    };
    if (mq.addEventListener) mq.addEventListener('change', onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  }

  TP.theme = { get: getPref, set: setTheme, onChange: (fn) => themeListeners.push(fn) };

  // =====================================================================
  // 드롭다운 메뉴 (role=menu). 한 번에 하나만 열림. 화면 밖으로 나가지 않게 배치한다.
  // =====================================================================
  const menus = [];
  let openMenu = null;

  function closeAll(except) {
    for (const m of menus) if (m !== except && m.isOpen()) m.close();
  }

  /** menu(button, panel, { align: 'start'|'end', onOpen }) */
  function menu(btn, panel, opts) {
    opts = opts || {};
    const items = () => [...panel.querySelectorAll('[role^="menuitem"]')].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
    const isOpen = () => !panel.hidden;

    function place() {
      const M = 8;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      panel.style.left = '0px';
      panel.style.top = '0px';
      panel.style.maxHeight = '';
      const b = btn.getBoundingClientRect();
      const pw = panel.offsetWidth;
      let ph = panel.offsetHeight;
      let left = opts.align === 'end' ? b.right - pw : b.left;
      left = Math.max(M, Math.min(left, vw - pw - M));
      let top = b.bottom + 6;
      if (top + ph > vh - M) {
        const above = b.top - 6 - ph;
        if (above >= M) top = above;
        else {
          top = Math.max(M, vh - M - ph);
          panel.style.maxHeight = vh - M * 2 + 'px';
        }
      }
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    }

    function open(focusFirst) {
      closeAll(api);
      panel.style.visibility = 'hidden';
      panel.hidden = false;
      if (opts.onOpen) opts.onOpen();
      place();
      panel.style.visibility = '';
      btn.setAttribute('aria-expanded', 'true');
      openMenu = api;
      if (focusFirst) {
        const list = items();
        const cur = list.find((n) => n.getAttribute('aria-checked') === 'true') || list[0];
        if (cur) cur.focus();
      }
    }

    function close(returnFocus) {
      if (!isOpen()) return;
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (openMenu === api) openMenu = null;
      if (returnFocus) btn.focus();
    }

    // 동적으로 만든 메뉴(카드 목록 등)가 다시 그려질 때 등록을 풀어 쌓이지 않게 한다
    const destroy = () => {
      close();
      const i = menus.indexOf(api);
      if (i >= 0) menus.splice(i, 1);
    };
    const api = { btn, panel, open, close, isOpen, place, destroy };
    menus.push(api);

    btn.addEventListener('click', (e) => {
      if (isOpen()) close();
      else open(e.detail === 0); // 키보드(Enter/Space)로 눌렀으면 첫 항목에 포커스
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen()) open(true);
      }
    });
    panel.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        (list[(i + 1) % list.length] || list[0]).focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (list[(i - 1 + list.length) % list.length] || list[list.length - 1]).focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (list[0]) list[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        if (list.length) list[list.length - 1].focus();
      } else if (e.key === 'Tab') {
        close();
      }
    });
    // 항목을 고르면 메뉴를 닫는다 (동작은 각자의 click 핸들러가 처리)
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[role^="menuitem"]')) close(true);
    });
    return api;
  }

  // 바깥 클릭 / 창 크기 변화 / 스크롤 시 닫기
  document.addEventListener('pointerdown', (e) => {
    if (!openMenu) return;
    if (openMenu.panel.contains(e.target) || openMenu.btn.contains(e.target)) return;
    openMenu.close();
  });
  window.addEventListener('resize', () => closeAll());
  window.addEventListener('scroll', (e) => {
    if (openMenu && !openMenu.panel.contains(e.target)) openMenu.close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) openMenu.close(true);
  });

  // =====================================================================
  // 사이드바 접기/펼치기 (좌: 일정, 우: 요약). 상태는 localStorage에 'collapsed'/'open'으로 저장.
  // 저장값이 없으면 좌측은 펼침, 우측은 중간 폭(<1024px)에서만 접힘. 모바일(<768px)은 CSS가 항상 펼친다.
  // =====================================================================
  const narrow = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : null;

  /** sidebar(side, button, { key, side, label, defaultCollapsed }) - side는 .side 래퍼 */
  function sidebar(side, btn, opts) {
    let stored = null;
    try {
      const v = localStorage.getItem(opts.key);
      if (v === 'collapsed' || v === 'open') stored = v;
    } catch (e) {
      /* 저장소를 못 쓰면 기본값 */
    }
    const use = btn.querySelector('use');
    function apply(collapsed) {
      side.classList.toggle('is-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      const text = opts.label + (collapsed ? ' 펼치기' : ' 접기');
      btn.setAttribute('aria-label', text);
      btn.title = text;
      // 아이콘은 "누르면 일어날 동작" 방향: 좌측은 접기=왼쪽, 우측은 접기=오른쪽
      const left = opts.side === 'left';
      use.setAttribute('href', left !== collapsed ? '#i-chevron-left' : '#i-chevron-right');
    }
    apply(stored ? stored === 'collapsed' : opts.defaultCollapsed ? opts.defaultCollapsed() : false);
    btn.addEventListener('click', () => {
      const next = !side.classList.contains('is-collapsed');
      apply(next);
      try {
        localStorage.setItem(opts.key, next ? 'collapsed' : 'open');
      } catch (e) {
        /* 이번 방문에만 적용 */
      }
    });
  }

  function initSidebars() {
    const $ = (id) => document.getElementById(id);
    sidebar($('sideLeft'), $('toggleLeft'), { key: 'tripplanner.ui.left', side: 'left', label: '일정' });
    sidebar($('sideRight'), $('toggleRight'), { key: 'tripplanner.ui.right', side: 'right', label: '요약', defaultCollapsed: () => !!(narrow && narrow.matches) });
  }

  TP.ui = { initSidebars, icon, modeIcon, catIcon, inkOn, routePills, menu, closeMenus: () => closeAll(), MODE_ICON, CAT_ICON };
})();

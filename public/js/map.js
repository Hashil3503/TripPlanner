/* map.js - 카카오 지도: 번호 마커(CustomOverlay), 경로 폴리라인, 클릭/검색 결과 팝업.
 * 사용자 텍스트는 항상 DOM(textContent)으로 넣어 XSS를 방지한다.
 * SDK는 js/kakao.js 의 공유 로더로 불러오며, 로드 전에 들어온 render/fit 호출은 저장해 두었다가 지도가 준비되면 실행한다. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  let map = null;
  let handlers = {};
  let container = null;
  const pending = { model: null, fit: false }; // 지도 준비 전에 받은 요청
  const items = []; // 일정 마커/경로 (다시 그릴 때 제거)
  let extra = []; // 검색 미리보기/클릭 팝업 오버레이
  const markers = new Map(); // itemId -> { pos, point, group }
  let lastBounds = null; // kakao LatLngBounds
  let lastCount = 0;
  let infoOverlay = null; // 일정 마커 팝업
  let infoId = null; // 열려 있는 팝업의 일정 id
  let legTip = null; // 경로선 툴팁

  const Z = { dim: 1, line: 2, pin: 10, selected: 30, preview: 40, popup: 100 };

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 오버레이 위에서 발생한 마우스/터치 이벤트가 지도(드래그/클릭)로 전달되지 않게 한다 */
  function shield(node) {
    for (const ev of ['click', 'dblclick', 'mousedown', 'touchstart', 'contextmenu']) node.addEventListener(ev, (e) => e.stopPropagation());
    return node;
  }

  const latlng = (lat, lon) => new kakao.maps.LatLng(lat, lon);

  // ---- 초기화 / 오류 안내 ----
  function showMessage(title, lines, steps) {
    container.classList.add('map-failed');
    const box = h('div', 'map-msg');
    box.append(h('strong', null, title));
    for (const l of lines) box.append(h('p', null, l));
    if (steps) {
      const ol = h('ol');
      for (const s of steps) ol.append(h('li', null, s));
      box.append(ol);
    }
    container.replaceChildren(box);
  }

  function showKeyHelp(state, error) {
    const title = state === 'none' ? '카카오 지도 키가 설정되지 않았어요' : '카카오 지도를 불러오지 못했어요';
    const lines = state === 'none' ? ['지도를 표시하려면 카카오 JavaScript 키가 필요해요. 그 외 기능(일정 편집, 계산, 검색)은 그대로 사용할 수 있어요.'] : [error ? `사유: ${error}` : '', '키, 도메인 등록, 카카오맵 사용 설정, 네트워크 연결을 확인해 주세요.'].filter(Boolean);
    showMessage(title, lines, [
      'Kakao Developers(developers.kakao.com)에서 앱을 만들고 JavaScript 키를 복사해요.',
      '앱 > 플랫폼 > Web에 http://localhost:8000 을 등록하고, 앱 설정에서 카카오맵을 사용 설정해요.',
      'public/js/config.local.js 에 window.TP_CONFIG = { kakaoJsKey: \'키\' }; 를 넣거나, 설정의 "카카오 JavaScript 키"에 입력한 뒤 새로고침해요.',
    ]);
  }

  function init(elId, hs) {
    handlers = hs || {};
    container = document.getElementById(elId);
    container.classList.remove('map-failed');
    container.replaceChildren(h('div', 'map-msg', '지도를 불러오는 중…'));
    container.classList.add('map-failed');
    TP.kakao.load().then((ok) => {
      if (!ok) {
        const st = TP.kakao.status();
        showKeyHelp(st.state, st.error);
        return;
      }
      try {
        create();
      } catch (e) {
        console.warn(e);
        showKeyHelp('failed', e && e.message ? e.message : '지도 생성 실패');
      }
    });
    return true;
  }

  function create() {
    container.classList.remove('map-failed');
    container.replaceChildren();
    map = new kakao.maps.Map(container, { center: latlng(37.5665, 126.978), level: 7 });
    map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT);
    map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);

    legTip = new kakao.maps.CustomOverlay({ content: h('div', 'leg-tip'), xAnchor: 0.5, yAnchor: 1.6, zIndex: Z.popup, clickable: false });

    kakao.maps.event.addListener(map, 'click', (e) => {
      closeInfo();
      showPointPopup(e.latLng.getLat(), e.latLng.getLng());
    });
    if ('ResizeObserver' in window) new ResizeObserver(() => map && map.relayout()).observe(container);
    window.addEventListener('resize', () => map && map.relayout());

    if (pending.model) render(pending.model);
    if (pending.fit) fit();
    pending.model = null;
    pending.fit = false;
  }

  // ---- 마커 ----
  function pinNode(text, color, selected, dim, preview, title) {
    const wrap = h('div', 'pin-wrap');
    const pin = h('div', 'pin' + (selected ? ' selected' : '') + (dim ? ' dim' : '') + (preview ? ' preview' : ''));
    if (color) {
      pin.style.setProperty('--pin', color);
      pin.style.setProperty('--pin-ink', TP.ui.inkOn(color));
    }
    pin.append(h('span', null, String(text)));
    wrap.append(pin);
    if (title) wrap.title = title;
    return wrap;
  }

  // 핀 끝(회전한 모서리)이 좌표를 가리키도록 30px 상자 기준 세로 앵커를 1.2로 둔다
  function pinOverlay(lat, lon, node, zIndex) {
    return new kakao.maps.CustomOverlay({ position: latlng(lat, lon), content: node, xAnchor: 0.5, yAnchor: 1.2, zIndex, clickable: true });
  }

  /** 팝업 말풍선 오버레이: 좌표 위쪽에 표시 (bubble 내용은 DOM) */
  function bubbleOverlay(lat, lon, content, onClose) {
    const anchor = h('div', 'ov-anchor');
    const bubble = h('div', 'ov-bubble');
    const close = h('button', 'ov-close');
    close.append(TP.ui.icon('x'));
    close.type = 'button';
    close.title = '닫기';
    close.setAttribute('aria-label', '닫기');
    close.addEventListener('click', onClose);
    bubble.append(close, content);
    anchor.append(bubble);
    shield(anchor);
    return new kakao.maps.CustomOverlay({ position: latlng(lat, lon), content: anchor, xAnchor: 0, yAnchor: 0, zIndex: Z.popup, clickable: true });
  }

  function itemPopup(p) {
    const box = h('div', 'popup');
    const title = h('div', 'popup-title');
    const num = h('span', 'popup-num', String(p.number));
    num.style.background = markers.get(p.item.id) ? markers.get(p.item.id).group.color : '';
    num.style.color = markers.get(p.item.id) ? TP.ui.inkOn(markers.get(p.item.id).group.color) : '';
    title.append(num, h('strong', null, p.item.name));
    const cat = TP.catOf(p.item.category);
    const sub = h('div', 'popup-sub');
    sub.append(TP.ui.catIcon(p.item.category), h('span', null, cat.label), h('span', 'popup-dot', '·'), TP.ui.icon('clock'), h('span', null, `${TP.fmt.fmtTime(p.arrival)} 도착`));
    box.append(title, sub);
    return box;
  }

  function legTooltip(leg) {
    const mode = TP.fare.MODES.find((m) => m.id === leg.mode);
    const box = h('div', 'popup');
    const title = h('div', 'popup-title');
    const ico = TP.ui.modeIcon(leg.mode, 'm-' + leg.mode);
    title.append(ico, h('strong', null, mode.label));
    box.append(title);
    if (leg.transitReal) box.append(TP.ui.routePills(leg.transitReal.route));
    const sub = `${TP.fmt.fmtDuration(leg.durationMin)} · ${TP.fmt.fmtDist(leg.distance)} · ${TP.fmt.fmtWon(leg.cost.total)}`;
    box.append(h('div', 'popup-sub num', sub));
    return box;
  }

  function closeInfo() {
    if (infoOverlay) infoOverlay.setMap(null);
    infoOverlay = null;
    infoId = null;
  }

  function openInfo(id) {
    const m = markers.get(id);
    if (!map || !m) return;
    closeInfo();
    infoId = id;
    infoOverlay = bubbleOverlay(m.item.lat, m.item.lon, itemPopup(m.point), closeInfo);
    infoOverlay.setMap(map);
  }

  function attachLegTip(line, leg) {
    const content = legTip.getContent();
    kakao.maps.event.addListener(line, 'mouseover', (e) => {
      content.replaceChildren(legTooltip(leg));
      legTip.setPosition(e.latLng);
      legTip.setMap(map);
    });
    kakao.maps.event.addListener(line, 'mousemove', (e) => legTip.setPosition(e.latLng));
    kakao.maps.event.addListener(line, 'mouseout', () => legTip.setMap(null));
  }

  const STEP_STYLE = { SUBWAY: { weight: 7, style: 'solid' }, BUS: { weight: 5, style: 'solid' } };
  const near = (a, b) => Math.abs(a[0] - b[0]) < 3e-5 && Math.abs(a[1] - b[1]) < 3e-5; // 약 3m 이내

  /** 대중교통 실경로 -> 조각 목록: 탑승 구간(실선), 도보 구간과 빈 구간(출발지 -> 첫 정류장, 마지막 정류장 -> 도착지, 구간 사이)은 점선 */
  function transitPieces(leg) {
    const pieces = [];
    let cursor = [leg.from.lat, leg.from.lon];
    for (const step of leg.transitReal.route.steps) {
      if (step.path.length < 2) continue;
      if (!near(cursor, step.path[0])) pieces.push({ walk: true, path: [cursor, step.path[0]] });
      pieces.push({ walk: step.type === 'WALKING', type: step.type, path: step.path });
      cursor = step.path[step.path.length - 1];
    }
    const dest = [leg.to.lat, leg.to.lon];
    if (!near(cursor, dest)) pieces.push({ walk: true, path: [cursor, dest] });
    return pieces;
  }

  function addLine(leg, path, color, weight, opacity, strokeStyle, zIndex) {
    const line = new kakao.maps.Polyline({
      path: path.map((c) => latlng(c[0], c[1])), // routing.js는 [lat, lon]으로 저장한다
      strokeWeight: weight,
      strokeColor: color,
      strokeOpacity: opacity,
      strokeStyle,
      zIndex,
    });
    line.setMap(map);
    attachLegTip(line, leg);
    items.push(line);
  }

  function clearItems() {
    for (const o of items) o.setMap(null);
    items.length = 0;
    markers.clear();
    if (legTip) legTip.setMap(null);
  }

  /** model: { groups: [{ dayIndex, color, active, points:[{item, number, arrival}], legs:[leg] }], selectedId } */
  function render(model) {
    if (!map) {
      pending.model = model;
      return;
    }
    const keepInfo = infoId;
    closeInfo();
    clearItems();
    const bounds = new kakao.maps.LatLngBounds();
    let count = 0;
    for (const g of model.groups) {
      const dim = !g.active;
      // 경로: 조회 성공한 도로 경로는 실선, 대중교통(추정)/조회 실패는 점선
      for (const leg of g.legs) {
        const z = dim ? Z.dim : Z.line;
        if (leg.transitReal && !leg.loading) {
          // 카카오 대중교통 실경로: 버스/지하철은 실선(지하철이 조금 더 굵게), 도보·빈 구간은 가는 점선
          for (const p of transitPieces(leg)) {
            if (p.walk) addLine(leg, p.path, g.color, dim ? 2 : 3, dim ? 0.35 : 0.8, 'shortdot', z);
            else {
              const st = STEP_STYLE[p.type] || STEP_STYLE.BUS;
              addLine(leg, p.path, g.color, dim ? Math.max(3, st.weight - 2) : st.weight, dim ? 0.35 : 0.85, st.style, z + 0.1);
            }
          }
          continue;
        }
        const dashed = leg.transit || leg.estimated || leg.loading;
        addLine(leg, leg.geometry, g.color, dim ? 3 : 5, dim ? 0.35 : 0.85, dashed ? 'dash' : 'solid', z);
      }
      for (const p of g.points) {
        const selected = p.item.id === model.selectedId;
        const node = pinNode(p.number, g.color, selected, dim, false, p.item.name);
        node.addEventListener('click', (e) => {
          e.stopPropagation();
          handlers.onSelect && handlers.onSelect(p.item.id, g.dayIndex);
        });
        shield(node);
        const ov = pinOverlay(p.item.lat, p.item.lon, node, selected ? Z.selected : dim ? Z.dim + 5 : Z.pin);
        ov.setMap(map);
        items.push(ov);
        markers.set(p.item.id, { pos: latlng(p.item.lat, p.item.lon), item: p.item, point: p, group: g });
        bounds.extend(latlng(p.item.lat, p.item.lon));
        count++;
      }
    }
    lastBounds = bounds;
    lastCount = count;
    if (keepInfo && markers.has(keepInfo)) openInfo(keepInfo);
  }

  /** 현재 표시 중인 마커 전체가 보이도록 이동 */
  function fit() {
    if (!map) {
      pending.fit = true;
      return;
    }
    map.relayout();
    if (lastCount > 1) {
      map.setBounds(lastBounds, 50, 50, 50, 50);
      if (map.getLevel() < 3) map.setLevel(3); // 너무 가까운 점들이라도 과하게 확대하지 않음
    } else if (lastCount === 1) {
      map.setLevel(4);
      map.setCenter(lastBounds.getSouthWest());
    }
  }

  function panToItem(id, openPopup) {
    const m = markers.get(id);
    if (!map || !m) return;
    map.panTo(m.pos);
    if (openPopup) openInfo(id);
  }

  // ---- 추가 가능한 지점 팝업 (지도 클릭 / 검색 결과 미리보기) ----
  function clearExtra() {
    for (const o of extra) o.setMap(null);
    extra = [];
  }

  function placePopup(place) {
    const box = h('div', 'popup');
    const title = h('strong', null, place.name || '위치 확인 중…');
    box.append(title);
    if (place.sub) box.append(h('div', 'popup-sub', place.sub));
    const btn = h('button', 'btn primary small');
    btn.append(TP.ui.icon('plus'), document.createTextNode('일정에 추가'));
    btn.type = 'button';
    btn.addEventListener('click', () => {
      clearExtra();
      handlers.onAddPlace && handlers.onAddPlace({ name: place.name, lat: place.lat, lon: place.lon, category: place.category || 'etc' });
    });
    box.append(btn);
    return { box, title };
  }

  function showPreview(place, box) {
    clearExtra();
    const pin = shield(pinNode('+', null, false, false, true));
    const pinOv = pinOverlay(place.lat, place.lon, pin, Z.preview);
    const bubble = bubbleOverlay(place.lat, place.lon, box, clearExtra);
    pinOv.setMap(map);
    bubble.setMap(map);
    extra.push(pinOv, bubble);
  }

  /** 검색 결과 등 이름이 정해진 장소를 표시하고 팝업을 연다 */
  function showPlace(place, doFit) {
    if (!map) return;
    closeInfo();
    showPreview(place, placePopup(place).box);
    if (doFit) {
      if (map.getLevel() > 3) map.setLevel(3);
      map.setCenter(latlng(place.lat, place.lon));
    }
  }

  let clickSeq = 0;
  /** 지도 클릭 지점: 역지오코딩으로 이름을 채운 뒤 추가 버튼 제공 */
  function showPointPopup(lat, lon) {
    if (!map) return;
    const seq = ++clickSeq;
    const place = { name: `선택한 위치 (${lat.toFixed(4)}, ${lon.toFixed(4)})`, lat, lon, category: 'etc' };
    const { box, title } = placePopup(place);
    title.textContent = '주소 조회 중…';
    showPreview(place, box);
    TP.geocode.reverse(lat, lon).then(
      (r) => {
        if (seq !== clickSeq) return;
        place.name = r.name;
        place.category = r.category;
        title.textContent = r.name;
      },
      () => {
        if (seq !== clickSeq) return;
        title.textContent = place.name; // 조회 실패 시 좌표 이름 사용
      }
    );
  }

  TP.map = { init, render, fit, panToItem, showPlace, clearExtra };
})();

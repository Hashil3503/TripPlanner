/* storage.js - 상태 관리, localStorage 저장/복원, JSON 내보내기/가져오기 */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const KEY = 'tripplanner.state.v1'; // 게스트(비로그인) 데이터
  const CLEANUP_KEY = 'tripplanner.cleanup.autoTrip'; // 예전 자동 생성 샘플 정리를 마쳤는지
  const userKey = (name) => `tripplanner.state.v1.user.${String(name).toLowerCase()}`; // 로그인 사용자별 캐시(서버가 원본)

  const CATEGORIES = [
    { id: 'sight', label: '관광', emoji: '🏛️' },
    { id: 'food', label: '식사', emoji: '🍽️' },
    { id: 'stay', label: '숙소', emoji: '🛏️' },
    { id: 'cafe', label: '카페', emoji: '☕' },
    { id: 'shop', label: '쇼핑', emoji: '🛍️' },
    { id: 'etc', label: '기타', emoji: '📍' },
  ];
  TP.CATEGORIES = CATEGORIES;
  TP.catOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // 기본값 위에 저장된 값을 덮어쓰기 (숫자 설정만 허용)
  function mergeSettings(base, saved) {
    const out = {};
    for (const k of Object.keys(base)) {
      if (isObj(base[k])) out[k] = mergeSettings(base[k], isObj(saved) ? saved[k] : null);
      else {
        const v = isObj(saved) ? saved[k] : undefined;
        out[k] = typeof v === 'number' && isFinite(v) ? v : base[k];
        if (k === 'rangePick') out[k] = TP.fare.snapRangePick(out[k]); // 0 / 0.5 / 1만 허용
      }
    }
    return out;
  }

  const num = (v, def, min, max) => {
    v = Number(v);
    if (!isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
  };
  const str = (v, def, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : def);
  const validDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const validTime = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '');

  function normItem(raw) {
    if (!isObj(raw)) return null;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const modes = TP.fare.MODES.map((m) => m.id);
    return {
      id: uid(),
      name: str(raw.name, '이름 없는 장소', 100),
      lat,
      lon,
      category: CATEGORIES.some((c) => c.id === raw.category) ? raw.category : 'etc',
      stay: Math.round(num(raw.stay, 60, 0, 1440)),
      memo: typeof raw.memo === 'string' ? raw.memo.slice(0, 500) : '',
      cost: Math.round(num(raw.cost, 0, 0, 1e9)), // 1인 입장료/기타 비용
      parking: Math.round(num(raw.parking, 0, 0, 1e9)), // 자가용 도착 시 주차비(총액)
      modeIn: modes.includes(raw.modeIn) ? raw.modeIn : null, // 이전 장소에서 오는 이동수단 (null = 자동)
      transitIdx: Number.isInteger(raw.transitIdx) && raw.transitIdx >= 0 && raw.transitIdx < 5 ? raw.transitIdx : null, // 대중교통 대안 경로 번호 (null = 가장 빠른 경로)
      legMin: Number.isInteger(raw.legMin) && raw.legMin >= 0 && raw.legMin <= 4320 ? raw.legMin : null, // 이전 장소에서 오는 이동 시간 직접 입력(분, null = 자동)
      legCost: Number.isInteger(raw.legCost) && raw.legCost >= 0 && raw.legCost <= 1e8 ? raw.legCost : null, // 이동 요금 직접 입력(원, 대중교통·도보·자전거는 1인, 택시·자가용은 차량 1대 총액, null = 자동)
    };
  }

  function normDay(raw) {
    const d = isObj(raw) ? raw : {};
    return {
      id: uid(),
      startTime: validTime(d.startTime) || '09:00',
      items: (Array.isArray(d.items) ? d.items : []).slice(0, 200).map(normItem).filter(Boolean),
    };
  }

  function normTrip(raw) {
    const t = isObj(raw) ? raw : {};
    let days = (Array.isArray(t.days) ? t.days : []).slice(0, 60).map(normDay);
    if (!days.length) days = [normDay({})];
    return { id: uid(), name: str(t.name, '가져온 여행', 80), startDate: validDate(t.startDate), days };
  }

  const state = {
    version: 1,
    trips: [],
    currentTripId: null,
    dayIndex: 0,
    showAll: false,
    settings: mergeSettings(TP.fare.DEFAULT_CONFIG, null),
  };

  let storageKey = KEY; // 현재 저장 대상 localStorage 키 (게스트 / 사용자 캐시)
  const hooks = { onDirty: null }; // 로그인 상태에서 서버 동기화를 예약하는 훅 (auth.js)

  let saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (e) {
      console.warn('저장 실패', e);
    }
    if (hooks.onDirty) hooks.onDirty();
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
    if (hooks.onDirty) hooks.onDirty();
  }
  window.addEventListener('beforeunload', saveNow);

  function readSaved(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch (e) {
      return false;
    }
  }
  function writeFlag(key) {
    try {
      localStorage.setItem(key, '1');
    } catch (e) {
      /* 다음 방문에 다시 확인 */
    }
  }

  function resetState() {
    state.trips = [];
    state.currentTripId = null;
    state.dayIndex = 0;
    state.showAll = false;
    state.settings = mergeSettings(TP.fare.DEFAULT_CONFIG, null);
  }

  // 저장된 값을 state에 적용. 저장된 객체가 아니면 false (여행이 0개인 빈 목록은 유효한 저장 상태)
  function applySaved(saved) {
    if (!(isObj(saved) && Array.isArray(saved.trips))) return false;
    state.trips = saved.trips.map((t) => {
      const n = normTrip(t);
      if (isObj(t) && typeof t.id === 'string') n.id = t.id;
      return n;
    });
    state.currentTripId = state.trips.some((t) => t.id === saved.currentTripId) ? saved.currentTripId : state.trips.length ? state.trips[0].id : null;
    state.dayIndex = Math.max(0, Math.round(Number(saved.dayIndex) || 0));
    state.showAll = !!saved.showAll;
    state.settings = mergeSettings(TP.fare.DEFAULT_CONFIG, saved.settings);
    return true;
  }

  /** 게스트 데이터 불러오기. 여행이 없으면 빈 목록(자동으로 만들지 않는다). 예전 버전이 남긴 빈 '새 여행'은 정리한다. */
  function load() {
    storageKey = KEY;
    resetState();
    applySaved(readSaved(KEY));
    // 예전에는 첫 실행에 샘플 여행을 자동으로 만들었다. 그 손대지 않은 샘플은 한 번만 정리해서, 이후 직접 만든 샘플은 남긴다.
    const dropSample = !readFlag(CLEANUP_KEY);
    const kept = state.trips.filter((t) => !isPlaceholder(t) && !(dropSample && isSample(t)));
    const changed = kept.length !== state.trips.length;
    if (changed) {
      state.trips = kept;
      if (!kept.some((t) => t.id === state.currentTripId)) {
        state.currentTripId = kept.length ? kept[0].id : null;
        state.dayIndex = 0;
      }
    }
    if (dropSample) writeFlag(CLEANUP_KEY);
    if (changed) saveNow();
    clampDay();
  }

  /** 로그인 사용자의 localStorage 캐시로 전환한다. 캐시가 없으면 false(상태 변경 없음). 여행 0개인 캐시도 유효. */
  function useUserCache(username) {
    const saved = readSaved(userKey(username));
    if (!(isObj(saved) && Array.isArray(saved.trips))) return false;
    storageKey = userKey(username);
    resetState();
    applySaved(saved);
    clampDay();
    return true;
  }

  /** 로그아웃/세션 만료 시 이 기기에 남은 사용자 캐시를 지운다 (공용 PC 대비). 대기 중인 저장도 취소. */
  function clearUserCache(username) {
    clearTimeout(saveTimer);
    const key = userKey(username);
    if (storageKey === key) storageKey = KEY;
    try {
      localStorage.removeItem(key);
    } catch (e) {
      /* 저장소 접근 불가: 지울 것도 없음 */
    }
  }

  /** 서버 데이터로 상태를 교체한다. 화면 상태(현재 여행/일차)는 사용자 캐시에서 이어받는다. */
  function loadFromServer(username, trips, settings) {
    const prev = readSaved(userKey(username));
    storageKey = userKey(username);
    resetState();
    applySaved({
      trips,
      currentTripId: isObj(prev) ? prev.currentTripId : null,
      dayIndex: isObj(prev) ? prev.dayIndex : 0,
      showAll: isObj(prev) ? prev.showAll : false,
      settings,
    });
    clampDay();
    saveNow();
  }

  /** 게스트 데이터에서 아직 손대지 않은 샘플 여행인지 (이름 제외 내용 비교, 날짜/ID 무시) */
  function tripSig(t) {
    return JSON.stringify([t.name, t.days.map((d) => [d.startTime, d.items.map((i) => [i.name, i.lat, i.lon, i.category, i.stay, i.memo, i.cost, i.parking, i.modeIn])])]);
  }
  const isSample = (t) => tripSig(t) === tripSig(TP.sample.create());

  /** 예전 버전이 자동으로 만든 빈 자리표시 여행 (이름 '새 여행', 날짜 없음, 1일차, 일정 0개). 서버에서 받은 원본 객체에도 쓴다. */
  function isPlaceholder(t) {
    if (!isObj(t) || t.name !== '새 여행' || t.startDate) return false;
    const days = Array.isArray(t.days) ? t.days : [];
    return days.length <= 1 && days.every((d) => isObj(d) && (!Array.isArray(d.items) || d.items.length === 0));
  }

  // ---- 날짜 계산 (YYYY-MM-DD 문자열을 UTC 자정으로 다뤄 시간대/서머타임에 따른 하루 어긋남을 피한다) ----
  const MAX_DAYS = 30;
  const DAY_MS = 86400000;
  function ymdToMs(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m || +m[1] < 1000) return NaN;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(ms);
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? ms : NaN; // 2월 30일 같은 날짜는 거른다
  }
  /** 이 기기 시간대 기준 오늘 (toISOString은 UTC라 한국 새벽에는 어제가 된다) */
  function todayYmd() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  /** 'YYYY-MM-DD'에 n일을 더한 날짜. 잘못된 입력이면 '' */
  function addDays(s, n) {
    const ms = ymdToMs(s);
    return isNaN(ms) ? '' : new Date(ms + n * DAY_MS).toISOString().slice(0, 10);
  }
  /** 시작일~종료일(포함)의 일수. 날짜가 올바르지 않으면 NaN, 종료가 시작보다 앞이면 0 이하 */
  function daySpan(start, end) {
    const a = ymdToMs(start);
    const b = ymdToMs(end);
    return isNaN(a) || isNaN(b) ? NaN : Math.round((b - a) / DAY_MS) + 1;
  }

  /** 서버에서 받은 여행 객체를 앱 형식으로 정규화 (id 유지) */
  function normServerTrip(raw, id) {
    const n = normTrip(raw);
    n.id = id;
    return n;
  }

  /** 현재 여행. 여행이 하나도 없으면 null (홈 화면) */
  const currentTrip = () => state.trips.find((t) => t.id === state.currentTripId) || state.trips[0] || null;
  function clampDay() {
    const t = currentTrip();
    if (t) state.dayIndex = Math.min(Math.max(0, state.dayIndex), t.days.length - 1);
  }
  const currentDay = () => {
    const t = currentTrip();
    return t && t.days[Math.min(state.dayIndex, t.days.length - 1)];
  };

  const newDay = () => ({ id: uid(), startTime: '09:00', items: [] });
  function newTrip(name, startDate, dayCount) {
    const days = [];
    for (let i = 0; i < dayCount; i++) days.push(newDay());
    return { id: uid(), name, startDate: startDate || '', days };
  }
  const newItem = (p) => Object.assign(
    { id: uid(), name: '새 장소', lat: 0, lon: 0, category: 'sight', stay: 60, memo: '', cost: 0, parking: 0, modeIn: null, transitIdx: null, legMin: null, legCost: null },
    p
  );

  // ---- 내보내기 / 가져오기 ----
  function exportJSON() {
    return JSON.stringify({ app: 'TripPlanner', version: 1, exportedAt: new Date().toISOString(), trips: state.trips, settings: state.settings }, null, 2);
  }

  /** 가져오기: 유효성 검사 후 기존 여행에 추가한다. 추가된 여행 수를 반환. */
  function importJSON(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('올바른 JSON 파일이 아닙니다.');
    }
    // 단일 여행 객체나 { trips: [...] } 둘 다 허용
    const list = Array.isArray(data && data.trips) ? data.trips : data && Array.isArray(data.days) ? [data] : null;
    if (!list || !list.length) throw new Error('여행 데이터를 찾을 수 없습니다.');
    const added = list.slice(0, 50).map(normTrip);
    state.trips.push(...added);
    state.currentTripId = added[0].id;
    state.dayIndex = 0;
    saveNow();
    return added.length;
  }

  function resetSettings() {
    state.settings = mergeSettings(TP.fare.DEFAULT_CONFIG, null);
  }

  TP.store = { normItem, state, hooks, load, useUserCache, clearUserCache, loadFromServer, normServerTrip, isSample, isPlaceholder, MAX_DAYS, todayYmd, addDays, daySpan, save, saveNow, currentTrip, currentDay, clampDay, newTrip, newDay, newItem, exportJSON, importJSON, resetSettings, uid };
})();

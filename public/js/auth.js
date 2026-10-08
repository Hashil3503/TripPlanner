/* auth.js - 로그인/회원가입 API 클라이언트 + 서버 동기화.
 * 비로그인(게스트): 기존처럼 localStorage만 사용.
 * 로그인: 서버가 원본. 여행/설정이 바뀌면(스냅샷 비교) 디바운스 후 PUT, 삭제된 여행은 DELETE.
 * localStorage에는 사용자별 캐시를 두어 새로고침을 빠르게 하되, 시작할 때 항상 서버에서 다시 불러온다.
 * DOM을 직접 다루지 않고 on('change' | 'status' | 'notice' | 'conflict' | 'tripsReplaced') 이벤트로 UI(app.js)에 알린다.
 * 여행마다 서버 리비전(rev)을 들고 있다가 저장할 때 baseRev로 보내, 다른 기기/탭이 먼저 고친 여행을 덮어쓰지 않는다(낙관적 잠금).
 * 설정(settings) 동기화는 마지막 저장이 이기는 방식 그대로다(충돌 처리 대상 아님). */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});
  const S = TP.store;

  const LAST_USER_KEY = 'tripplanner.lastUser'; // 마지막 로그인 사용자 (캐시로 빠르게 그리기 위한 힌트)
  const DEBOUNCE_MS = 800;

  let user = null; // { username } | null
  let syncOn = false; // 서버 세션이 확인되어 동기화 중일 때만 true
  const snap = new Map(); // tripId -> 마지막으로 서버와 맞춘 JSON
  const revs = new Map(); // tripId -> 마지막으로 서버와 맞춘 리비전 (없으면 서버에 아직 없는 여행)
  const held = new Map(); // tripId -> { id, name, serverTrip, serverRev }: 충돌로 보류된 여행 (해결 전에는 저장하지 않는다)
  let settingsSnap = '';
  let timer = 0;
  let current = null; // 진행 중인 동기화 Promise
  let again = false;
  let status = { state: 'idle', message: '' }; // idle | saving | saved | error

  const listeners = { change: [], status: [], notice: [], conflict: [], tripsReplaced: [] };
  const on = (ev, fn) => listeners[ev].push(fn);
  const emit = (ev, arg) => listeners[ev].forEach((fn) => fn(arg));

  function setStatus(state, message) {
    status = { state, message: message || '' };
    emit('status', status);
  }

  function readLastUser() {
    try {
      return localStorage.getItem(LAST_USER_KEY) || '';
    } catch (e) {
      return '';
    }
  }
  function writeLastUser(name) {
    try {
      if (name) localStorage.setItem(LAST_USER_KEY, name);
      else localStorage.removeItem(LAST_USER_KEY);
    } catch (e) {
      /* 캐시 힌트 없이 진행 */
    }
  }

  // ---- API ----
  /** JSON API 호출. 상태 변경 요청에는 항상 Content-Type: application/json 을 붙인다(서버의 CSRF 방어 조건). */
  async function api(method, url, body, extra) {
    const init = Object.assign({ method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, extra || {});
    if (method !== 'GET') init.body = JSON.stringify(body === undefined ? {} : body);
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      const err = new Error('서버에 연결할 수 없어요');
      err.network = true;
      throw err;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `요청에 실패했어요 (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data || {};
  }

  // ---- 동기화 (스냅샷 비교) ----
  const tripJson = (t) => JSON.stringify(t);
  const CONFLICT_MSG = '다른 곳에서 수정된 여행이 있어요';
  const tripName = (json) => {
    try {
      return String(JSON.parse(json).name || '');
    } catch (e) {
      return '';
    }
  };

  function diff() {
    const puts = [];
    const seen = new Set();
    for (const t of S.state.trips) {
      seen.add(t.id);
      const j = tripJson(t);
      if (snap.get(t.id) !== j && !held.has(t.id)) puts.push([t.id, j]);
    }
    const dels = [...snap.keys()].filter((id) => !seen.has(id) && !held.has(id));
    const sj = JSON.stringify(S.state.settings);
    return { puts, dels, settings: sj !== settingsSnap ? sj : null };
  }
  const isClean = (d) => !d.puts.length && !d.dels.length && d.settings === null;

  function schedule() {
    if (!syncOn) return;
    if (isClean(diff())) return;
    setStatus('saving');
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  async function doRun() {
    const d = diff();
    if (isClean(d)) {
      if (status.state === 'saving') setStatus('saved');
      return;
    }
    setStatus('saving');
    const conflicts = [];
    // 409(충돌)면 그 여행만 보류하고 나머지는 계속 저장한다. 다른 오류는 전체를 중단하고 다시 시도하게 둔다
    const hold = (id, name, e) => {
      const dt = e.data || {};
      const c = { id, name, serverTrip: dt.trip || null, serverRev: Number.isInteger(dt.rev) ? dt.rev : null };
      held.set(id, c);
      conflicts.push(c);
    };
    try {
      for (const [id, j] of d.puts) {
        try {
          const r = await api('PUT', `/api/trips/${encodeURIComponent(id)}`, { trip: JSON.parse(j), baseRev: revs.has(id) ? revs.get(id) : null });
          snap.set(id, j);
          if (Number.isInteger(r.rev)) revs.set(id, r.rev);
        } catch (e) {
          if (e.status === 409 && e.data && e.data.conflict) hold(id, JSON.parse(j).name, e);
          else throw e;
        }
      }
      for (const id of d.dels) {
        try {
          await api('DELETE', `/api/trips/${encodeURIComponent(id)}`, revs.has(id) ? { baseRev: revs.get(id) } : {});
          snap.delete(id);
          revs.delete(id);
        } catch (e) {
          if (e.status === 409 && e.data && e.data.conflict) hold(id, tripName(snap.get(id)), e);
          else throw e;
        }
      }
      if (d.settings !== null) {
        await api('PUT', '/api/settings', { settings: JSON.parse(d.settings) });
        settingsSnap = d.settings;
      }
      if (held.size) setStatus('error', CONFLICT_MSG);
      else setStatus('saved');
    } catch (e) {
      if (e.status === 401) sessionExpired();
      else setStatus('error', e.message);
    }
    for (const c of conflicts) emit('conflict', c);
  }

  function run() {
    if (!syncOn) return Promise.resolve();
    if (current) {
      again = true;
      return current;
    }
    current = doRun().finally(() => {
      current = null;
      if (again) {
        again = false;
        schedule();
      }
    });
    return current;
  }

  async function flush() {
    clearTimeout(timer);
    if (current) await current;
    await run();
  }

  // 탭을 닫을 때 남은 변경을 keepalive 요청으로 최대한 보낸다 (결과는 확인하지 않음)
  window.addEventListener('pagehide', () => {
    if (!syncOn) return;
    const d = diff();
    const send = (method, url, body) => {
      try {
        fetch(url, { method, credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
      } catch (e) {
        /* ignore */
      }
    };
    // baseRev를 함께 보내 닫히는 탭의 오래된 내용이 다른 곳의 수정을 덮어쓰지 못하게 한다
    for (const [id, j] of d.puts) if (j.length < 60000) send('PUT', `/api/trips/${encodeURIComponent(id)}`, { trip: JSON.parse(j), baseRev: revs.has(id) ? revs.get(id) : null });
    for (const id of d.dels) send('DELETE', `/api/trips/${encodeURIComponent(id)}`, revs.has(id) ? { baseRev: revs.get(id) } : {});
    if (d.settings !== null) send('PUT', '/api/settings', { settings: JSON.parse(d.settings) });
  });

  S.hooks.onDirty = schedule;

  // ---- 로그인 상태 전환 ----
  function toGuest() {
    syncOn = false;
    clearTimeout(timer);
    again = false;
    snap.clear();
    revs.clear();
    held.clear();
    settingsSnap = '';
    if (user) S.clearUserCache(user.username);
    user = null;
    writeLastUser('');
    S.load(); // 게스트 localStorage 데이터로 복귀
    setStatus('idle');
    emit('change', null);
  }

  function sessionExpired() {
    toGuest();
    emit('notice', '로그인이 만료되었어요. 다시 로그인해 주세요');
  }

  /** 서버 데이터로 화면 상태를 교체한다. promptImport: 게스트 데이터를 계정으로 가져올지 묻는다 */
  async function enter(username, serverSettings, promptImport) {
    let guestTrips = [];
    let guestSettings = null;
    if (promptImport && !user) {
      S.saveNow(); // 게스트 데이터를 먼저 저장해 둔다 (로그아웃 후 그대로 돌아올 수 있게)
      guestTrips = S.state.trips.filter((t) => !S.isSample(t) && !S.isPlaceholder(t)); // 빈 자리표시 여행/손대지 않은 샘플은 가져오지 않는다
      guestSettings = JSON.parse(JSON.stringify(S.state.settings));
    }

    const fetched = await api('GET', '/api/trips');
    const serverRevs = fetched.revs && typeof fetched.revs === 'object' ? fetched.revs : {};
    let list = (fetched.trips || []).filter((t) => t && typeof t.id === 'string');
    // 예전 버전이 계정에 자동으로 만든 빈 '새 여행'은 목록에서 빼고 서버에서도 지운다 (실패해도 다음 로그인에 다시 시도)
    const stale = list.filter(S.isPlaceholder);
    if (stale.length) {
      list = list.filter((t) => !S.isPlaceholder(t));
      await Promise.all(stale.map((t) => api('DELETE', `/api/trips/${encodeURIComponent(t.id)}`).catch(() => {})));
    }
    const serverIds = new Set(list.map((t) => t.id));

    const importedRevs = new Map();
    const missing = guestTrips.filter((t) => !serverIds.has(t.id));
    if (missing.length && confirm(`이 기기에 있는 여행 ${missing.length}개를 계정으로 가져올까요?`)) {
      let failed = 0;
      for (const t of missing) {
        try {
          const r = await api('PUT', `/api/trips/${encodeURIComponent(t.id)}`, { trip: t, baseRev: null });
          if (Number.isInteger(r.rev)) importedRevs.set(t.id, r.rev);
          list.push(t);
          serverIds.add(t.id);
        } catch (e) {
          failed++;
        }
      }
      emit('notice', failed ? `여행 ${failed}개를 가져오지 못했어요` : `여행 ${missing.length}개를 계정으로 가져왔어요`);
    }

    user = { username };
    writeLastUser(username);
    // 설정: 서버에 저장된 값이 있으면 그것을, 새 계정이면 이 기기의 설정을 계정 기본값으로 쓴다
    S.loadFromServer(username, list.map((t) => S.normServerTrip(t, t.id)), serverSettings || guestSettings);

    snap.clear();
    revs.clear();
    held.clear();
    for (const t of S.state.trips) {
      if (!serverIds.has(t.id)) continue;
      snap.set(t.id, tripJson(t));
      const rev = importedRevs.has(t.id) ? importedRevs.get(t.id) : serverRevs[t.id];
      if (Number.isInteger(rev)) revs.set(t.id, rev);
    }
    settingsSnap = serverSettings ? JSON.stringify(S.state.settings) : '';
    syncOn = true;
    setStatus('idle');
    emit('change', user);
    schedule(); // 새 계정의 기본 여행/설정 등 서버에 아직 없는 것을 올린다
  }

  async function authRequest(path, username, password) {
    const r = await api('POST', path, { username, password });
    try {
      await enter(r.username, r.settings || null, true);
    } catch (e) {
      // 세션은 만들어졌지만 데이터를 불러오지 못함 -> 깨끗하게 로그아웃
      try { await api('POST', '/api/logout'); } catch (e2) { /* ignore */ }
      throw e;
    }
    return r;
  }
  const login = (username, password) => authRequest('/api/login', username, password);
  const signup = (username, password) => authRequest('/api/signup', username, password);

  /** 로그인 상태에서 비밀번호 변경 (서버가 다른 기기의 세션을 끊는다) */
  const changePassword = (currentPassword, newPassword) => api('PUT', '/api/password', { currentPassword, newPassword });

  /** 회원 탈퇴: 비밀번호 확인 후 서버가 계정과 여행을 모두 지운다. 성공하면 게스트 상태로 돌아간다 */
  async function deleteAccount(password) {
    const r = await api('DELETE', '/api/me', { password });
    toGuest(); // 동기화를 멈추고 이 기기의 사용자 캐시도 지운다
    return r;
  }

  async function logout() {
    if (syncOn) {
      await flush();
      if (status.state === 'error' && !confirm('저장되지 않은 변경 사항이 있어요. 그래도 로그아웃할까요?')) return false;
    }
    try {
      await api('POST', '/api/logout');
    } catch (e) {
      /* 서버에 닿지 않아도 이 기기에서는 로그아웃 처리 */
    }
    toGuest();
    return true;
  }

  /** 시작할 때 화면을 그리기 전에 호출: 마지막 사용자의 캐시가 있으면 먼저 보여준다 (서버 확인 전) */
  function restore() {
    const last = readLastUser();
    if (!last || !S.useUserCache(last)) return false;
    user = { username: last, pending: true };
    return true;
  }

  /** 첫 화면 이후 호출: 서버 세션을 확인하고 서버 데이터로 교체한다 */
  async function init() {
    let me = null;
    try {
      me = await api('GET', '/api/me');
    } catch (e) {
      if (e.status === 401) {
        if (user) toGuest();
      } else if (user) {
        setStatus('error', '서버에 연결할 수 없어 저장된 사본을 표시 중이에요');
      }
      return;
    }
    if (!me || typeof me.username !== 'string') {
      if (user) toGuest();
      return;
    }
    try {
      await enter(me.username, me.settings || null, false);
    } catch (e) {
      if (e.status === 401) toGuest();
      else if (user) setStatus('error', e.message);
    }
  }

  /** 충돌로 보류된 여행을 해결한다. choice: 'server'(다른 곳의 버전 불러오기) | 'mine'(내 변경으로 덮어쓰기) */
  function resolveConflict(id, choice) {
    const c = held.get(id);
    if (!c) return;
    held.delete(id);
    if (choice === 'server') {
      const trips = S.state.trips;
      const i = trips.findIndex((t) => t.id === id);
      if (c.serverTrip) {
        const t = S.normServerTrip(c.serverTrip, id);
        if (i >= 0) trips[i] = t;
        else trips.push(t); // 내가 지운 여행이 다른 곳에서 수정된 경우: 서버 버전을 되살린다
        snap.set(id, tripJson(t));
        if (c.serverRev !== null) revs.set(id, c.serverRev);
      } else {
        if (i >= 0) trips.splice(i, 1);
        snap.delete(id);
        revs.delete(id);
      }
      S.clampDay();
      S.saveNow();
      emit('tripsReplaced');
    } else {
      // 서버 리비전을 기준으로 삼아 내 버전을 다시 올린다 (서버에서 지워졌다면 새로 만든다)
      if (c.serverTrip && c.serverRev !== null) revs.set(id, c.serverRev);
      else revs.delete(id);
    }
    if (!held.size) {
      if (isClean(diff())) setStatus('saved');
      else schedule();
    }
  }

  /** 저장 실패 후 다시 시도. 보류된 충돌이 있으면 무작정 재시도하지 않고 해결 창을 다시 띄운다 */
  function retry() {
    if (!syncOn) return init();
    if (held.size) {
      for (const c of held.values()) emit('conflict', c);
      return Promise.resolve();
    }
    return run();
  }

  TP.auth = { on, login, signup, changePassword, deleteAccount, resolveConflict, logout, restore, init, retry, current: () => user, status: () => status };
})();

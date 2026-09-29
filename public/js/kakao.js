/* kakao.js - 카카오 지도 JavaScript SDK 공유 로더.
 * map.js(지도)와 geocode.js(장소 검색)가 같은 Promise를 기다리므로 SDK는 한 번만 로드된다.
 * 키: 설정(⚙) 창에 저장한 값 > js/config.local.js 의 TP_CONFIG.kakaoJsKey */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const LS_KEY = 'tripplanner.kakaoKey'; // 설정 창에서 입력한 키 (내보내기 JSON에는 포함되지 않음)
  const TIMEOUT_MS = 8000;
  const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

  function readStoredKey() {
    try {
      return String(localStorage.getItem(LS_KEY) || '').trim();
    } catch (e) {
      return '';
    }
  }

  /** 설정 창에 저장한 키 > config.local.js 값. 없거나 형식이 이상하면 '' */
  function getKey() {
    let v = readStoredKey();
    if (!v) {
      const c = window.TP_CONFIG;
      v = c && typeof c.kakaoJsKey === 'string' ? c.kakaoJsKey.trim() : '';
    }
    return KEY_RE.test(v) ? v : '';
  }

  /** 설정 창에서 저장하는 키 (빈 문자열이면 저장값 삭제 -> config.local.js 값 사용) */
  function setStoredKey(v) {
    v = String(v || '').trim();
    try {
      if (v) localStorage.setItem(LS_KEY, v);
      else localStorage.removeItem(LS_KEY);
    } catch (e) {
      console.warn('카카오 키 저장 실패', e);
    }
  }

  let state = 'none'; // none(키 없음) | loading | ready | failed
  let error = '';
  let promise = null;

  /** SDK(지도 + services)를 한 번만 로드한다. 항상 resolve(true|false). */
  function load() {
    if (promise) return promise;
    const key = getKey();
    if (!key) {
      state = 'none';
      promise = Promise.resolve(false);
      return promise;
    }
    state = 'loading';
    promise = new Promise((resolve) => {
      let done = false;
      let timer = 0;
      const finish = (ok, msg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        state = ok ? 'ready' : 'failed';
        error = ok ? '' : msg || '';
        if (!ok) console.warn('카카오 SDK를 사용할 수 없습니다:', msg);
        resolve(ok);
      };
      timer = setTimeout(() => finish(false, `시간 초과 (${TIMEOUT_MS / 1000}초)`), TIMEOUT_MS);
      const script = document.createElement('script');
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
      script.async = true;
      script.onerror = () => finish(false, 'SDK 스크립트를 불러오지 못했어요 (키/도메인/카카오맵 사용 설정 확인)');
      script.onload = () => {
        try {
          window.kakao.maps.load(() => {
            if (window.kakao.maps.services && window.kakao.maps.services.Places) finish(true);
            else finish(false, 'services 라이브러리를 찾을 수 없어요');
          });
        } catch (e) {
          finish(false, e && e.message ? e.message : 'SDK 초기화 실패');
        }
      };
      document.head.appendChild(script);
    });
    return promise;
  }

  TP.kakao = {
    getKey,
    getStoredKey: readStoredKey,
    setStoredKey,
    isValidKey: (v) => KEY_RE.test(String(v || '').trim()),
    load,
    status: () => ({ state, error }),
  };

  // 키가 있으면 미리 로드 (없으면 아무것도 하지 않음)
  load();
})();

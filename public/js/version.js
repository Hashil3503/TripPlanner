/* version.js - 배포된 앱 버전 확인. 탭이 연 구버전 JS로 저장하면 서버가 412로 막고, 이 파일이 새로고침 전용 창을 띄운다. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const current = (window.TP_CONFIG && window.TP_CONFIG.appVersion) || '';
  let checkPromise = null; // 진행 중인 확인 (동시 호출은 같은 Promise를 받는다)

  function showDialog(lostEdit) {
    const dlg = document.getElementById('updateDialog');
    if (!dlg) return;
    if (lostEdit) dlg.dataset.lost = '1';
    if (!dlg.dataset.wired) {
      dlg.dataset.wired = '1';
      dlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc로 닫지 못하게 한다
      dlg.addEventListener('close', () => { if (TP.version.outdated) dlg.showModal(); }); // 어떤 이유로 닫혀도 다시 연다
      const btn = document.getElementById('updateReload');
      if (btn) btn.addEventListener('click', () => location.reload());
    }
    const lost = document.getElementById('updateLost');
    if (lost) lost.hidden = !dlg.dataset.lost;
    if (!dlg.open) dlg.showModal(); // 다른 창이 열려 있어도 그 위에 띄운다
  }

  function markOutdated(lostEdit) {
    TP.version.outdated = true;
    showDialog(!!lostEdit);
  }

  function seen(v) {
    if (current && v && current !== v) {
      markOutdated(false);
      return false;
    }
    return true;
  }

  function check(lostEdit) {
    if (!current) return Promise.resolve(null); // 설정을 못 받았으면 판단하지 않는다
    if (checkPromise) return checkPromise;
    checkPromise = fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const v = data && typeof data.version === 'string' ? data.version : '';
        if (!v) return null;
        if (v === current) return true;
        markOutdated(!!lostEdit);
        return false;
      })
      .catch(() => null)
      .finally(() => {
        checkPromise = null;
      });
    return checkPromise;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check(false);
  });

  TP.version = { current, outdated: false, seen, check, markOutdated };
})();

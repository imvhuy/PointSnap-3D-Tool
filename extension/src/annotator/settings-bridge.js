/*
 * ISOLATED world: chuyển cấu hình annotator của địa chỉ CVAT đang mở (PointSnapHosts.profileFor) sang MAIN world, nơi
 * annotator chạy. Gửi khi trang tải, khi MAIN world hỏi, và mỗi lần cấu hình đổi (popup / trang Tùy chọn).
 */
(function () {
  'use strict';

  const Hosts = globalThis.PointSnapHosts;
  const SETTINGS = 'POINTSNAP_ANNOTATOR_SETTINGS';
  const REQUEST = 'POINTSNAP_ANNOTATOR_SETTINGS_REQUEST';

  function send() {
    chrome.storage.local.get(Hosts.LOCAL_DEFAULTS, (local) => {
      const profile = Hosts.profileFor(local, location.origin);
      window.postMessage({ type: SETTINGS, detail: { enabled: profile.enabled, guidelineJson: profile.guidelineJson } }, location.origin);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source === window && event.origin === location.origin && event.data?.type === REQUEST) send();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.annotatorProfiles || changes.annotatorEnabled || changes.annotatorGuideline)) send();
  });
  send();
})();

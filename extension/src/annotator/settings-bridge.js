/*
 * ISOLATED world: chuyển cấu hình annotator (trang Tùy chọn, chrome.storage.local) sang MAIN world, nơi annotator chạy.
 * Gửi khi trang tải, khi MAIN world hỏi, và mỗi lần người dùng lưu Tùy chọn.
 */
(function () {
  'use strict';

  const DEFAULTS = { annotatorEnabled: true, annotatorGuideline: '' };
  const SETTINGS = 'POINTSNAP_ANNOTATOR_SETTINGS';
  const REQUEST = 'POINTSNAP_ANNOTATOR_SETTINGS_REQUEST';

  function send() {
    chrome.storage.local.get(DEFAULTS, (values) => {
      window.postMessage({ type: SETTINGS, detail: { enabled: values.annotatorEnabled, guidelineJson: values.annotatorGuideline } }, location.origin);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source === window && event.origin === location.origin && event.data?.type === REQUEST) send();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.annotatorEnabled || changes.annotatorGuideline)) send();
  });
  send();
})();

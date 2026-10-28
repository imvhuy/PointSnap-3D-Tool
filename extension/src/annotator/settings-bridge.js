/*
 * ISOLATED world: cầu nối giữa cấu hình của extension (chrome.storage) và annotator chạy ở MAIN world.
 * - Gửi cấu hình của project đang mở (PointSnapHosts.profileFor) khi trang tải, khi MAIN world hỏi (kèm mã project của
 *   job), và mỗi lần cấu hình đổi (popup / Tùy chọn / trình sửa spec).
 * - Nhận yêu cầu lưu bộ ngưỡng từ trình sửa spec trong trang và ghi vào cấu hình của project đó.
 */
(function () {
  'use strict';

  // CVAT đã có plugin PointSnap (qc/public/plugin.js): plugin trả lời cấu hình từ dịch vụ QC, bridge này đứng ngoài.
  if (document.documentElement.dataset.pointsnapPlugin) return;
  const Hosts = globalThis.PointSnapHosts;
  const SETTINGS = 'POINTSNAP_ANNOTATOR_SETTINGS';
  const REQUEST = 'POINTSNAP_ANNOTATOR_SETTINGS_REQUEST';
  const SAVE = 'POINTSNAP_SPEC_SAVE';
  const SAVED = 'POINTSNAP_SPEC_SAVED';
  let key = location.origin;

  function send() {
    chrome.storage.local.get(Hosts.LOCAL_DEFAULTS, (local) => {
      const profile = Hosts.profileFor(local, key);
      window.postMessage({ type: SETTINGS, detail: { ...profile, projectKey: key } }, location.origin);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const { type, detail } = event.data || {};
    if (type === REQUEST) {
      key = Hosts.projectKey(location.origin, Number(detail?.projectId));
      send();
    } else if (type === SAVE && typeof detail?.guidelineJson === 'string') {
      // Chỉ lưu bộ ngưỡng (không bật / tắt extension); giá trị được kiểm lại ở MAIN world khi áp dụng.
      Hosts.saveProfile(key, { guidelineName: String(detail.guidelineName || '').slice(0, 80), guidelineJson: detail.guidelineJson })
        .then(() => window.postMessage({ type: SAVED, detail: { ok: true, projectKey: key } }, location.origin))
        // Extension vừa được tải lại / cập nhật mà tab chưa tải lại: script này mất kết nối với chrome.storage.
        .catch((error) => window.postMessage({ type: SAVED, detail: { ok: false, error: error.message, stale: !chrome.runtime?.id } }, location.origin));
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.annotatorProfiles || changes.annotatorEnabled || changes.annotatorGuideline)) send();
  });
  send();
})();

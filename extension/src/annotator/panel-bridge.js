/*
 * ISOLATED world: cầu nối giữa controller ở MAIN world (panel-link.js) và cửa sổ bảng PointSnap của extension
 * (panel-window.js nối vào tab bằng chrome.tabs.connect, cổng "pointsnap-panel").
 * - View-model từ trang → cửa sổ; nhớ bản cuối để cửa sổ vừa nối hiện ngay.
 * - Thao tác bấm trong cửa sổ → trang; báo trang cửa sổ đang mở hay đóng (đóng thì trang thôi đo).
 * - Alt+Shift+P trong trang → service worker mở / đóng cửa sổ của tab này.
 */
(function () {
  'use strict';

  // CVAT đã có plugin PointSnap (qc/public/plugin.js): bảng nằm trong tab "Hỗ trợ" của CVAT, bridge này đứng ngoài.
  if (document.documentElement.dataset.pointsnapPlugin) return;
  const VM = 'POINTSNAP_PANEL_VM', ACTION = 'POINTSNAP_PANEL_ACTION', STATE = 'POINTSNAP_PANEL_STATE', TOGGLE = 'POINTSNAP_PANEL_TOGGLE';
  let port = null, lastVm = null;
  const post = (type, detail) => window.postMessage({ type, detail }, location.origin);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const { type, detail } = event.data || {};
    if (type === VM) {
      lastVm = detail;
      port?.postMessage({ type: 'vm', vm: detail });
    } else if (type === `${STATE}_REQUEST`) {
      post(STATE, { open: !!port });
    } else if (type === TOGGLE) {
      // Extension vừa tải lại mà tab chưa tải lại: script này mất kết nối, sendMessage ném lỗi.
      try { chrome.runtime.sendMessage({ type: 'togglePanel' }).catch(() => {}); } catch (_) { /* bỏ qua */ }
    }
  });

  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== 'pointsnap-panel' || p.sender?.id !== chrome.runtime.id) return;
    // Một cửa sổ cho một tab: cửa sổ mới nối thì cắt cửa sổ cũ.
    if (port) port.disconnect();
    port = p;
    if (lastVm) p.postMessage({ type: 'vm', vm: lastVm });
    post(STATE, { open: true });
    p.onMessage.addListener((m) => {
      if (m?.type === 'action' && typeof m.name === 'string') post(ACTION, { name: m.name, data: m.data || {} });
    });
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      port = null;
      post(STATE, { open: false });
    });
  });
})();

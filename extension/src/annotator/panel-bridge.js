/*
 * ISOLATED world: cầu nối giữa controller ở MAIN world (panel-link.js) và bảng PointSnap trong side panel của extension
 * (sidepanel.js nối vào tab bằng chrome.tabs.connect, cổng "pointsnap-panel").
 * - View-model từ trang → side panel; nhớ bản cuối để side panel vừa mở hiện ngay.
 * - Thao tác bấm trong side panel → trang; báo trang side panel đang mở hay đóng (đóng thì thôi gửi view-model).
 */
(function () {
  'use strict';

  // CVAT đã có plugin PointSnap (qc/public/plugin.js): bảng nằm trong tab "Hỗ trợ" của CVAT, bridge này đứng ngoài.
  if (document.documentElement.dataset.pointsnapPlugin) return;
  const VM = 'POINTSNAP_PANEL_VM', ACTION = 'POINTSNAP_PANEL_ACTION', STATE = 'POINTSNAP_PANEL_STATE';
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
    }
  });

  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== 'pointsnap-panel' || p.sender?.id !== chrome.runtime.id) return;
    // Một bảng một lúc: bảng mới nối thì cắt cổng cũ.
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

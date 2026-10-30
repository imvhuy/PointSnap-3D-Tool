/*
 * MAIN world: bảng PointSnap nằm trong side panel của extension (sidepanel.html), không nhúng vào trang CVAT. Cùng giao diện
 * với PointSnapAnnotatorPanel.create (render / isOpen / toggle / destroy) nên controller không cần phân biệt:
 * view-model gửi qua panel-bridge.js (ISOLATED world) tới side panel, thao tác bấm trong side panel gửi ngược về `onAction`.
 * Side panel có thể đang đóng, nên phần trên canvas (mặt đất, tô điểm, khoá box) luôn chạy, không chờ bảng mở.
 */
(function (root) {
  'use strict';

  const VM = 'POINTSNAP_PANEL_VM', ACTION = 'POINTSNAP_PANEL_ACTION', STATE = 'POINTSNAP_PANEL_STATE';

  function create(onAction) {
    let open = false, last = '';
    const post = (type, detail) => window.postMessage({ type, detail }, location.origin);
    const listener = (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const { type, detail } = event.data || {};
      if (type === STATE) {
        open = !!detail?.open;
        // Side panel vừa mở: gửi lại view-model dù không đổi.
        last = '';
        onAction('rerender');
      } else if (type === ACTION && typeof detail?.name === 'string') {
        onAction(detail.name, detail.data && typeof detail.data === 'object' ? detail.data : {});
      }
    };
    window.addEventListener('message', listener);
    // Trang vừa tải lại / mở job khác trong khi side panel đang mở: hỏi bridge side panel có đang nối không.
    post(`${STATE}_REQUEST`);

    return {
      render(vm) {
        if (!open) return;
        const json = JSON.stringify(vm);
        if (json === last) return;
        last = json;
        post(VM, vm);
      },
      // Luôn đo và vẽ trên canvas; side panel chỉ là nơi xem / bấm. Alt+Shift+P là lệnh của trình duyệt mở side panel.
      isOpen: () => true,
      toggle: () => {},
      destroy() {
        window.removeEventListener('message', listener);
        if (open) post(VM, { status: 'waiting', message: 'Mở một job 3D trên CVAT…' });
      },
    };
  }

  root.PointSnapPanelLink = { create };
})(globalThis);

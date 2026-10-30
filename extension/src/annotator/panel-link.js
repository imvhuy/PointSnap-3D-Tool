/*
 * MAIN world: bảng PointSnap ở cửa sổ riêng của extension (panel-window.html), không nhúng vào trang CVAT. Cùng giao
 * diện với PointSnapAnnotatorPanel.create (render / isOpen / toggle / destroy) nên controller không cần phân biệt:
 * view-model gửi qua panel-bridge.js (ISOLATED world) tới cửa sổ, thao tác bấm trong cửa sổ gửi ngược về `onAction`.
 */
(function (root) {
  'use strict';

  const VM = 'POINTSNAP_PANEL_VM', ACTION = 'POINTSNAP_PANEL_ACTION', STATE = 'POINTSNAP_PANEL_STATE', TOGGLE = 'POINTSNAP_PANEL_TOGGLE';

  function create(onAction) {
    let open = false, last = '';
    const post = (type, detail) => window.postMessage({ type, detail }, location.origin);
    const listener = (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const { type, detail } = event.data || {};
      if (type === STATE) {
        open = !!detail?.open;
        // Cửa sổ vừa mở / mở lại: gửi lại view-model dù không đổi.
        last = '';
        onAction('rerender');
      } else if (type === ACTION && typeof detail?.name === 'string') {
        onAction(detail.name, detail.data && typeof detail.data === 'object' ? detail.data : {});
      }
    };
    window.addEventListener('message', listener);
    // Trang vừa tải lại / mở job khác trong khi cửa sổ vẫn mở: hỏi bridge cửa sổ có đang nối không.
    post(`${STATE}_REQUEST`);

    return {
      render(vm) {
        if (!open) return;
        const json = JSON.stringify(vm);
        if (json === last) return;
        last = json;
        post(VM, vm);
      },
      // Cửa sổ chưa nối thì không đo / không vẽ gì lên canvas (như tab Hỗ trợ đóng).
      isOpen: () => open,
      toggle: () => post(TOGGLE),
      destroy() {
        window.removeEventListener('message', listener);
        if (open) post(VM, { status: 'waiting', message: 'Mở một job 3D trên CVAT…' });
      },
    };
  }

  root.PointSnapPanelLink = { create };
})(globalThis);

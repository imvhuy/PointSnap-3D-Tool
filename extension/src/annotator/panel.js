/*
 * Bảng PointSnap cho annotator (shadow DOM, không lẫn CSS với CVAT). Chỉ hiển thị view-model do controller đưa vào
 * và báo lại thao tác qua `onAction(name, data)`; không tự đọc CVAT.
 * Hai nơi hiện bảng dùng chung `mount`: bảng nổi trên trang CVAT của extension (`createFloating`: kéo đi đâu cũng
 * được, thu thành nút tròn, không mất khi thao tác CVAT) và tab "Hỗ trợ" trong thanh bên CVAT của plugin QC (`create`).
 * Bố cục: phần trên đứng yên (tiêu đề: chấm trạng thái + box đang chọn + nút chung; dòng job / frame; thông báo; hàng
 * nút dùng nhiều nhất: Hạ đáy, Hạ đáy mọi frame, Xong) → phần dưới cuộn: checklist từng khía cạnh, mỗi dòng có nút sửa
 * đúng vấn đề của nó → dải track một ô mỗi keyframe, bấm ô để tới frame → sửa cả track, thuộc tính → bản xem trước.
 * Nền sáng như thanh bên của CVAT; màu một nghĩa: xanh lá ổn, cam cần xem, đỏ lỗi.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'pointsnap.annotator.panel';
  const SHORTCUTS = 'Alt+Shift+P: thu nhỏ / mở bảng PointSnap · Alt+Shift+G: hạ đáy box · Alt+Shift+F: khoá box · Alt+Shift+D: đánh dấu track xong. Save / Undo bằng CVAT.';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ICON = { ok: '✓', warning: '!', error: '✕', na: '–', muted: '–' };
  // Phím tắt ghi bằng chữ: annotator dùng Windows / Linux, ký hiệu ⌥⇧ của Mac khó đọc.
  const key = (letter) => `Alt+Shift+${letter}`;
  const LEVEL_TEXT = { ok: 'Ổn', warning: 'Cần xem', error: 'Lỗi', na: 'Chưa đo được', muted: 'Đã bỏ qua' };

  // Logo PointSnap (qc/public/logo.svg), nét theo màu chữ.
  const LOGO = '<svg class="logo" viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path opacity=".4" d="M3.5 44.3H18.7M37.3 44.3H52.5"/><path d="M28 44.3 11.7 35V16.3L28 7l16.3 9.3V35L28 44.3Zm16.3-28L28 25.7m0 0L11.7 16.3M28 25.7v18.6"/><circle cx="28" cy="44.3" r="5.25" fill="#1677ff" stroke="none"/></svg>';

  /* Theo kiểu Ant Design của CVAT: nền trắng như thanh bên của CVAT, viền #d9d9d9, xanh #1677ff. */
  const CSS = `
    :host { all: initial; }
    .panel { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: #fff; color: rgba(0,0,0,.88);
      font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; overflow: hidden; overflow-wrap: anywhere; }
    .head { display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 10px; background: #fafafa; border-bottom: 1px solid #f0f0f0; user-select: none; }
    .logo { flex: none; width: 20px; height: 20px; color: #1f1f1f; }
    .head .title { font-weight: 600; margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head .title small { font-weight: 400; color: rgba(0,0,0,.45); }
    .head > .muted, .head .count { flex: none; white-space: nowrap; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #d9d9d9; }
    .dot.ok { background: #52c41a; } .dot.warning { background: #faad14; } .dot.error { background: #ff4d4f; }
    .count { font-weight: 600; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 9px; background: #fff7e6; color: #d46b08; border: 1px solid #ffd591; }
    .count.error { background: #fff1f0; color: #cf1322; border-color: #ffa39e; }
    .muted { color: rgba(0,0,0,.45); }
    .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 8px 10px 12px; display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: max-content; align-content: start; gap: 8px; }
    .ctx { display: flex; align-items: center; gap: 6px; padding: 3px 10px; font-size: 11.5px; color: rgba(0,0,0,.45); border-bottom: 1px solid #f0f0f0; background: #fafafa; }
    .ctx .busy { margin-left: auto; color: #1677ff; }
    .top { flex: none; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 8px 10px 0; }
    .top:empty { display: none; }
    .quick { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0; }
    .quick button { padding: 4px 6px; line-height: 18px; white-space: normal; display: grid; justify-items: center; }
    .quick button small { font-size: 10.5px; line-height: 14px; color: rgba(0,0,0,.45); }
    .quick button.primary small { color: rgba(255,255,255,.8); }
    .quick button.attention:not(:disabled) { box-shadow: 0 0 0 2px #ffd591; }
    .tools { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px 10px; border-bottom: 1px solid #f0f0f0; }
    .tools button { flex: 1 1 auto; font-size: 12px; padding: 1px 6px; }
    .sec { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: .02em;
      color: rgba(0,0,0,.45); margin: 4px 0 -3px; text-transform: uppercase; }
    .sec .link { font-size: 12px; font-weight: 400; text-transform: none; letter-spacing: 0; }
    button.sec { width: 100%; border: 0; border-radius: 0; background: none; box-shadow: none; padding: 0; cursor: pointer; }
    button.sec:hover:not(:disabled) { background: none; color: #1677ff; }
    .ticks { display: grid; grid-template-columns: 1fr auto 1fr; font-size: 10.5px; color: rgba(0,0,0,.45); margin-top: -5px; }
    .ticks .now { color: #1677ff; font-weight: 600; } .ticks span:last-child { text-align: right; }
    .reasons { display: grid; gap: 2px; margin-top: -2px; }
    .reasons button { justify-self: start; border: 0; background: none; box-shadow: none; padding: 0; white-space: normal; text-align: left; font-size: 12px; }
    .reasons button.warning { color: #d46b08; } .reasons button.error { color: #cf1322; }
    .empty { padding: 18px 4px; text-align: center; color: rgba(0,0,0,.45); display: grid; gap: 8px; justify-items: center; }
    button { font: inherit; border: 1px solid #d9d9d9; background: #fff; color: rgba(0,0,0,.88); border-radius: 6px; padding: 1px 8px; cursor: pointer; white-space: nowrap;
      box-shadow: 0 2px 0 rgba(0,0,0,.02); transition: color .2s, border-color .2s, background .2s; }
    button:hover:not(:disabled) { color: #4096ff; border-color: #4096ff; }
    button:focus-visible { outline: 3px solid #91caff; outline-offset: 1px; }
    button:disabled { color: rgba(0,0,0,.25); background: #f5f5f5; cursor: not-allowed; box-shadow: none; }
    button.primary { background: #1677ff; border-color: #1677ff; color: #fff; box-shadow: 0 2px 0 rgba(5,145,255,.1); }
    button.primary:hover:not(:disabled) { background: #4096ff; color: #fff; }
    button.on { background: #e6f4ff; border-color: #91caff; color: #1677ff; }
    .head button { background: transparent; border-color: transparent; box-shadow: none; padding: 0 5px; font-size: 13px; line-height: 22px; color: rgba(0,0,0,.65); }
    .head button:hover:not(:disabled) { background: rgba(0,0,0,.06); border-color: transparent; color: rgba(0,0,0,.88); }
    .head button.on { background: #e6f4ff; color: #1677ff; }
    kbd { font: 10px ui-monospace, Consolas, monospace; white-space: nowrap; color: rgba(0,0,0,.45); background: #fafafa; border: 1px solid #d9d9d9; border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; margin-left: 4px; }
    .notice { padding: 5px 9px; border-radius: 6px; background: #e6f4ff; border: 1px solid #91caff; }
    .notice.error { background: #fff2f0; border-color: #ffccc7; } .notice.ok { background: #f6ffed; border-color: #b7eb8f; }
    .checks { display: grid; grid-template-columns: minmax(0, 1fr); border: 1px solid #f0f0f0; border-radius: 8px; overflow: hidden; }
    .check { display: grid; grid-template-columns: 16px 66px minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 5px 8px; border-top: 1px solid #f0f0f0; }
    .check:first-child { border-top: 0; }
    .check:hover { background: #fafafa; }
    .check i { font-style: normal; font-weight: 700; text-align: center; border-radius: 50%; width: 16px; height: 16px; line-height: 16px; font-size: 10px; }
    .check.ok i { background: #f6ffed; color: #389e0d; } .check.warning i { background: #fff7e6; color: #d46b08; }
    .check.error i { background: #fff1f0; color: #cf1322; } .check.na i, .check.muted i { background: #f5f5f5; color: rgba(0,0,0,.45); }
    .check.muted .text { color: rgba(0,0,0,.25); }
    .check .acts { display: flex; gap: 3px; align-items: center; }
    .check .acts .x { border: 0; background: none; box-shadow: none; color: rgba(0,0,0,.25); padding: 0 3px; font-size: 12px; }
    .check .acts .x:hover { color: rgba(0,0,0,.65); background: none; }
    .check .name { color: rgba(0,0,0,.45); }
    .check .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check.warning .text { color: #d46b08; } .check.error .text { color: #cf1322; }
    .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 6px; }
    .strip { display: grid; gap: 1px; height: 22px; }
    .strip button { padding: 0; border: 0; border-radius: 2px; background: #d9d9d9; min-width: 0; box-shadow: none; }
    .strip button:hover:not(:disabled) { background: #91caff; }
    .strip button.warning { background: #faad14; } .strip button.error { background: #ff4d4f; } .strip button.here { outline: 2px solid #1677ff; outline-offset: -1px; }
    .attrs { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .attr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); align-items: center; gap: 6px; }
    .attr > span { color: rgba(0,0,0,.65); min-width: 0; overflow-wrap: anywhere; }
    .attr select { font: inherit; min-width: 0; border: 1px solid #d9d9d9; border-radius: 6px; padding: 1px 4px; background: #fff; color: rgba(0,0,0,.88); }
    .attr select:focus-visible { outline: 3px solid #91caff; outline-offset: 1px; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; }
    .plan, .spec { background: #fafafa; border: 1px solid #f0f0f0; border-radius: 8px; padding: 8px 9px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .plan { background: #f0f7ff; border-color: #bae0ff; }
    .plan .ghost { color: #1677ff; }
    .spec ul { margin: 0; padding-left: 16px; color: rgba(0,0,0,.65); }
    .warn { color: #d46b08; } .bad { color: #cf1322; }
    .link { border: 0; background: none; box-shadow: none; padding: 0; color: #1677ff; }
    .link:hover:not(:disabled) { background: none; color: #4096ff; }
  `;

  /*
   * Bảng nổi (extension): khung trắng đổ bóng như hộp thoại antd, nằm trên lớp vẽ của PointSnap (z-index 1001) để đường
   * mặt đất không vắt qua bảng. Kéo thanh tiêu đề để dời, kéo góc dưới phải để đổi cỡ; thu nhỏ thành nút tròn.
   */
  const FLOAT_CSS = `
    .float { position: fixed; z-index: 1002; box-sizing: border-box; display: flex; flex-direction: column; width: 340px; height: 600px; min-width: 260px;
      min-height: 200px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); resize: both; overflow: hidden;
      border: 1px solid #d9d9d9; border-radius: 8px; background: #fff;
      box-shadow: 0 6px 16px rgba(0,0,0,.08), 0 3px 6px -4px rgba(0,0,0,.12), 0 9px 28px 8px rgba(0,0,0,.05); }
    .float[hidden], .bubble[hidden] { display: none; }
    .float .panel { flex: 1 1 auto; min-height: 0; }
    .float .head { cursor: move; touch-action: none; }
    .float .head .min { margin-left: 2px; background: transparent; border-color: transparent; box-shadow: none; padding: 0 6px;
      font-size: 15px; line-height: 20px; color: rgba(0,0,0,.65); cursor: pointer; }
    .float .head .min:hover { background: rgba(0,0,0,.06); color: rgba(0,0,0,.88); }
    .float.dragging { opacity: .92; user-select: none; }
    .bubble { position: fixed; z-index: 1002; width: 42px; height: 42px; padding: 0; border-radius: 50%; display: grid; place-items: center;
      background: #fff; border: 1px solid #d9d9d9; color: #1f1f1f; cursor: pointer; touch-action: none;
      box-shadow: 0 6px 16px rgba(0,0,0,.12), 0 3px 6px -4px rgba(0,0,0,.16); }
    .bubble:hover { border-color: #4096ff; }
    .bubble .logo { width: 26px; height: 26px; }
    .bubble .dot { position: absolute; top: 3px; right: 3px; border: 2px solid #fff; width: 10px; height: 10px; }
  `;
  const FLOAT_SIZE = { width: 340, height: 600, margin: 8 };

  /*
   * Tab "Hỗ trợ" trong thanh bên phải của CVAT, cạnh Objects / Labels (và tab PointSnap QC của bản nhúng): không nổi đè
   * lên canvas. CVAT chưa có chỗ cắm cho thanh bên nên chèn một tab cùng kiểu antd; bật tab thì ẩn nội dung của CVAT (không
   * gỡ, React vẫn giữ) và hiện `.psa-pane`. Cùng một code cho extension và bản nhúng thẳng vào CVAT.
   */
  const TAB_CSS = `
    .cvat-objects-sidebar-tabs .psa-tab .ant-tabs-tab-btn { display: inline-flex; align-items: center; gap: 6px; }
    .cvat-objects-sidebar-tabs .psa-tab svg { width: 16px; height: 16px; flex: none; }
    .cvat-objects-sidebar-tabs.psa-tab-on .ant-tabs-tab-active { background: transparent !important; }
    .cvat-objects-sidebar-tabs.psa-tab-on .ant-tabs-tab-active .ant-tabs-tab-btn { text-shadow: none; }
    .cvat-objects-sidebar-tabs.psa-tab-on .psa-tab { background: rgb(190, 190, 190) !important; }
    .cvat-objects-sidebar-tabs.psa-tab-on .psa-tab .ant-tabs-tab-btn { text-shadow: 0 0 .25px currentColor; }
    .cvat-objects-sidebar-tabs.psa-tab-on > .ant-tabs-content-holder, .cvat-objects-sidebar-tabs.psa-tab-on > .ps-pane { display: none !important; }
    .cvat-objects-sidebar-tabs:not(.psa-tab-on) > .psa-pane { display: none !important; }
    .cvat-objects-sidebar-tabs > .psa-pane { display: block !important; flex: 1 1 auto; min-height: 0; overflow-y: auto; background: #fff; }
  `;
  const TAB_ICON = LOGO.replace('class="logo" ', '');

  /**
   * Dựng bảng trong `container` (shadow DOM riêng): trả về { host, render(vm) }. Vẽ lại chỉ khi HTML đổi và giữ vị trí
   * cuộn; bấm nút / đổi ô chọn gọi `onAction(tên, data-*)`.
   */
  function mount(container, onAction, { floating = false } = {}) {
    const host = document.createElement('div');
    host.id = 'pointsnap-annotator';
    const shadow = host.attachShadow({ mode: 'open' });
    const panelEl = '<div class="panel" role="complementary" aria-label="PointSnap annotator"></div>';
    shadow.innerHTML = floating
      ? `<style>${CSS}${FLOAT_CSS}</style><div class="float">${panelEl}</div>`
        + `<button class="bubble" type="button" title="Mở bảng PointSnap (Alt+Shift+P) · kéo để dời" aria-label="Mở bảng PointSnap" hidden>${LOGO}<span class="dot"></span></button>`
      : `<style>${CSS}</style>${panelEl}`;
    const panel = shadow.querySelector('.panel');
    if (container) container.appendChild(host);
    let lastHtml = '';
    panel.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || el.disabled) return;
      if (el.tagName === 'SELECT') return;
      onAction(el.dataset.action, { ...el.dataset });
    });
    panel.addEventListener('change', (event) => {
      const el = event.target.closest('select[data-action]');
      if (el && !el.disabled) onAction(el.dataset.action, { ...el.dataset, value: el.value });
    });
    function render(vm) {
      const html = head(vm, floating) + `<div class="top">${top(vm)}</div><div class="body">${body(vm)}</div>`;
      if (html === lastHtml) return;
      const scroller = panel.querySelector('.body'), scroll = scroller ? scroller.scrollTop : 0;
      panel.innerHTML = html;
      lastHtml = html;
      const next = panel.querySelector('.body');
      if (next) next.scrollTop = scroll;
    }
    return { host, render };
  }

  /**
   * Bảng nổi trên trang CVAT (extension): không nhúng vào thanh bên của CVAT, không mất khi thao tác trên CVAT. Kéo
   * thanh tiêu đề để dời, kéo góc dưới phải để đổi cỡ, nút – (hoặc Alt+Shift+P) thu thành nút tròn, bấm nút tròn để mở
   * lại. Vị trí, cỡ, thu nhỏ được nhớ; bảng luôn nằm trong khung nhìn.
   */
  function createFloating(onAction) {
    const view = mount(document.body, (name, data) => (name === 'collapse-panel' ? setCollapsed(true) : onAction(name, data)), { floating: true });
    const shadow = view.host.shadowRoot, frame = shadow.querySelector('.float'), bubble = shadow.querySelector('.bubble');
    const saved = readPosition().float || {};
    const M = FLOAT_SIZE.margin;
    let pos = { left: saved.left, top: saved.top }, collapsed = saved.collapsed === true;
    if (saved.width) frame.style.width = `${saved.width}px`;
    if (saved.height) frame.style.height = `${saved.height}px`;

    const save = () => writePosition({ float: { ...pos, collapsed, width: frame.offsetWidth || saved.width, height: frame.offsetHeight || saved.height } });
    // Giữ bảng trong khung nhìn (cửa sổ thu nhỏ, đổi màn hình): ít nhất thanh tiêu đề luôn bấm / kéo được.
    function place() {
      const w = frame.offsetWidth || FLOAT_SIZE.width, h = collapsed ? 42 : (frame.offsetHeight || FLOAT_SIZE.height);
      if (!Number.isFinite(pos.left)) pos.left = innerWidth - w - 16;
      if (!Number.isFinite(pos.top)) pos.top = 64;
      pos.left = Math.max(M, Math.min(pos.left, innerWidth - (collapsed ? 42 : w) - M));
      pos.top = Math.max(M, Math.min(pos.top, innerHeight - (collapsed ? 42 : Math.min(h, 40)) - M));
      frame.style.left = bubble.style.left = `${pos.left}px`;
      frame.style.top = bubble.style.top = `${pos.top}px`;
    }
    function setCollapsed(value) {
      collapsed = value;
      frame.hidden = collapsed;
      bubble.hidden = !collapsed;
      place();
      save();
    }

    // Kéo: thanh tiêu đề của bảng (trừ nút) hoặc nút tròn. Nút tròn bấm không kéo thì mở bảng.
    let drag = null;
    function start(event, el) {
      if (event.button !== 0) return;
      drag = { el, x: event.clientX, y: event.clientY, left: pos.left, top: pos.top, moved: false };
      el.setPointerCapture(event.pointerId);
    }
    frame.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.head') && !event.target.closest('button')) start(event, frame);
    });
    bubble.addEventListener('pointerdown', (event) => start(event, bubble));
    for (const el of [frame, bubble]) {
      el.addEventListener('pointermove', (event) => {
        if (!drag || drag.el !== el) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        frame.classList.add('dragging');
        pos = { left: drag.left + dx, top: drag.top + dy };
        place();
      });
      el.addEventListener('pointerup', () => {
        if (!drag || drag.el !== el) return;
        const clicked = el === bubble && !drag.moved;
        drag = null;
        frame.classList.remove('dragging');
        save();
        if (clicked) setCollapsed(false);
      });
    }
    // Đổi cỡ bằng góc dưới phải (CSS resize): nhớ cỡ mới.
    let sizeTimer = 0;
    new ResizeObserver(() => { clearTimeout(sizeTimer); sizeTimer = setTimeout(() => { if (!collapsed) save(); }, 300); }).observe(frame);
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    setCollapsed(collapsed);

    return {
      render(vm) {
        // Nút tròn mang màu trạng thái của box đang chọn, thu nhỏ vẫn biết box ổn hay cần xem.
        bubble.querySelector('.dot').className = `dot ${vm.box?.level || ''}`;
        view.render(vm);
      },
      // Bảng nổi luôn có mặt (thu nhỏ chỉ ẩn khung): mặt đất, tô điểm, khoá box trên canvas luôn chạy.
      isOpen: () => true,
      toggle: () => setCollapsed(!collapsed),
      destroy() {
        window.removeEventListener('resize', onResize);
        view.host.remove();
      },
    };
  }

  /** Bảng trong tab "Hỗ trợ" của thanh bên CVAT (plugin QC, không có extension). */
  function create(onAction) {
    const view = mount(null, onAction), host = view.host;
    if (!document.getElementById('pointsnap-annotator-tab-css')) {
      const style = document.createElement('style');
      style.id = 'pointsnap-annotator-tab-css';
      style.textContent = TAB_CSS;
      document.head.appendChild(style);
    }
    let open = readPosition().open === true, listHooked = null;

    function setOpen(value) {
      open = value;
      writePosition({ open });
      ensureTab();
    }

    /** CVAT dựng lại thanh bên khi đổi job / thu gọn: mỗi lần vẽ kiểm lại tab, pane và bảng. */
    function ensureTab() {
      const tabs = document.querySelector('.cvat-objects-sidebar-tabs'), list = tabs?.querySelector('.ant-tabs-nav-list');
      if (!list) return;
      let tab = list.querySelector('.psa-tab'), pane = tabs.querySelector(':scope > .psa-pane');
      if (!tab) {
        tab = document.createElement('div');
        tab.className = 'ant-tabs-tab psa-tab';
        tab.innerHTML = `<div class="ant-tabs-tab-btn" role="tab" tabindex="0" title="PointSnap: hỗ trợ gán nhãn (Alt+Shift+P)">${TAB_ICON}<span>Hỗ trợ</span></div>`;
        tab.addEventListener('click', () => setOpen(true));
        tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } });
        list.insertBefore(tab, list.querySelector('.ant-tabs-ink-bar'));
      }
      if (listHooked !== list) {
        // Bấm Objects / Labels / tab QC: về tab đó.
        list.addEventListener('click', (e) => { if (e.target.closest('.ant-tabs-tab') && !e.target.closest('.psa-tab')) setOpen(false); });
        listHooked = list;
      }
      if (!pane) {
        pane = document.createElement('div');
        pane.className = 'psa-pane';
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-label', 'PointSnap hỗ trợ gán nhãn');
        tabs.querySelector('.ant-tabs-content-holder').after(pane);
      }
      if (host.parentNode !== pane) pane.appendChild(host);
      tabs.classList.toggle('psa-tab-on', open);
      tab.firstChild.setAttribute('aria-selected', String(open));
    }
    ensureTab();

    return {
      render: (vm) => { ensureTab(); view.render(vm); },
      // Mở bằng phím tắt: bấm hộ tab để các tab khác (Objects / Labels / QC) tự tắt như khi người dùng bấm.
      isOpen: () => open, toggle: () => { if (open) setOpen(false); else document.querySelector('.psa-tab')?.click(); },
      destroy: () => {
        host.remove();
        document.querySelector('.psa-tab')?.remove();
        document.querySelector('.psa-pane')?.remove();
        document.querySelector('.cvat-objects-sidebar-tabs')?.classList.remove('psa-tab-on');
      },
    };
  }

  function readPosition() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; }
  }

  function writePosition(values) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPosition(), ...values })); } catch (_) { /* bộ nhớ trang bị chặn: bỏ qua */ }
  }

  /** Thanh tiêu đề: chấm trạng thái + box đang chọn + số dòng cần xem + nút chung. */
  function head(vm, floating = false) {
    const b = vm.box;
    const title = b ? `${esc(b.label)} #${esc(b.clientId)} <small>· ${b.rangeM.toFixed(0)} m</small>` : 'PointSnap';
    const status = b ? `<span class="dot ${b.level}" title="${LEVEL_TEXT[b.level]}"></span>` : '<span class="dot"></span>';
    const count = b && b.problems ? `<span class="count ${b.level === 'error' ? 'error' : ''}">${b.problems} ${b.level === 'error' ? 'lỗi' : 'cần xem'}</span>` : '';
    const tools = vm.status === 'ready'
      ? `<div class="tools"><button class="${vm.follow ? 'on' : ''}" data-action="toggle-follow" aria-pressed="${vm.follow}" title="Đổi frame thì camera đi theo box đang chọn (${key('F')})">◎ Khoá box</button>`
        + '<button data-action="prev-undone" title="Chọn track chưa xong trước đó trong frame">⏮ Track trước</button>'
        + '<button data-action="next-undone" title="Chọn track chưa xong kế tiếp trong frame">Track sau ⏭</button>'
        + '<button data-action="open-spec" title="Spec của project: ngưỡng theo class / thuộc tính (mở trong trang CVAT)">⚙ Spec</button></div>'
      : '';
    const where = vm.status === 'ready'
      ? `<div class="ctx"><span>Job ${esc(vm.job)} · frame ${esc(vm.frame)}</span>${vm.progress ? `<span>· ${vm.progress.done}/${vm.progress.total} track xong</span>` : ''}`
        + `${vm.busy ? '<span class="busy">Đang chạy…</span>' : ''}</div>`
      : '';
    const min = floating ? '<button class="min" data-action="collapse-panel" title="Thu nhỏ thành nút tròn (Alt+Shift+P)" aria-label="Thu nhỏ bảng">–</button>' : '';
    return `<div class="head" title="${esc(SHORTCUTS)}">${status}<span class="title">${title}</span>${count}${min}</div>${where}${tools}`;
  }

  /** Phần đứng yên dưới tiêu đề: thông báo, Hoàn tác, lỗi bộ ngưỡng, hàng nút dùng nhiều nhất của box đang chọn. */
  function top(vm) {
    const parts = [];
    if (vm.notice) parts.push(`<div class="notice ${esc(vm.notice.kind)}" role="status">${esc(vm.notice.text)}</div>`);
    if (vm.undo) parts.push(`<button data-action="undo-last" title="Phục hồi các keyframe vừa sửa; keyframe đã bị sửa tiếp thì giữ nguyên">↶ Hoàn tác: ${esc(vm.undo.title)} (${vm.undo.count})</button>`);
    const errors = vm.guidelineErrors || [];
    if (errors.length) {
      // Một dòng: ghi đè sai một nhánh (vd "size": null) sinh hàng chục lỗi; danh sách đầy đủ ở tooltip.
      const more = errors.length > 1 ? ` (+${errors.length - 1} lỗi khác)` : '';
      parts.push(`<div class="notice error" title="${esc(errors.join('\n'))}">Bộ ngưỡng lỗi, đang dùng mặc định: ${esc(errors[0])}${more}</div>`);
    }
    const b = vm.status === 'ready' ? vm.box : null;
    if (b) {
      const off = (reason) => `disabled title="${reason}"`;
      const locked = b.locked ? off('Box đang khóa') : '';
      const ground = b.rows.find((r) => r.key === 'ground');
      const attention = ground && (ground.level === 'warning' || ground.level === 'error') ? ' attention' : '';
      const snap = `<button class="primary${attention}" data-action="snap-ground" ${locked || (b.canSnap ? 'title="Đáy box chạm mặt đất đo được ở frame này"' : off('Chưa đo được mặt đất quanh box này'))}>Hạ đáy<small>${key('G')}</small></button>`;
      const all = b.isTrack ? `<button data-action="snap-track" ${locked || 'title="Như bấm Hạ đáy ở từng frame track xuất hiện (cả frame nội suy); ghi luôn, chưa Save"'}>Hạ đáy mọi frame<small>cả track</small></button>` : '';
      const done = b.isTrack ? `<button class="${b.done ? 'on' : ''}" data-action="toggle-done" aria-pressed="${b.done}" title="Đánh dấu track đã làm xong">${b.done ? '✓ Đã xong' : 'Xong'}<small>${key('D')}</small></button>` : '';
      parts.push(`<div class="quick">${snap}${all}${done}</div>`);
    }
    return parts.join('');
  }

  function body(vm) {
    const parts = [];
    if (vm.status !== 'ready') return `<div class="empty">${esc(vm.message || 'Chờ mở job 3D…')}</div>`;
    if (!vm.box) {
      return '<div class="empty"><div>Chọn một cuboid trên CVAT để kiểm tra.</div>'
        + '<button data-action="next-undone" title="Chọn track chưa xong kế tiếp trong frame">⏭ Track chưa xong kế tiếp</button></div>';
    }
    if (vm.box.locked) parts.push('<div class="notice">🔒 Box đang khóa trong CVAT: chỉ xem, không sửa.</div>');
    const cls = vm.box.classKey !== vm.box.label ? ` · ${esc(vm.box.classKey)}` : '';
    parts.push(`<div class="sec"><span>Kiểm tra box${cls}</span><button class="link" data-action="toggle-spec" aria-pressed="${vm.specOpen}">${vm.specOpen ? 'Ẩn spec' : 'Spec của class'}</button></div>`,
      checksSection(vm.box));
    if (vm.spec) parts.push(specSection(vm.spec));
    if (vm.box.isTrack) parts.push(trackSection(vm));
    if (vm.plan) parts.push(planSection(vm.plan));
    return parts.join('');
  }

  /** Checklist: mỗi khía cạnh một dòng, nút sửa nằm ngay trên dòng của vấn đề. */
  function checksSection(b) {
    const rows = b.rows.map((r) => {
      const fix = r.fix && r.fix.action !== 'snap-ground'
        ? `<button data-action="${esc(r.fix.action)}"${r.fix.source ? ` data-source="${esc(r.fix.source)}"` : ''}${r.fix.key ? ` title="${key(esc(r.fix.key))}"` : ''}>${esc(r.fix.label)}</button>`
        : '';
      // Báo nhầm: bỏ qua dòng này cho box / track này; đã bỏ qua thì có nút hiện lại.
      const toggle = r.canDismiss
        ? `<button class="x" data-action="dismiss-row" data-row="${esc(r.key)}" data-name="${esc(r.name)}" title="Báo nhầm: không báo mục này cho box này nữa" aria-label="Bỏ qua ${esc(r.name)}">✕</button>`
        : r.dismissed ? `<button class="x" data-action="restore-row" data-row="${esc(r.key)}" title="Hiện lại cảnh báo này" aria-label="Hiện lại ${esc(r.name)}">↺</button>` : '';
      return `<div class="check ${r.level}" title="${esc(r.tip || LEVEL_TEXT[r.level])}"><i aria-label="${LEVEL_TEXT[r.level]}">${ICON[r.level]}</i>`
        + `<span class="name">${esc(r.name)}</span><span class="text">${esc(r.text)}</span><span class="acts">${fix}${toggle}</span></div>`;
    }).join('');
    return `<div class="checks">${rows}</div>`;
  }

  function specSection(spec) {
    const dims = spec.dims
      ? spec.dims.map((d) => {
        const ok = d.value >= d.lo && d.value <= d.hi;
        return `<div class="row"><span>${esc(d.name)} ${d.lo.toFixed(2)}–${d.hi.toFixed(2)} m</span><span class="${ok ? '' : 'warn'}">${d.value.toFixed(2)} ${ok ? '✓' : '✗'}</span></div>`;
      }).join('')
      : '<div class="muted">Chưa có khoảng kích thước cho class này.</div>';
    const required = spec.required.map((a) => `<div class="row"><span>${esc(a.name)}</span><span class="${a.value ? '' : 'bad'}">${a.value ? esc(a.value) : 'chưa chọn'}</span></div>`).join('');
    const overlap = spec.overlapWith.length ? `<div><b>Được chồng với:</b> ${esc(spec.overlapWith.join(', '))}</div>` : '';
    return `<div class="spec"><div class="row"><b>Spec · ${esc(spec.key)}</b><button class="link" data-action="open-spec">Sửa</button></div>${dims}${required}${overlap}<ul>${spec.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  }

  /** Dải track: một ô mỗi keyframe (vàng: cảnh báo, đỏ: lỗi), ô đang đứng có viền; bấm ô để tới frame. */
  function trackSection(vm) {
    const t = vm.track;
    if (!t || t.loading) return '<div class="muted">Track · đang đọc keyframe…</div>';
    const here = t.cells.reduce((best, c, i) => (c.frame <= vm.frame ? i : best), -1);
    const cells = t.cells.map((c, i) => `<button class="${c.level}${i === here ? ' here' : ''}" data-action="goto-frame" data-frame="${c.frame}" `
      + `title="Frame ${c.frame}${c.reasons.length ? `: ${esc(c.reasons.join(', '))}` : ''}" aria-label="Frame ${c.frame}"></button>`).join('');
    // Frame đang đứng có lỗi ở checklist thì báo ngay cả khi frame này là frame nội suy (không có ô trên dải).
    const cur = t.current?.count ? ` · <span class="${t.current.level === 'error' ? 'bad' : 'warn'}">frame này ${t.current.count} lỗi</span>` : '';
    const status = t.flagged ? ` · <span class="warn">${t.flagged} keyframe cần xem</span>` : cur ? '' : ' · ổn';
    const summary = `<div class="sec"><span>Track</span></div><div class="row"><span>${t.cells.length} keyframe${status}${cur}</span></div>`;
    const ends = t.cells.length ? `<div class="ticks"><span>${t.cells[0].frame}</span><span class="now">▲ đang xem frame ${esc(vm.frame)}</span>`
      + `<span>${t.cells[t.cells.length - 1].frame}</span></div>` : '';
    const flagged = t.cells.filter((c) => c.level !== 'ok' && c.reasons.length);
    const reasons = flagged.length
      ? `<div class="reasons">${flagged.slice(0, 4).map((c) => `<button class="${c.level}" data-action="goto-frame" data-frame="${c.frame}" title="Tới frame ${c.frame}">`
        + `Frame ${c.frame}: ${esc(c.reasons.join(', '))}</button>`).join('')}${flagged.length > 4 ? `<span class="muted">… và ${flagged.length - 4} keyframe khác</span>` : ''}</div>`
      : '';
    const strip = `<div class="strip" style="grid-template-columns: repeat(${t.cells.length}, minmax(0, 1fr))${t.cells.length > 120 ? '; gap: 0' : ''}">${cells}</div>${ends}${reasons}`;
    const toggle = `<button class="sec" data-action="toggle-track" aria-expanded="${vm.trackOpen}"><span>Sửa cả track</span><span>${vm.trackOpen ? '▾' : '▸'}</span></button>`;
    if (!vm.trackOpen) return summary + strip + toggle;
    const off = (reason) => `disabled title="${reason}"`;
    const rigidOnly = (title) => (t.locked ? off('Box đang khóa') : t.rigid ? `title="${title}"` : off('Người / động vật đổi tư thế: không áp dụng'));
    return summary + strip + toggle
      + `<div class="grid2"><button data-action="plan-sync-size" data-source="current" ${rigidOnly('Cả track lấy kích thước box ở frame này')}>Cỡ = frame này</button>`
      + `<button data-action="plan-sync-size" data-source="median" ${rigidOnly('Cả track lấy trung vị kích thước các keyframe')}>Cỡ trung vị</button>`
      + `<button data-action="plan-smooth-yaw" ${rigidOnly('Sửa lật đầu, làm mượt hướng')}>Mượt yaw</button>`
      + `<button data-action="plan-thin" ${t.locked ? off('Box đang khóa') : 'title="Bỏ keyframe mà CVAT tự nội suy lại được"'}>Tỉa keyframe</button></div>`
      + attrSection(t);
  }

  /**
   * Thuộc tính cả track: chọn giá trị cho một hoặc nhiều thuộc tính (chưa ghi), rồi một nút gán tất cả cho mọi frame
   * track xuất hiện. Dòng "giữ nguyên" bỏ qua thuộc tính đó.
   */
  function attrSection(t) {
    if (!t.attrs?.length) return '';
    const off = (reason) => `disabled title="${reason}"`;
    const rows = t.attrs.map((a) => {
      const options = `<option value=""${a.draft ? '' : ' selected'}>— giữ nguyên —</option>`
        + a.values.map((v) => `<option value="${esc(v)}"${v === a.draft ? ' selected' : ''}>${esc(v)}${v === a.current ? ' (frame này)' : ''}</option>`).join('');
      const now = `${esc(a.current || '—')}${a.mixed ? ' <span class="warn" title="Các keyframe đang mang nhiều giá trị khác nhau">· nhiều giá trị</span>' : ''}`;
      return `<label class="attr"><span title="${esc(a.name)}">${esc(a.name)}: <b>${now}</b></span><select data-action="draft-attr" data-attr="${esc(a.id)}" ${t.locked ? 'disabled' : ''}`
        + ` title="Giá trị sẽ gán cho mọi frame của track">${options}</select></label>`;
    }).join('');
    const picked = t.attrs.filter((a) => a.draft).length;
    const button = `<button class="primary" data-action="set-attrs" ${t.locked ? off('Box đang khóa') : picked ? `title="Gán ${picked} thuộc tính cho mọi frame track xuất hiện, ghi luôn, chưa Save"` : off('Chọn giá trị cho ít nhất một thuộc tính')}>`
      + `Gán ${picked || ''} thuộc tính cho mọi frame</button>`;
    return `<div class="attrs"><div class="sec">Thuộc tính cả track</div>${rows}${button}</div>`;
  }

  function planSection(plan) {
    const ghost = plan.edits?.some((e) => e.box) ? '<div class="ghost">Nét đứt xanh trên canvas: box sau khi sửa ở frame này.</div>' : '';
    return `<div class="plan" role="region" aria-label="Xem trước thay đổi"><b>${esc(plan.title)}</b>${plan.lines.map((l) => `<div>${esc(l)}</div>`).join('')}${ghost}`
      + `<div class="row"><button class="primary" data-action="apply-plan" ${plan.canApply ? '' : 'disabled'}>Áp dụng (chưa Save)</button><button data-action="cancel-plan">Hủy</button></div></div>`;
  }

  root.PointSnapAnnotatorPanel = { create, createFloating, mount };
})(globalThis);

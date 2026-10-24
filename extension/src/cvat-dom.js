/*
 * Đọc giao diện CVAT và bấm hộ các nút có sẵn (A15).
 * Chỉ dùng tên lớp ổn định mà bộ test tự động của CVAT dùng; không đọc hay sửa trạng thái nội bộ của trang.
 * Mọi hàm "bấm hộ" trả về { ok, reason } để phần giao diện báo rõ và chuyển sang hướng dẫn thao tác tay.
 */
(function (root) {
  'use strict';

  const SEL = {
    frameInput: '.cvat-player-frame-selector input',
    frameSlider: '.cvat-player-slider [role="slider"]',
    filtersButton: '.cvat-annotation-header-filters-button',
    filtersModal: '.cvat-filters-modal-visible',
    recentButton: '.cvat-filters-modal-recently-used-button',
    recentDropdown: '.cvat-recently-used-filters-dropdown',
    submitButton: '.cvat-filters-modal-submit-button',
    cancelButton: '.cvat-filters-modal-cancel-button',
    sidebarItem: '.cvat-objects-sidebar-state-item',
    activeItem: '.cvat-objects-sidebar-state-active-item',
    attrWrapper: '.cvat-object-item-attribute-wrapper',
    labelSelector: '.cvat-objects-sidebar-state-item-label-selector',
    canvas3d: '.cvat-canvas3d-fullsize, .cvat-canvas3d-perspective, #cvat-canvas3d-wrapper',
    canvas3dWrapper: '#cvat-canvas3d-wrapper, .cvat-canvas3d-perspective, .cvat-canvas3d-fullsize',
    canvas3dCanvas: '#cvat-canvas3d-wrapper canvas, .cvat-canvas3d-perspective canvas, .cvat-canvas3d-fullsize canvas',
    canvas3dTopView: '.cvat-canvas3d-topview',
    canvas3dSideView: '.cvat-canvas3d-sideview',
    canvas3dFrontView: '.cvat-canvas3d-frontview',
    canvas3dOverlay: '.pointsnap-3d-overlay, #pointsnap-canvas3d-overlay',
  };

  const FILTERS_HISTORY = 'annotationFiltersHistory';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Chờ tới khi `probe()` trả về giá trị khác null/false, tối đa `timeout` ms. */
  async function waitFor(probe, timeout = 4000, step = 80) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }

  const $ = (sel, scope) => (scope || document).querySelector(sel);

  function isVisible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  /** Trang job đã dựng xong thanh điều khiển frame và danh sách đối tượng. */
  function workspaceReady() {
    return !!$(SEL.frameInput) && !!$('.cvat-objects-sidebar');
  }

  /**
   * Frame CVAT đang hiển thị, đọc từ thanh trượt frame (`aria-valuenow`). Không đọc ô số frame vì ô này
   * đổi ngay khi gõ, trước khi CVAT thật sự chuyển frame.
   */
  function currentFrame() {
    const slider = $(SEL.frameSlider);
    const raw = slider ? slider.getAttribute('aria-valuenow') : null;
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /** Gán giá trị cho ô nhập do React quản lý, như khi người dùng gõ. */
  function typeInto(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(el) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /** Chuyển tới `frame` bằng ô chọn frame của CVAT (không tải lại trang). */
  async function goToFrame(frame) {
    const input = $(SEL.frameInput);
    if (!input) return { ok: false, reason: 'Không thấy ô chọn frame của CVAT' };
    if (currentFrame() === frame) return { ok: true };
    // CVAT bỏ qua lệnh chuyển frame khi đang bận (vd. vừa áp bộ lọc, đang tải lại nhãn): thử tối đa hai lần.
    let moved = false;
    for (let attempt = 0; attempt < 2 && !moved; attempt += 1) {
      input.focus();
      typeInto(input, frame);
      pressEnter(input);
      // CVAT tải point cloud của frame mới trước khi đổi frame: chờ thanh trượt chỉ đúng frame.
      moved = await waitFor(() => currentFrame() === frame, 2500);
      if (!moved) {
        // Ô chọn frame cũng chuyển frame khi mất focus.
        input.blur();
        moved = await waitFor(() => currentFrame() === frame, 2500);
      }
    }
    input.blur();
    return moved ? { ok: true } : { ok: false, reason: `CVAT không chuyển sang frame ${frame}` };
  }

  /** Bộ lọc của CVAT đang bật (nút Filters có lớp `filters-armed`). */
  function filtersActive() {
    const button = $(SEL.filtersButton);
    return !!button && button.classList.contains('filters-armed');
  }

  /**
   * Thêm bộ lọc PointSnap vào "Recently used" của CVAT (lịch sử bộ lọc trong localStorage của trang),
   * như khi người dùng đã tự tạo bộ lọc này một lần. CVAT đọc lịch sử khi mở trang job.
   */
  function seedFilterHistory(logic) {
    let history = [];
    try {
      history = JSON.parse(window.localStorage.getItem(FILTERS_HISTORY) || '[]');
      if (!Array.isArray(history)) history = [];
    } catch (_) {
      history = [];
    }
    const key = JSON.stringify(logic);
    if (history.some((f) => JSON.stringify(f.logic) === key)) return false;
    const entry = { id: `pointsnap-${Date.now()}`, logic, keypointLogic: {} };
    window.localStorage.setItem(FILTERS_HISTORY, JSON.stringify([entry, ...history].slice(0, 10)));
    return true;
  }

  function closeFiltersModal() {
    const cancel = $(SEL.cancelButton);
    if (cancel) cancel.click();
  }

  /**
   * Bấm hộ: Filters → Recently used → mục có `attrName` → Submit.
   * Trả về { ok, reason, needsReload } — needsReload khi CVAT chưa nạp mục PointSnap vào lịch sử.
   */
  async function applyRecentFilter(attrName) {
    // Filters có thể đang lọc ServerID của một box khác. Bật PointSnap phải chọn lại đúng bộ lọc,
    // không coi một bộ lọc CVAT bất kỳ là bộ lọc pointsnap_error.
    const t0 = performance.now();
    const steps = {};
    const mark = (name) => { steps[name] = Math.round(performance.now() - t0); };
    const button = $(SEL.filtersButton);
    if (!button) return { ok: false, reason: 'Không thấy nút Filters của CVAT' };
    button.click();
    const modal = await waitFor(() => $(SEL.filtersModal));
    if (!modal) return { ok: false, reason: 'Hộp thoại Filters không mở' };
    mark('modal');

    const recent = $(SEL.recentButton, modal);
    if (!recent || !isVisible(recent)) {
      closeFiltersModal();
      return { ok: false, needsReload: true, reason: 'CVAT chưa có bộ lọc PointSnap trong "Recently used"' };
    }
    recent.click();
    const item = await waitFor(() => {
      const menu = document.querySelector(`${SEL.recentDropdown}:not(.ant-popover-hidden)`);
      if (!menu) return null;
      return [...menu.querySelectorAll('[role="menuitem"], .ant-menu-item, .ant-dropdown-menu-item')]
        .find((el) => el.textContent.includes(attrName));
    });
    if (!item) {
      recent.click();
      closeFiltersModal();
      return { ok: false, needsReload: true, reason: 'CVAT chưa có bộ lọc PointSnap trong "Recently used"' };
    }
    mark('menu');
    item.click();
    const submit = await waitFor(() => {
      const el = $(SEL.submitButton);
      return el && !el.disabled ? el : null;
    }, 2000);
    if (!submit) {
      closeFiltersModal();
      return { ok: false, reason: 'Nút Submit của bộ lọc không bấm được' };
    }
    mark('submit');
    submit.click();
    const armed = await waitFor(filtersActive, 3000);
    mark('armed');
    return armed ? { ok: true, steps } : { ok: false, steps, reason: 'Đã bấm Submit nhưng bộ lọc chưa bật' };
  }

  /** Bấm hộ "Clear filters" trong hộp thoại Filters. */
  async function clearFilters() {
    if (!filtersActive()) return { ok: true };
    const button = $(SEL.filtersButton);
    if (!button) return { ok: false, reason: 'Không thấy nút Filters của CVAT' };
    button.click();
    const clear = await waitFor(() => $('.cvat-filters-modal-clear-button'));
    if (!clear) return { ok: false, reason: 'Không thấy nút Clear filters' };
    clear.click();
    const off = await waitFor(() => !filtersActive(), 3000);
    return off ? { ok: true } : { ok: false, reason: 'Bộ lọc chưa tắt' };
  }

  /** Nhãn hiển thị của một mục trong danh sách đối tượng. */
  function itemLabel(item) {
    const sel = $(SEL.labelSelector, item);
    if (!sel) return null;
    const chosen = sel.querySelector('.ant-select-selection-item');
    return chosen ? (chosen.getAttribute('title') || chosen.textContent || '').trim() : null;
  }

  function itemClientId(item) {
    const m = (item.id || '').match(/cvat-objects-sidebar-state-item-(\d+)$/);
    return m ? Number(m[1]) : null;
  }

  /** Giá trị thuộc tính `attrName` hiện trong khung chi tiết của mục (null nếu khung đang thu gọn). */
  function itemAttribute(item, attrName) {
    for (const wrapper of item.querySelectorAll(SEL.attrWrapper)) {
      const name = wrapper.querySelector('.cvat-text');
      if (name && name.textContent.trim() === attrName) {
        const field = wrapper.querySelector('textarea, input');
        return field ? field.value : null;
      }
    }
    return null;
  }

  /** Đối tượng đang được chọn / trỏ chuột trong CVAT: { clientId, label, flag } hoặc null. */
  function activeObject(attrName) {
    const item = $(SEL.activeItem);
    if (!item) return null;
    return { clientId: itemClientId(item), label: itemLabel(item), flag: itemAttribute(item, attrName) };
  }

  /** Các mục trong danh sách đối tượng bên phải (sau khi lọc chỉ còn box có cờ). */
  function sidebarItems() {
    return [...document.querySelectorAll(SEL.sidebarItem)].map((item) => ({
      el: item,
      clientId: itemClientId(item),
      label: itemLabel(item),
      flag: itemAttribute(item, 'pointsnap_error'),
    }));
  }

  /**
   * Mở khung DETAILS của các mục đang thu gọn để CVAT hiện thuộc tính `pointsnap_error` (chỉ là mở rộng giao diện,
   * như người dùng bấm vào chữ DETAILS). `done` giữ các mục đã mở một lần để không giành lại khi người dùng tự thu gọn.
   */
  function expandDetails(done, limit = 6) {
    let opened = 0;
    for (const item of document.querySelectorAll(SEL.sidebarItem)) {
      if (opened >= limit) break;
      const id = itemClientId(item);
      if (id === null || done.has(id)) continue;
      const collapse = item.querySelector('.cvat-objects-sidebar-state-item-collapse');
      if (!collapse) continue;
      done.add(id);
      const header = collapse.querySelector('.ant-collapse-header');
      if (header && !collapse.querySelector('.ant-collapse-item-active')) {
        header.click();
        opened += 1;
      }
    }
    return opened;
  }

  /**
   * Làm sáng box trên khung 3D bằng cách rê chuột vào mục của nó trong danh sách đối tượng,
   * giống người dùng rê chuột (CVAT kích hoạt đối tượng khi chuột đi vào mục).
   */
  function hoverItem(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'nearest' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: document.body }));
    return true;
  }

  /**
   * Tự kiểm khi mở job: các phần giao diện CVAT mà extension cần nhưng không tìm thấy
   * (thường do CVAT khác phiên bản 2.77). Trả về tên dễ hiểu của từng phần thiếu.
   */
  function missingParts() {
    const parts = [
      ['ô số frame', SEL.frameInput],
      ['thanh trượt frame', SEL.frameSlider],
      ['nút Filters', SEL.filtersButton],
      ['danh sách đối tượng', '.cvat-objects-sidebar'],
    ];
    return parts.filter(([, sel]) => !$(sel)).map(([name]) => name);
  }

  /**
   * Truy xuất phần tử bao quanh khung 3D canvas của CVAT.
   */
  function canvas3dWrapper() {
    return $(SEL.canvas3dWrapper);
  }

  /**
   * Truy xuất thẻ canvas WebGL 3D thực tế.
   */
  function canvas3dCanvas() {
    return $(SEL.canvas3dCanvas);
  }

  /**
   * Lấy kích thước và toạ độ màn hình của viewport 3D để căn vị trí HUD.
   */
  function canvas3dRect() {
    const el = canvas3dCanvas() || canvas3dWrapper();
    return el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  }

  root.PointSnapCvat = {
    missingParts,
    SEL,
    waitFor,
    workspaceReady,
    currentFrame,
    goToFrame,
    filtersActive,
    seedFilterHistory,
    applyRecentFilter,
    clearFilters,
    activeObject,
    sidebarItems,
    hoverItem,
    expandDetails,
    canvas3dWrapper,
    canvas3dCanvas,
    canvas3dRect,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.PointSnapCvat;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * Chuyển frame bằng chính ô chọn frame của CVAT (dải track của bảng annotator: bấm ô để tới frame).
 * Chỉ dùng tên lớp ổn định mà bộ test tự động của CVAT dùng; trả về { ok, reason } để bảng báo rõ khi không được.
 */
(function (root) {
  'use strict';

  const SEL = {
    frameInput: '.cvat-player-frame-selector input',
    frameSlider: '.cvat-player-slider [role="slider"]',
  };

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

  const $ = (sel) => document.querySelector(sel);

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

  root.PointSnapCvat = { currentFrame, goToFrame };
})(globalThis);

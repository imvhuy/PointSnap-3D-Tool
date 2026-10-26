/*
 * Bảng PointSnap cho annotator (shadow DOM, không lẫn CSS với CVAT). Chỉ hiển thị view-model do controller đưa vào
 * và báo lại thao tác qua `onAction(name, data)`; không tự đọc CVAT.
 * Bố cục: thanh tiêu đề (chấm trạng thái + box đang chọn, luôn hiện kể cả khi thu gọn) → checklist từng khía cạnh,
 * mỗi dòng có nút sửa đúng vấn đề của nó → dải track một ô mỗi keyframe, bấm ô để tới frame → bản xem trước.
 * Nền tối cho hợp với canvas 3D của CVAT; màu một nghĩa: xanh lá ổn, cam cần xem, đỏ lỗi.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'pointsnap.annotator.panel';
  const SHORTCUTS = 'Alt+Shift+G: hạ đáy box · Alt+Shift+F: khoá box · Alt+Shift+D: đánh dấu track xong. Save / Undo bằng CVAT.';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ICON = { ok: '✓', warning: '!', error: '✕', na: '–', muted: '–' };
  const LEVEL_TEXT = { ok: 'Ổn', warning: 'Cần xem', error: 'Lỗi', na: 'Chưa đo được', muted: 'Đã bỏ qua' };

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; z-index: 2147483000; width: 288px; display: flex; flex-direction: column;
      background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
      font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; overflow-wrap: anywhere; }
    .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #0b1220; border-bottom: 1px solid #1f2937; cursor: move; user-select: none; }
    .head .title { font-weight: 600; margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head .title small { font-weight: 400; color: #9ca3af; }
    .head > .muted, .head .count { flex: none; white-space: nowrap; }
    .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #4b5563; }
    .dot.ok { background: #22c55e; } .dot.warning { background: #f59e0b; } .dot.error { background: #ef4444; }
    .count { font-weight: 700; font-size: 11px; padding: 0 6px; border-radius: 9px; background: #78350f; color: #fde68a; }
    .count.error { background: #7f1d1d; color: #fecaca; }
    .muted { color: #9ca3af; }
    .body { overflow-y: auto; overflow-x: hidden; padding: 6px 8px 8px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .collapsed .body { display: none; }
    button { font: inherit; font-weight: 600; border: 1px solid #374151; background: #1f2937; color: #e5e7eb; border-radius: 5px; padding: 2px 7px; cursor: pointer; white-space: nowrap; }
    button:hover:not(:disabled) { background: #273449; border-color: #3b82f6; }
    button:disabled { opacity: .45; cursor: default; }
    button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    button.on { background: #1e3a8a; border-color: #3b82f6; }
    .head button { background: transparent; border-color: transparent; padding: 0 4px; font-size: 13px; color: #cbd5e1; }
    .head button.on { background: #1e3a8a; }
    kbd { font: 10px ui-monospace, Consolas, monospace; color: #9ca3af; border: 1px solid #4b5563; border-radius: 3px; padding: 0 3px; margin-left: 4px; }
    .notice { padding: 4px 7px; border-radius: 5px; background: #172554; color: #bfdbfe; }
    .notice.error { background: #450a0a; color: #fecaca; } .notice.ok { background: #052e16; color: #bbf7d0; }
    .checks { display: grid; grid-template-columns: minmax(0, 1fr); border: 1px solid #1f2937; border-radius: 7px; overflow: hidden; }
    .check { display: grid; grid-template-columns: 16px 66px minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 4px 7px; border-top: 1px solid #1f2937; }
    .check:first-child { border-top: 0; }
    .check i { font-style: normal; font-weight: 800; text-align: center; border-radius: 50%; width: 15px; height: 15px; line-height: 15px; font-size: 10px; }
    .check.ok i { background: #14532d; color: #86efac; } .check.warning i { background: #78350f; color: #fde68a; }
    .check.error i { background: #7f1d1d; color: #fecaca; } .check.na i, .check.muted i { background: #374151; color: #9ca3af; }
    .check.muted .text { color: #6b7280; }
    .check .acts { display: flex; gap: 3px; align-items: center; }
    .check .acts .x { border: 0; background: none; color: #6b7280; padding: 0 3px; font-size: 12px; }
    .check .acts .x:hover { color: #e5e7eb; background: none; }
    .check .name { color: #9ca3af; }
    .check .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check.warning .text { color: #fbbf24; } .check.error .text { color: #f87171; }
    .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 6px; }
    .strip { display: grid; gap: 1px; height: 16px; }
    .strip button { padding: 0; border: 0; border-radius: 2px; background: #374151; min-width: 0; }
    .strip button.warning { background: #f59e0b; } .strip button.here { outline: 2px solid #e5e7eb; outline-offset: -1px; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px; }
    .plan, .spec { background: #0b1220; border: 1px solid #1f2937; border-radius: 7px; padding: 6px 7px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; }
    .plan .ghost { color: #93c5fd; }
    .spec ul { margin: 0; padding-left: 14px; color: #cbd5e1; }
    .warn { color: #fbbf24; } .bad { color: #f87171; }
    .link { border: 0; background: none; padding: 0; color: #93c5fd; font-weight: 600; }
    .link:hover:not(:disabled) { background: none; text-decoration: underline; }
  `;

  function create(onAction) {
    const host = document.createElement('div');
    host.id = 'pointsnap-annotator';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><div class="panel" role="complementary" aria-label="PointSnap annotator"></div>`;
    const panel = shadow.querySelector('.panel');
    document.documentElement.appendChild(host);

    const saved = readPosition();
    let collapsed = !!saved.collapsed, lastHtml = '';
    place(saved.left, saved.top);

    function place(left, top) {
      const x = Number.isFinite(left) ? left : window.innerWidth - 308, y = Number.isFinite(top) ? top : 90;
      panel.style.left = `${Math.max(0, Math.min(x, window.innerWidth - 80))}px`;
      const clampedTop = Math.max(0, Math.min(y, window.innerHeight - 30));
      panel.style.top = `${clampedTop}px`;
      // Không cho bảng tràn khỏi mép dưới màn hình khi đặt thấp: phần thân cuộn bên trong.
      panel.style.maxHeight = `${Math.max(30, window.innerHeight - clampedTop - 8)}px`;
    }
    // Cửa sổ thu nhỏ (đổi màn hình, mở DevTools): kéo bảng về trong màn hình, không để mất thanh tiêu đề.
    const onResize = () => place(parseFloat(panel.style.left), parseFloat(panel.style.top));
    window.addEventListener('resize', onResize);

    panel.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || el.disabled) return;
      if (el.dataset.action === 'collapse') {
        collapsed = !collapsed;
        writePosition({ collapsed });
        lastHtml = '';
        onAction('rerender');
        return;
      }
      onAction(el.dataset.action, { ...el.dataset });
    });
    panel.addEventListener('mousedown', (event) => {
      if (!event.target.closest('.head') || event.target.closest('button') || event.button !== 0) return;
      const rect = panel.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      const move = (e) => place(e.clientX - dx, e.clientY - dy);
      const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        writePosition({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) });
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
      event.preventDefault();
    });

    function render(vm) {
      panel.classList.toggle('collapsed', collapsed);
      const html = head(vm, collapsed) + (collapsed ? '' : `<div class="body">${body(vm)}</div>`);
      if (html === lastHtml) return;
      const scroller = panel.querySelector('.body'), scroll = scroller ? scroller.scrollTop : 0;
      panel.innerHTML = html;
      lastHtml = html;
      const next = panel.querySelector('.body');
      if (next) next.scrollTop = scroll;
    }

    return { render, destroy: () => { window.removeEventListener('resize', onResize); host.remove(); } };
  }

  function readPosition() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; }
  }

  function writePosition(values) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPosition(), ...values })); } catch (_) { /* bộ nhớ trang bị chặn: bỏ qua */ }
  }

  /** Thanh tiêu đề: chấm trạng thái + box đang chọn + số dòng cần xem; luôn hiện, kể cả khi thu gọn. */
  function head(vm, collapsed) {
    const b = vm.box;
    const title = b ? `${esc(b.label)} #${esc(b.clientId)} <small>· ${b.rangeM.toFixed(0)} m</small>` : 'PointSnap';
    const status = b ? `<span class="dot ${b.level}" title="${LEVEL_TEXT[b.level]}"></span>` : '<span class="dot"></span>';
    const count = b && b.problems ? `<span class="count ${b.level === 'error' ? 'error' : ''}" title="Số mục cần xem">${b.problems}</span>` : '';
    const progress = vm.progress ? `<span class="muted" title="Track đã xong / track trong frame">${vm.progress.done}/${vm.progress.total}</span>` : '';
    const tools = vm.status === 'ready'
      ? `<button class="${vm.follow ? 'on' : ''}" data-action="toggle-follow" aria-pressed="${vm.follow}" aria-label="Khoá box" title="Khoá box: đổi frame thì camera đi theo box đang chọn (Alt+Shift+F)">◎</button>`
        + '<button data-action="next-undone" aria-label="Track chưa xong kế tiếp" title="Chọn track chưa xong kế tiếp trong frame">⏭</button>'
        + '<button data-action="open-spec" aria-label="Spec của project" title="Spec của project: ngưỡng theo class / thuộc tính">⚙</button>'
      : '';
    return `<div class="head" title="${esc(SHORTCUTS)}">${status}<span class="title">${title}</span>${count}${progress}${tools}`
      + `<button data-action="collapse" aria-label="${collapsed ? 'Mở rộng' : 'Thu gọn'}">${collapsed ? '▾' : '▴'}</button></div>`;
  }

  function body(vm) {
    const parts = [];
    if (vm.notice) parts.push(`<div class="notice ${esc(vm.notice.kind)}" role="status">${esc(vm.notice.text)}</div>`);
    if (vm.undo) parts.push(`<button data-action="undo-last" title="Phục hồi các keyframe vừa sửa; keyframe đã bị sửa tiếp thì giữ nguyên">↶ Hoàn tác: ${esc(vm.undo.title)} (${vm.undo.count})</button>`);
    const errors = vm.guidelineErrors || [];
    if (errors.length) {
      // Một dòng: ghi đè sai một nhánh (vd "size": null) sinh hàng chục lỗi; danh sách đầy đủ ở tooltip.
      const more = errors.length > 1 ? ` (+${errors.length - 1} lỗi khác)` : '';
      parts.push(`<div class="notice error" title="${esc(errors.join('\n'))}">Bộ ngưỡng lỗi, đang dùng mặc định: ${esc(errors[0])}${more}</div>`);
    }
    if (vm.status !== 'ready') return [...parts, `<div class="muted">${esc(vm.message || 'Chờ mở job 3D…')}</div>`].join('');
    if (!vm.box) return [...parts, '<div class="muted">Chọn một cuboid để kiểm tra.</div>'].join('');
    if (vm.box.locked) parts.push('<div class="notice">🔒 Box đang khóa trong CVAT: chỉ xem, không sửa.</div>');
    parts.push(checksSection(vm.box));
    parts.push(`<div class="row"><span class="muted">${esc(vm.box.classKey !== vm.box.label ? vm.box.classKey : '')}</span>`
      + `<button class="link" data-action="toggle-spec" aria-pressed="${vm.specOpen}">${vm.specOpen ? 'Ẩn spec' : 'Spec của class'}</button></div>`);
    if (vm.spec) parts.push(specSection(vm.spec));
    if (vm.box.isTrack) parts.push(trackSection(vm));
    if (vm.plan) parts.push(planSection(vm.plan));
    return parts.join('');
  }

  /** Checklist: mỗi khía cạnh một dòng, nút sửa nằm ngay trên dòng của vấn đề. */
  function checksSection(b) {
    const rows = b.rows.map((r) => {
      const fix = r.fix
        ? `<button data-action="${esc(r.fix.action)}"${r.fix.source ? ` data-source="${esc(r.fix.source)}"` : ''}>${esc(r.fix.label)}${r.fix.key ? `<kbd>${esc(r.fix.key)}</kbd>` : ''}</button>`
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

  /** Dải track: một ô mỗi keyframe (vàng: lệch), ô đang đứng có viền; bấm ô để tới frame. */
  function trackSection(vm) {
    const t = vm.track;
    if (!t || t.loading) return '<div class="muted">Track · đang đọc keyframe…</div>';
    const here = t.cells.reduce((best, c, i) => (c.frame <= vm.frame ? i : best), -1);
    const cells = t.cells.map((c, i) => `<button class="${c.level}${i === here ? ' here' : ''}" data-action="goto-frame" data-frame="${c.frame}" `
      + `title="Frame ${c.frame}${c.reasons.length ? `: ${esc(c.reasons.join(', '))}` : ''}" aria-label="Frame ${c.frame}"></button>`).join('');
    const summary = `<div class="row"><span>Track · ${t.cells.length} keyframe${t.flagged ? ` · <span class="warn">${t.flagged} cần xem</span>` : ' · ổn'}</span>`
      + `<button class="${t.done ? 'on' : ''}" data-action="toggle-done" aria-pressed="${t.done}" title="Đánh dấu track đã làm xong (Alt+Shift+D)">${t.done ? '✓ Xong' : 'Xong?'}</button></div>`;
    const strip = `<div class="strip" style="grid-template-columns: repeat(${t.cells.length}, minmax(0, 1fr))${t.cells.length > 120 ? '; gap: 0' : ''}">${cells}</div>`;
    const toggle = `<button class="link" data-action="toggle-track" aria-expanded="${vm.trackOpen}">${vm.trackOpen ? '▾' : '▸'} Sửa cả track</button>`;
    if (!vm.trackOpen) return summary + strip + toggle;
    const off = (reason) => `disabled title="${reason}"`;
    const rigidOnly = (title) => (t.locked ? off('Box đang khóa') : t.rigid ? `title="${title}"` : off('Người / động vật đổi tư thế: không áp dụng'));
    return summary + strip + toggle
      + `<div class="grid2"><button data-action="plan-sync-size" data-source="current" ${rigidOnly('Cả track lấy kích thước box ở frame này')}>Cỡ = frame này</button>`
      + `<button data-action="plan-sync-size" data-source="median" ${rigidOnly('Cả track lấy trung vị kích thước các keyframe')}>Cỡ trung vị</button>`
      + `<button data-action="plan-smooth-yaw" ${rigidOnly('Sửa lật đầu, làm mượt hướng')}>Mượt yaw</button>`
      + `<button data-action="plan-thin" ${t.locked ? off('Box đang khóa') : 'title="Bỏ keyframe mà CVAT tự nội suy lại được"'}>Tỉa keyframe</button></div>`;
  }

  function planSection(plan) {
    const ghost = plan.edits?.some((e) => e.box) ? '<div class="ghost">Nét đứt xanh trên canvas: box sau khi sửa ở frame này.</div>' : '';
    return `<div class="plan" role="region" aria-label="Xem trước thay đổi"><b>${esc(plan.title)}</b>${plan.lines.map((l) => `<div>${esc(l)}</div>`).join('')}${ghost}`
      + `<div class="row"><button class="primary" data-action="apply-plan" ${plan.canApply ? '' : 'disabled'}>Áp dụng (chưa Save)</button><button data-action="cancel-plan">Hủy</button></div></div>`;
  }

  root.PointSnapAnnotatorPanel = { create };
})(globalThis);

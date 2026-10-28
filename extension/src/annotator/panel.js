/*
 * Bảng PointSnap cho annotator (shadow DOM, không lẫn CSS với CVAT). Chỉ hiển thị view-model do controller đưa vào
 * và báo lại thao tác qua `onAction(name, data)`; không tự đọc CVAT.
 * Bố cục: thanh tiêu đề (chấm trạng thái + box đang chọn, luôn hiện kể cả khi thu gọn) → checklist từng khía cạnh,
 * mỗi dòng có nút sửa đúng vấn đề của nó → dải track một ô mỗi keyframe, bấm ô để tới frame → bản xem trước.
 * Nền sáng như thanh bên của CVAT; màu một nghĩa: xanh lá ổn, cam cần xem, đỏ lỗi.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'pointsnap.annotator.panel';
  const SHORTCUTS = 'Alt+Shift+G: hạ đáy box · Alt+Shift+F: khoá box · Alt+Shift+D: đánh dấu track xong. Save / Undo bằng CVAT.';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ICON = { ok: '✓', warning: '!', error: '✕', na: '–', muted: '–' };
  const LEVEL_TEXT = { ok: 'Ổn', warning: 'Cần xem', error: 'Lỗi', na: 'Chưa đo được', muted: 'Đã bỏ qua' };

  // Logo PointSnap (qc/public/logo.svg), nét theo màu chữ.
  const LOGO = '<svg class="logo" viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path opacity=".4" d="M3.5 44.3H18.7M37.3 44.3H52.5"/><path d="M28 44.3 11.7 35V16.3L28 7l16.3 9.3V35L28 44.3Zm16.3-28L28 25.7m0 0L11.7 16.3M28 25.7v18.6"/><circle cx="28" cy="44.3" r="5.25" fill="#1677ff" stroke="none"/></svg>';

  /* Theo kiểu Ant Design của CVAT: nền trắng như thanh bên của CVAT, viền #d9d9d9, xanh #1677ff. */
  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; z-index: 2147483000; width: 300px; display: flex; flex-direction: column;
      background: #fff; color: rgba(0,0,0,.88); border: 1px solid #d9d9d9; border-radius: 8px;
      box-shadow: 0 6px 16px rgba(0,0,0,.08), 0 3px 6px -4px rgba(0,0,0,.12), 0 9px 28px 8px rgba(0,0,0,.05);
      font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; overflow: hidden; overflow-wrap: anywhere; }
    .head { display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 10px; background: #fafafa; border-bottom: 1px solid #f0f0f0; cursor: move; user-select: none; }
    .collapsed .head { border-bottom: 0; }
    .logo { flex: none; width: 20px; height: 20px; color: #1f1f1f; }
    .head .title { font-weight: 600; margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head .title small { font-weight: 400; color: rgba(0,0,0,.45); }
    .head > .muted, .head .count { flex: none; white-space: nowrap; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #d9d9d9; }
    .dot.ok { background: #52c41a; } .dot.warning { background: #faad14; } .dot.error { background: #ff4d4f; }
    .count { font-weight: 600; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 9px; background: #fff7e6; color: #d46b08; border: 1px solid #ffd591; }
    .count.error { background: #fff1f0; color: #cf1322; border-color: #ffa39e; }
    .muted { color: rgba(0,0,0,.45); }
    .body { overflow-y: auto; overflow-x: hidden; padding: 8px 10px 10px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
    .collapsed .body { display: none; }
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
    kbd { font: 10px ui-monospace, Consolas, monospace; color: rgba(0,0,0,.45); background: #fafafa; border: 1px solid #d9d9d9; border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; margin-left: 4px; }
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
    .strip { display: grid; gap: 1px; height: 16px; }
    .strip button { padding: 0; border: 0; border-radius: 2px; background: #d9d9d9; min-width: 0; box-shadow: none; }
    .strip button:hover:not(:disabled) { background: #91caff; }
    .strip button.warning { background: #faad14; } .strip button.here { outline: 2px solid #1677ff; outline-offset: -1px; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; }
    .plan, .spec { background: #fafafa; border: 1px solid #f0f0f0; border-radius: 8px; padding: 8px 9px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .plan { background: #f0f7ff; border-color: #bae0ff; }
    .plan .ghost { color: #1677ff; }
    .spec ul { margin: 0; padding-left: 16px; color: rgba(0,0,0,.65); }
    .warn { color: #d46b08; } .bad { color: #cf1322; }
    .link { border: 0; background: none; box-shadow: none; padding: 0; color: #1677ff; }
    .link:hover:not(:disabled) { background: none; color: #4096ff; }
    /* Gắn vào tab PointSnap trong thanh bên của CVAT (plugin trong CVAT): nằm trong luồng, không nổi, không kéo / thu gọn. */
    :host([docked]) .panel { position: static; width: auto; max-height: none !important; border: 0; border-radius: 0; box-shadow: none; }
    :host([docked]) .head { cursor: default; } :host([docked]) .logo, :host([docked]) [data-action="collapse"] { display: none; }
    :host([docked]) .collapsed .body { display: grid; }
  `;

  function create(onAction) {
    const host = document.createElement('div');
    host.id = 'pointsnap-annotator';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><div class="panel" role="complementary" aria-label="PointSnap annotator"></div>`;
    const panel = shadow.querySelector('.panel');
    // Plugin trong CVAT có tab PointSnap ở thanh bên (`.ps-pane`): gắn vào đó; không có (extension) thì nổi trên trang.
    const dock = document.querySelector('.ps-pane');
    if (dock) host.setAttribute('docked', '');
    // Có plugin nhưng thanh bên chưa dựng xong (CVAT đang tải job): ẩn tới khi plugin gắn bảng vào tab, không nổi giữa trang.
    // (style, không dùng `hidden`: `:host { all: initial }` của shadow đè thuộc tính hidden.)
    else if (document.documentElement.dataset.pointsnapPlugin) host.style.display = 'none';
    if (dock) dock.prepend(host); else document.documentElement.appendChild(host);

    const saved = readPosition();
    let collapsed = !!saved.collapsed, lastHtml = '';
    place(saved.left, saved.top);

    function place(left, top) {
      // Mặc định: sát bên trái danh sách object của CVAT, không che danh sách.
      const sidebarLeft = document.querySelector('.cvat-objects-sidebar')?.getBoundingClientRect().left || window.innerWidth;
      const x = Number.isFinite(left) ? left : sidebarLeft - 312, y = Number.isFinite(top) ? top : 90;
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
      if (host.hasAttribute('docked') || !event.target.closest('.head') || event.target.closest('button') || event.button !== 0) return;
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
    return `<div class="head" title="${esc(SHORTCUTS)}">${LOGO}${status}<span class="title">${title}</span>${count}${progress}${tools}`
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

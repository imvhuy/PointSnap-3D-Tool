/*
 * Bảng PointSnap cho annotator (shadow DOM, không lẫn CSS với CVAT). Chỉ hiển thị view-model do controller đưa vào
 * và báo lại thao tác qua `onAction(name, data)`; không tự đọc CVAT.
 * Gọn theo mặc định: thanh tiêu đề luôn cho biết ΔZ và số lỗi (kể cả khi thu gọn); chi tiết track, spec, thông tin
 * phụ chỉ mở khi cần.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'pointsnap.annotator.panel';
  const SHORTCUTS = 'Alt+Shift+F: camera theo track · Alt+Shift+G: hạ đáy box · Alt+Shift+D: đánh dấu track xong. Save / Undo bằng CVAT.';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; z-index: 2147483000; width: 264px; display: flex; flex-direction: column;
      background: rgba(255,255,255,.97); color: #111827; border: 1px solid #d1d5db; border-radius: 7px; box-shadow: 0 4px 14px rgba(0,0,0,.16);
      font: 11.5px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; overflow-wrap: anywhere; }
    .head { display: flex; align-items: center; gap: 4px; padding: 4px 6px; background: #0f2a47; color: #fff; cursor: move; user-select: none; }
    .head b { font-size: 12px; margin-right: auto; }
    .body { overflow-y: auto; overflow-x: hidden; padding: 6px 8px 8px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .collapsed .body { display: none; }
    .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 6px; }
    .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11px; }
    .muted { color: #6b7280; }
    .chip { border-radius: 9px; padding: 0 6px; font-weight: 700; font-size: 10.5px; white-space: nowrap; }
    .chip.ok { background: #dcfce7; color: #15803d; } .chip.float { background: #ffedd5; color: #c2410c; }
    .chip.sink, .chip.error { background: #fee2e2; color: #b91c1c; } .chip.warning { background: #fef3c7; color: #b45309; }
    .chip.none { background: #e5e7eb; color: #4b5563; }
    .issue { display: flex; gap: 5px; align-items: baseline; }
    .issue i { flex: none; width: 7px; height: 7px; border-radius: 50%; transform: translateY(-1px); }
    .issue.error i { background: #dc2626; } .issue.warning i { background: #d97706; }
    .issue span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { font: inherit; font-weight: 600; border: 1px solid #cbd5e1; background: #f8fafc; color: #0f172a; border-radius: 4px; padding: 1px 6px; cursor: pointer; }
    button:hover:not(:disabled) { background: #eef2ff; border-color: #6366f1; }
    button:disabled { opacity: .45; cursor: default; }
    button.primary { background: #0b63ce; border-color: #0b63ce; color: #fff; }
    button.on { background: #dbeafe; border-color: #2563eb; color: #1d4ed8; }
    .head button { background: transparent; border-color: transparent; color: #fff; padding: 0 4px; font-size: 12px; }
    .head button.on { background: rgba(255,255,255,.2); }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px; }
    .box { border-top: 1px solid #e5e7eb; padding-top: 5px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .plan, .spec { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; padding: 5px 6px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; }
    .notice { padding: 3px 6px; border-radius: 4px; background: #eff6ff; color: #1e3a8a; }
    .notice.error { background: #fef2f2; color: #991b1b; } .notice.ok { background: #ecfdf5; color: #166534; }
    .series { display: grid; grid-template-columns: 34px minmax(0, 1fr) 40px; align-items: center; gap: 4px; }
    svg.spark { width: 100%; height: 16px; display: block; }
    svg.spark circle { cursor: pointer; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 2px; }
    .dot.in { background: #22c55e; } .dot.out { background: #ef4444; }
    .bad { color: #b91c1c; font-weight: 700; } .warn { color: #c2410c; font-weight: 700; }
    .spec ul { margin: 0; padding-left: 14px; color: #374151; }
    .link { border: 0; background: none; padding: 0; color: #2563eb; font-weight: 600; }
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
    place(saved.left ?? window.innerWidth - 284, saved.top ?? 90);

    function place(left, top) {
      const x = Number.isFinite(left) ? left : window.innerWidth - 284, y = Number.isFinite(top) ? top : 90;
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

  const count = (issues, severity) => issues.filter((i) => i.severity === severity).length;

  function gapChip(contact) {
    if (!contact) return '<span class="chip none" title="Chưa đo được mặt đất quanh box">ΔZ —</span>';
    return `<span class="chip ${esc(contact.kind)}" title="${esc(contact.text)}">ΔZ ${contact.gapCm > 0 ? '+' : ''}${contact.gapCm} cm</span>`;
  }

  /** Thanh tiêu đề: luôn hiện ΔZ và số Lỗi / Cảnh báo của box đang chọn, kể cả khi thu gọn. */
  function head(vm, collapsed) {
    const b = vm.box, chips = [];
    if (b) {
      chips.push(gapChip(b.contact));
      const errors = count(b.issues, 'error'), warnings = count(b.issues, 'warning');
      if (errors) chips.push(`<span class="chip error" title="Lỗi">${errors}</span>`);
      if (warnings) chips.push(`<span class="chip warning" title="Cảnh báo">${warnings}</span>`);
    }
    const progress = vm.progress ? `<span class="mono" title="Track đã xong / track trong frame">${vm.progress.done}/${vm.progress.total}</span>` : '';
    const tools = vm.status === 'ready'
      ? `<button class="${vm.follow ? 'on' : ''}" data-action="toggle-follow" aria-pressed="${vm.follow}" aria-label="Camera theo track" title="Camera theo track: đổi frame vẫn chọn đúng track (Alt+Shift+F)">◎</button>`
        + '<button data-action="next-undone" aria-label="Track chưa xong kế tiếp" title="Chọn track chưa xong kế tiếp trong frame">⏭</button>'
      : '';
    return `<div class="head" title="${esc(SHORTCUTS)}"><b>PointSnap</b>${chips.join('')}${progress}${tools}`
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
      parts.push(`<div class="notice error" title="${esc(errors.join('\n'))}">Guideline ghi đè lỗi, dùng mặc định: ${esc(errors[0])}${more}</div>`);
    }
    if (vm.status !== 'ready') return [...parts, `<div class="muted">${esc(vm.message || 'Chờ mở job 3D…')}</div>`].join('');
    if (!vm.box) return [...parts, '<div class="muted">Chọn một cuboid để xem số đo và kiểm tra.</div>'].join('');
    parts.push(boxSection(vm.box, vm.specOpen));
    if (vm.box.locked) parts.push('<div class="notice">🔒 Box đang khóa trong CVAT: chỉ xem, không sửa.</div>');
    if (vm.spec) parts.push(specSection(vm.spec));
    if (vm.box.isTrack) parts.push(trackSection(vm, vm.box.locked));
    if (vm.plan) parts.push(planSection(vm.plan));
    return parts.join('');
  }

  function boxSection(b, specOpen) {
    const kind = b.classKey !== b.label ? ` · ${esc(b.classKey)}` : '';
    const faces = b.points.faces.map((f) => `<span class="${f.gapM < -0.05 ? 'bad' : f.gapM > 0.3 ? 'warn' : ''}">${esc(f.name)} ${f.gapM >= 0 ? '+' : '−'}${Math.abs(Math.round(f.gapM * 100))}</span>`).join(' ');
    const shown = b.issues.filter((i) => i.severity !== 'info'), info = b.issues.filter((i) => i.severity === 'info');
    const issues = shown.map((i) => `<div class="issue ${esc(i.severity)}" title="${esc(i.message)}"><i></i><span><b>${esc(i.title)}</b> · ${esc(i.message)}</span></div>`).join('');
    const infoLine = info.length ? `<div class="muted" title="${esc(info.map((i) => `${i.title}: ${i.message}`).join('\n'))}">ⓘ ${info.map((i) => esc(i.title)).join(' · ')}</div>` : '';
    return '<div class="box">'
      + `<div class="row"><b>${esc(b.label)}${kind} #${esc(b.clientId)}</b><span>`
      + `<button class="${specOpen ? 'on' : ''}" data-action="toggle-spec" aria-pressed="${specOpen}" title="Khoảng kích thước, thuộc tính bắt buộc, quy tắc spec">Spec</button> `
      + `<button data-action="snap-ground" ${b.contact && !b.locked ? '' : 'disabled'} title="Đặt đáy box lên mặt đất đo được ở frame này (Alt+Shift+G)">⤓ Hạ đáy</button></span></div>`
      + `<div class="row mono"><span>${b.dims.map((d) => d.toFixed(2)).join('×')} m · ${b.yawDeg.toFixed(0)}°</span><span class="muted">${b.rangeM.toFixed(0)} m</span></div>`
      + `<div class="row mono"><span title="Điểm của vật trong box / lòi ra ngoài box"><span class="dot in"></span>${b.points.inside} <span class="dot out"></span>${b.points.outside}</span>`
      + `<span title="Khoảng hở (cm) ở các mặt LiDAR nhìn thấy rõ: + box dư, − vật lòi ra">${faces || '<span class="muted">mặt: chưa đo</span>'}</span></div>`
      + (issues || (info.length ? '' : '<div class="muted">✓ Không thấy vấn đề ở frame này</div>')) + infoLine
      + '</div>';
  }

  function specSection(spec) {
    const dims = spec.dims
      ? spec.dims.map((d) => {
        const ok = d.value >= d.lo && d.value <= d.hi;
        return `<div class="row mono"><span>${esc(d.name)} ${d.lo.toFixed(2)}–${d.hi.toFixed(2)}</span><span class="${ok ? '' : 'warn'}">${d.value.toFixed(2)} ${ok ? '✓' : '✗'}</span></div>`;
      }).join('')
      : '<div class="muted">Chưa có khoảng kích thước cho class này.</div>';
    const required = spec.required.length
      ? spec.required.map((a) => `<div class="row"><span>${esc(a.name)}</span><span class="${a.value ? '' : 'bad'}">${a.value ? esc(a.value) : 'chưa chọn'}</span></div>`).join('')
      : '';
    const overlap = spec.overlapWith.length ? `<div><b>Được chồng với:</b> ${esc(spec.overlapWith.join(', '))}</div>` : '';
    return `<div class="spec"><b>Spec · ${esc(spec.key)}</b>${dims}${required}${overlap}<ul>${spec.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  }

  function sparkline(points, frame) {
    if (!points.length) return '<svg class="spark"></svg>';
    const values = points.map((p) => p.value), min = Math.min(...values), max = Math.max(...values);
    const f0 = points[0].frame, f1 = points[points.length - 1].frame || f0 + 1;
    const x = (f) => (f1 === f0 ? 50 : ((f - f0) / (f1 - f0)) * 96 + 2), y = (v) => (max === min ? 8 : 14 - ((v - min) / (max - min)) * 12);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.frame).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const marks = points.filter((p) => p.outlier).map((p) => `<circle cx="${x(p.frame).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.4" fill="#dc2626" data-action="goto-frame" data-frame="${p.frame}"><title>Frame ${p.frame}: ${p.value.toFixed(2)} (bấm để tới frame)</title></circle>`).join('');
    const cursor = frame >= f0 && frame <= f1 ? `<line x1="${x(frame)}" x2="${x(frame)}" y1="0" y2="16" stroke="#94a3b8" stroke-width=".6"/>` : '';
    return `<svg class="spark" viewBox="0 0 100 16" preserveAspectRatio="none">${cursor}<path d="${path}" stroke="#2563eb" stroke-width="1" fill="none" vector-effect="non-scaling-stroke"/>${marks}</svg>`;
  }

  /** Track: một dòng tóm tắt; mở ra mới có dải theo keyframe và các thao tác sửa cả track. */
  function trackSection(vm, locked) {
    const t = vm.track;
    if (!t || t.loading) return '<div class="row muted"><span>Track · đang đọc keyframe…</span></div>';
    const outliers = t.series.reduce((s, x) => s + x.points.filter((p) => p.outlier).length, 0);
    const summary = `<div class="row"><button class="link" data-action="toggle-track" aria-expanded="${vm.trackOpen}">${vm.trackOpen ? '▾' : '▸'} Track · ${t.keyframeCount} kf`
      + `${outliers ? ` · <span class="bad">${outliers} lệch</span>` : ' · ổn'}</button>`
      + `<button class="${t.done ? 'on' : ''}" data-action="toggle-done" aria-pressed="${t.done}" title="Đánh dấu track đã làm xong (Alt+Shift+D)">${t.done ? '✓ Xong' : 'Xong?'}</button></div>`;
    if (!vm.trackOpen) return summary;
    const rows = t.series.map((s) => {
      const n = s.points.filter((p) => p.outlier).length;
      return `<div class="series"><span class="muted">${esc(s.name)}</span>${sparkline(s.points, vm.frame)}<span class="mono ${n ? 'bad' : 'muted'}">${n ? `${n} lệch` : 'ổn'}</span></div>`;
    }).join('');
    // Người / động vật đổi tư thế: tắt các thao tác chỉ đúng với vật cứng.
    const rigidOnly = (title) => (locked ? 'disabled title="Box đang khóa"'
      : t.rigid ? `title="${title}"` : 'disabled title="Người / động vật đổi tư thế: không áp dụng"');
    return summary + rows
      + `<div class="grid2"><button data-action="plan-sync-size" data-source="current" ${rigidOnly('Cả track lấy kích thước box ở frame này')}>Cỡ = frame này</button>`
      + `<button data-action="plan-sync-size" data-source="median" ${rigidOnly('Cả track lấy trung vị kích thước các keyframe')}>Cỡ = trung vị</button>`
      + `<button data-action="plan-smooth-yaw" ${rigidOnly('Sửa lật đầu, làm mượt hướng')}>Mượt yaw</button>`
      + `<button data-action="plan-thin" ${locked ? 'disabled title="Box đang khóa"' : 'title="Bỏ keyframe mà CVAT tự nội suy lại được"'}>Tỉa keyframe</button></div>`;
  }

  function planSection(plan) {
    return `<div class="plan" role="region" aria-label="Xem trước thay đổi"><b>${esc(plan.title)}</b>${plan.lines.map((l) => `<div>${esc(l)}</div>`).join('')}`
      + `<div class="row"><button class="primary" data-action="apply-plan" ${plan.canApply ? '' : 'disabled'}>Áp dụng (chưa Save)</button><button data-action="cancel-plan">Hủy</button></div></div>`;
  }

  root.PointSnapAnnotatorPanel = { create };
})(globalThis);

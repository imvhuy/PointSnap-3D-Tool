'use strict';
/*
 * Plugin PointSnap trong trang CVAT (không cần extension). nginx của CVAT chèn script này vào mọi trang CVAT và chuyển
 * /pointsnap-qc/ về dịch vụ QC, nên script gọi dịch vụ cùng địa chỉ với CVAT; dịch vụ nhận người dùng từ phiên CVAT.
 * Dùng API plugin chính thức của CVAT (window.cvatUI.registerComponent): store của CVAT (job, frame, object) và
 * changeFrameAsync / ACTIVATE_OBJECT để chuyển frame và chọn box mà không tải lại trang.
 * - QC (vai trò theo dịch vụ QC): quét, xem lần lượt mọi object (lỗi tool báo lên đầu), OK / Trả lỗi / Báo nhầm, gửi lỗi
 *   cho annotator, nghiệm thu phiếu, hoàn thành job. QC vẫn duyệt đủ 100% object.
 * - Annotator: phiếu sửa lỗi của job đang mở, nhảy tới box, nộp lại.
 * Nội dung từ dịch vụ chỉ gán bằng textContent.
 */
(function () {
  const BASE = '/pointsnap-qc';
  const TAGS = ['Lơ lửng / lún', 'Kích thước', 'Hướng (yaw)', 'Lệch vị trí', 'Sai class', 'Thiếu thuộc tính', 'Đứt / đổi ID', 'Thiếu box ở frame'];
  const P = { ctx: null, me: null, jobId: null, data: null, tickets: [], cur: null, busy: false, open: true, el: null };

  async function api(path, opts = {}) {
    const res = await fetch(BASE + path, { ...opts, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-PointSnap-QC': '1', ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
    return body;
  }
  const state = () => P.ctx.store.getState().annotation;
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'on') Object.entries(v).forEach(([ev, fn]) => e.addEventListener(ev, fn)); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
    kids.flat().filter(Boolean).forEach((c) => e.append(c));
    return e;
  };

  // ------------------------------------------------------------------ đi tới object trong CVAT (không tải lại trang)

  async function goTo(serverId, frame) {
    const { dispatch, actionCreators } = P.ctx;
    if (state().player.frame.number !== frame) dispatch(actionCreators.changeFrameAsync(frame));
    for (let i = 0; i < 40; i += 1) {
      const a = state();
      const s = a.player.frame.number === frame && a.annotations.states.find((x) => x.serverID === serverId);
      if (s) { dispatch({ type: 'ACTIVATE_OBJECT', payload: { activatedStateID: s.clientID, activatedElementID: null, activatedAttributeID: null } }); return true; }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  // ------------------------------------------------------------------ QC

  const reviewed = (o) => { const r = P.data.objectReviews?.[o.key]; return !!r && (r.fingerprint === o.fingerprint || (r.ticket && r.status === 'returned')); };
  function queue() {
    const objs = P.data.result.objects, blind = (o) => o.noPoints > 0 || o.noGround >= o.boxes / 2;
    const rank = (o) => (o.errors ? 0 : o.warnings ? 1 : blind(o) ? 2 : 3);
    return objs.filter((o) => !reviewed(o)).sort((a, b) => rank(a) - rank(b) || a.first - b.first || (a.cvatId ?? 0) - (b.cvatId ?? 0));
  }
  const toolFor = (o) => P.data.result.findings.filter((f) => f.severity !== 'info' && (f.objKey === o.key || f.other === o.key));
  const focusFrame = (o) => toolFor(o)[0]?.frames[0] ?? o.first;

  async function loadQc() {
    [P.data, P.tickets] = await Promise.all([api(`/api/jobs/${P.jobId}`), api(`/api/tickets?job=${P.jobId}`)]);
    if (P.data.result?.objects && (!P.cur || !queue().some((o) => o.key === P.cur))) P.cur = queue()[0]?.key || null;
  }

  async function qcAct(kind, extra) {
    const o = P.data.result.objects.find((x) => x.key === P.cur);
    if (!o) return;
    if (kind === 'ok' || kind === 'false') await api(`/api/jobs/${P.jobId}/objects`, { method: 'POST', body: JSON.stringify({ keys: [o.key], status: 'ok' }) });
    if (kind === 'false') for (const f of toolFor(o)) await api(`/api/jobs/${P.jobId}/reviews`, { method: 'POST', body: JSON.stringify({ key: f.key, verdict: 'false_alarm' }) });
    if (kind === 'return') await api(`/api/jobs/${P.jobId}/objects`, { method: 'POST', body: JSON.stringify({ keys: [o.key], status: 'returned', issue: extra }) });
    P.cur = null;
    await loadQc();
    const next = P.data.result.objects.find((x) => x.key === P.cur);
    render();
    if (next) goTo(next.serverId, focusFrame(next));
  }

  function qcView(box) {
    const r = P.data?.result;
    if (P.data?.run && ['queued', 'running'].includes(P.data.run.state)) { box.append(h('div', { class: 'ps-muted', text: `Đang quét… ${P.data.run.progress?.done || 0}/${P.data.run.progress?.total || '?'} frame` })); setTimeout(refresh, 1500); return; }
    if (!r?.objects) { box.append(h('button', { class: 'ps-btn ps-pri', text: 'Quét job này', on: { click: () => run(async () => { await api(`/api/jobs/${P.jobId}/scan`, { method: 'POST' }); }) } })); return; }
    const objs = r.objects, done = objs.filter(reviewed).length, drafts = objs.filter((o) => { const v = P.data.objectReviews?.[o.key]; return v?.status === 'returned' && !v.ticket; });
    const waiting = P.tickets.filter((t) => t.status === 'submitted');
    box.append(h('div', { class: 'ps-row' }, h('b', { text: `${done}/${objs.length} object đã duyệt` }), h('span', { class: 'ps-muted', text: ` · quét ${new Date(r.startedAt).toLocaleTimeString('vi-VN')}` }),
      h('button', { class: 'ps-btn ps-sm', text: 'Quét lại', on: { click: () => run(() => api(`/api/jobs/${P.jobId}/scan`, { method: 'POST' })) } })));
    const o = objs.find((x) => x.key === P.cur);
    if (o) {
      const card = h('div', { class: 'ps-card' }, h('div', { class: 'ps-row' }, h('b', { text: `${o.label} #${o.cvatId ?? o.serverId}` }), h('span', { class: 'ps-muted', text: ` frame ${o.first}–${o.last} · còn ${queue().length} chưa xem` })));
      const tool = toolFor(o);
      card.append(tool.length ? h('ul', { class: 'ps-list' }, tool.map((f) => h('li', { class: f.severity === 'error' ? 'ps-err' : 'ps-warn', text: `${f.title}: ${f.short} (frame ${f.frames[0]}${f.frames.length > 1 ? `–${f.frames.at(-1)}` : ''})` })))
        : h('div', { class: 'ps-muted', text: 'Tool không báo gì: QC tự xem.' }));
      card.append(h('div', { class: 'ps-row' },
        h('button', { class: 'ps-btn ps-ok', text: 'OK (Alt+1)', on: { click: () => run(() => qcAct('ok')) } }),
        h('button', { class: 'ps-btn ps-bad', text: 'Trả lỗi (Alt+2)', on: { click: () => returnForm(card, o) } }),
        h('button', { class: 'ps-btn', text: 'Báo nhầm (Alt+3)', on: { click: () => run(() => qcAct('false')) } }),
        h('button', { class: 'ps-btn', text: 'Xem lại box', on: { click: () => goTo(o.serverId, focusFrame(o)) } }),
        h('button', { class: 'ps-btn', text: 'Bỏ qua (Alt+J)', on: { click: () => skip() } })));
      box.append(card);
    } else box.append(h('div', { class: 'ps-ok-text', text: 'Đã duyệt hết object.' }));
    const assignee = state().job.instance?.assignee?.username;
    if (drafts.length) box.append(h('button', { class: 'ps-btn ps-pri', text: `Gửi ${drafts.length} lỗi cho ${assignee || 'annotator'}`, on: { click: () => run(async () => {
      if (!assignee) throw new Error('Job chưa giao annotator trên CVAT');
      await api('/api/tickets/batch', { method: 'POST', body: JSON.stringify({ jobId: P.jobId, assignee, keys: drafts.map((d) => d.key) }) });
    }) } }));
    for (const t of waiting) {
      box.append(h('div', { class: 'ps-card' }, h('div', { class: 'ps-row' }, h('b', { text: `${t.id} · ${t.label} #${t.cvatId ?? t.serverId}` }), h('span', { class: 'ps-muted', text: ' đã nộp lại' })),
        t.unchanged ? h('div', { class: 'ps-warn', text: 'Object trên CVAT chưa đổi so với lúc trả lỗi.' }) : null,
        h('div', { class: 'ps-row' }, h('button', { class: 'ps-btn', text: 'Xem', on: { click: () => goTo(t.serverId, t.frames[0]) } }),
          h('button', { class: 'ps-btn ps-ok', text: 'Nghiệm thu', on: { click: () => run(() => api(`/api/tickets/${t.id}/accept`, { method: 'POST', body: '{}' })) } }),
          h('button', { class: 'ps-btn ps-bad', text: 'Trả lại', on: { click: () => { const text = prompt('Lý do trả lại'); if (text) run(() => api(`/api/tickets/${t.id}/return`, { method: 'POST', body: JSON.stringify({ text }) })); } } }))));
    }
    box.append(h('button', { class: 'ps-btn', text: 'Hoàn thành duyệt job', on: { click: () => run(() => api(`/api/jobs/${P.jobId}/complete`, { method: 'POST', body: '{}' }).then(() => alert('Đã hoàn thành duyệt job'))) } }));
  }

  function skip() {
    const q = queue(), i = q.findIndex((x) => x.key === P.cur), next = q[i + 1] || q[0];
    if (!next) return;
    P.cur = next.key; render(); goTo(next.serverId, focusFrame(next));
  }

  function returnForm(card, o) {
    card.querySelector('.ps-form')?.remove();
    const picked = new Set(toolFor(o).slice(0, 1).map((f) => f.title));
    const tags = [...new Set([...toolFor(o).map((f) => f.title), ...TAGS])];
    const note = h('textarea', { rows: '2', placeholder: 'Ghi chú cho annotator', class: 'ps-in' });
    const frame = state().player.frame.number;
    const form = h('div', { class: 'ps-form' },
      h('div', { class: 'ps-row ps-wrap' }, tags.map((t) => { const b = h('button', { class: `ps-tag${picked.has(t) ? ' on' : ''}`, text: t }); b.addEventListener('click', () => { if (picked.has(t)) picked.delete(t); else picked.add(t); b.classList.toggle('on'); }); return b; })),
      h('div', { class: 'ps-muted', text: `Frame thấy lỗi: ${frame} (frame đang mở trong CVAT)` }), note,
      h('div', { class: 'ps-row' }, h('button', { class: 'ps-btn ps-bad', text: 'Trả lỗi', on: { click: () => {
        if (!picked.size && !note.value.trim()) { note.placeholder = 'Chọn ít nhất một lỗi hoặc ghi chú'; return; }
        run(() => qcAct('return', { tags: [...picked], frame, text: note.value.trim(), finding: toolFor(o)[0]?.key || null }));
      } } }), h('button', { class: 'ps-btn', text: 'Huỷ', on: { click: () => form.remove() } })));
    card.append(form);
    note.focus();
  }

  // ------------------------------------------------------------------ annotator

  async function loadAnn() { P.tickets = (await api('/api/tickets')).filter((t) => t.jobId === P.jobId); }

  function annView(box) {
    const todo = P.tickets.filter((t) => t.status === 'open' || t.status === 'returned');
    box.append(h('b', { text: todo.length ? `${todo.length} lỗi QC trả về cần sửa` : 'Không có lỗi nào cần sửa ở job này.' }));
    for (const t of todo) {
      const qcNote = [...t.thread].reverse().find((m) => m.role === 'qc' && m.text)?.text || t.message || '';
      const reply = h('textarea', { rows: '1', placeholder: 'Đã sửa gì (tuỳ chọn)', class: 'ps-in' });
      box.append(h('div', { class: 'ps-card' },
        h('div', { class: 'ps-row' }, h('b', { text: `${t.id} · ${t.label} #${t.cvatId ?? t.serverId}` }), h('span', { class: t.status === 'returned' ? 'ps-err' : 'ps-muted', text: t.status === 'returned' ? ' QC trả lại' : ` frame ${t.frames[0]}` })),
        h('div', { class: 'ps-err', text: t.title }), h('div', { text: qcNote }), reply,
        h('div', { class: 'ps-row' }, h('button', { class: 'ps-btn', text: 'Tới box', on: { click: () => goTo(t.serverId, t.frames[0]) } }),
          h('button', { class: 'ps-btn ps-pri', text: 'Nộp', on: { click: () => run(async () => {
            const job = state().job.instance;
            if (job?.annotations?.hasUnsavedChanges && await job.annotations.hasUnsavedChanges()) throw new Error('Còn thay đổi chưa Lưu: bấm Save (Ctrl+S) của CVAT trước');
            const r = await api(`/api/tickets/${t.id}/submit`, { method: 'POST', body: JSON.stringify({ text: reply.value }) });
            if (r.unchanged) alert('Đã nộp, nhưng object trên CVAT chưa đổi so với lúc QC trả lỗi.');
          }) } }))));
    }
  }

  // ------------------------------------------------------------------ khung, vòng đời

  async function run(fn) {
    if (P.busy) return;
    P.busy = true; msg('');
    try { await fn(); await refresh(); } catch (e) { msg(e.message); } finally { P.busy = false; }
  }
  function msg(text) { const m = P.el?.querySelector('.ps-msg'); if (m) m.textContent = text; }

  async function refresh() {
    if (!P.jobId || !P.me) return;
    try { if (P.me.role === 'qc') await loadQc(); else await loadAnn(); } catch (e) { msg(e.message); }
    render();
  }

  function render() {
    if (!P.el) {
      P.el = h('div', { id: 'pointsnap-plugin' });
      document.body.append(P.el);
      document.head.append(h('link', { rel: 'stylesheet', href: `${BASE}/plugin.css` }));
    }
    P.el.hidden = !P.jobId || !P.me;
    P.el.replaceChildren();
    const head = h('div', { class: 'ps-head' }, h('b', { text: 'PointSnap' }), h('span', { class: 'ps-muted', text: ` ${P.me?.role === 'qc' ? 'QC' : 'Annotator'} · ${P.me?.name || ''}` }),
      h('button', { class: 'ps-btn ps-sm', text: P.open ? '–' : '+', on: { click: () => { P.open = !P.open; render(); } } }));
    P.el.append(head);
    if (!P.open) return;
    const box = h('div', { class: 'ps-body' });
    if (P.me?.role === 'qc') qcView(box); else annView(box);
    box.append(h('div', { class: 'ps-msg ps-err' }));
    P.el.append(box);
  }

  // Theo dõi job đang mở: CVAT là trang một-trang, đổi job không tải lại.
  function watch() {
    const job = state()?.job?.instance;
    const id = job && /\/jobs\/\d+/.test(location.pathname) ? job.id : null;
    if (id !== P.jobId) { P.jobId = id; P.cur = null; P.data = null; refresh(); }
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || !P.jobId || P.me?.role !== 'qc' || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    const o = P.data?.result?.objects.find((x) => x.key === P.cur);
    const act = { 1: () => run(() => qcAct('ok')), 2: () => o && returnForm(P.el.querySelector('.ps-card'), o), 3: () => run(() => qcAct('false')), j: skip }[e.key.toLowerCase()];
    if (act) { e.preventDefault(); e.stopPropagation(); act(); }
  }, true);

  function register() {
    window.cvatUI.registerComponent((ctx) => {
      P.ctx = ctx;
      api('/api/me').then((me) => { P.me = me; watch(); }).catch(() => { /* chưa đăng nhập CVAT hoặc dịch vụ QC tắt: không hiện gì */ });
      return { name: 'PointSnap QC', destructor: () => P.el?.remove(), globalStateDidUpdate: () => { if (P.me) watch(); } };
    });
  }
  (function wait(n = 0) { if (window.cvatUI) register(); else if (n < 200) setTimeout(() => wait(n + 1), 150); })();
}());

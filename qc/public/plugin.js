'use strict';
/*
 * Plugin PointSnap trong trang CVAT (không cần extension). nginx của CVAT chèn script này vào mọi trang CVAT và chuyển
 * /pointsnap-qc/ về dịch vụ QC, nên script gọi dịch vụ cùng địa chỉ với CVAT; dịch vụ nhận người dùng từ phiên CVAT.
 * Dùng API plugin chính thức của CVAT (window.cvatUI.registerComponent): store của CVAT (job, frame, object) và
 * changeFrameAsync / ACTIVATE_OBJECT để chuyển frame và chọn box mà không tải lại trang.
 * - QC (vai trò theo dịch vụ QC): quét, xem lần lượt mọi object (lỗi tool báo lên đầu), Đạt / Trả lỗi / Báo nhầm, gửi lỗi
 *   cho annotator, nghiệm thu phiếu, hoàn thành job. QC vẫn duyệt đủ 100% object.
 * - Annotator: phiếu sửa lỗi của job đang mở, nhảy tới box, nộp lại.
 * Nội dung từ dịch vụ chỉ gán bằng textContent.
 */
(function () {
  const BASE = '/pointsnap-qc';
  const TAGS = ['Lơ lửng / lún', 'Kích thước', 'Hướng (yaw)', 'Lệch vị trí', 'Sai class', 'Thiếu thuộc tính', 'Đứt / đổi ID', 'Thiếu box ở frame'];
  // Logo PointSnap (public/logo.svg), nét theo màu chữ.
  const LOGO = '<svg viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path opacity=".4" d="M3.5 44.3H18.7M37.3 44.3H52.5"/><path d="M28 44.3 11.7 35V16.3L28 7l16.3 9.3V35L28 44.3Zm16.3-28L28 25.7m0 0L11.7 16.3M28 25.7v18.6"/><circle cx="28" cy="44.3" r="5.25" fill="#1677ff" stroke="none"/></svg>';
  const P = { ctx: null, me: null, jobId: null, data: null, tickets: [], cur: null, busy: false, open: true, el: null, annTab: null, qcTab: null };
  const ANN_TAB_KEY = 'pointsnap.qc.annTab', QC_TAB_KEY = 'pointsnap.qc.qcTab';

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

  /** Tới frame rồi chọn box serverId; phiếu thiếu vật (serverId null) chỉ tới frame. */
  async function goTo(serverId, frame) {
    const { dispatch, actionCreators } = P.ctx;
    // Trang mở từ link lọc một object (serverID) thì bỏ lọc: cần thấy box xung quanh, nhất là lỗi theo cặp (chồng lấn…).
    if (JSON.stringify(state().annotations.filters || []).includes('serverID')) dispatch({ type: 'CHANGE_ANNOTATIONS_FILTERS', payload: { filters: [] } });
    if (state().player.frame.number !== frame) dispatch(actionCreators.changeFrameAsync(frame));
    if (serverId == null) return true;
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
  /** Mục tool báo còn hiệu lực (bỏ mục QC đã ghi Báo nhầm), cùng cách xếp với trang QC. */
  const liveTool = (o) => toolFor(o).filter((f) => P.data.reviews?.[f.key]?.verdict !== 'false_alarm');
  function queue() {
    const objs = P.data.result.objects, blind = (o) => o.noPoints > 0 || o.noGround >= o.boxes / 2;
    const rank = (o) => { const t = liveTool(o); return t.some((f) => f.severity === 'error') ? 0 : t.length ? 1 : blind(o) ? 2 : 3; };
    return objs.filter((o) => !reviewed(o)).sort((a, b) => rank(a) - rank(b) || a.first - b.first || (a.cvatId ?? 0) - (b.cvatId ?? 0));
  }
  const toolFor = (o) => P.data.result.findings.filter((f) => f.severity !== 'info' && (f.objKey === o.key || f.other === o.key));
  const focusFrame = (o) => toolFor(o)[0]?.frames[0] ?? o.first;
  const who = (t) => (t.kind === 'missing' ? `${t.label} · thiếu box` : `${t.label} #${t.cvatId ?? t.serverId}`);

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
    const sentT = P.tickets.filter((t) => t.status !== 'accepted'), accepted = P.tickets.length - sentT.length;
    const assignee = state().job.instance?.assignee?.username;
    box.append(h('div', { class: 'ps-row' }, h('b', { text: `${done}/${objs.length} object đã duyệt` }), h('span', { class: 'ps-muted', text: ` · quét ${new Date(r.startedAt).toLocaleTimeString('vi-VN')}` }),
      h('button', { class: 'ps-btn ps-sm', text: 'Quét lại', on: { click: () => run(() => api(`/api/jobs/${P.jobId}/scan`, { method: 'POST' })) } })));
    // Tab con như phía annotator: duyệt; lỗi đã trả mà chưa gửi (còn sửa / bỏ được, rồi mới bấm Gửi); phiếu đã gửi.
    if (!P.qcTab) { try { P.qcTab = localStorage.getItem(QC_TAB_KEY) || 'review'; } catch (_) { P.qcTab = 'review'; } }
    box.append(seg([['review', 'Duyệt', queue().length], ['drafts', 'Chưa gửi', drafts.length], ['sent', 'Đã gửi', sentT.length]], P.qcTab, (k) => { P.qcTab = k; try { localStorage.setItem(QC_TAB_KEY, k); } catch (_) { /* bỏ qua */ } }));
    if (P.qcTab === 'drafts') return draftsView(box, drafts, assignee);
    if (P.qcTab === 'sent') return sentView(box, sentT, accepted);
    const o = objs.find((x) => x.key === P.cur);
    if (o) {
      const card = h('div', { class: 'ps-card' }, h('div', { class: 'ps-row' }, h('b', { text: `${o.label} #${o.cvatId ?? o.serverId}` }), h('span', { class: 'ps-muted', text: ` frame ${o.first}–${o.last} · còn ${queue().length} chưa xem` })));
      const tool = toolFor(o);
      // Lỗi theo cặp: nút tới vật kia (cùng frame) để so hai box.
      const partner = (f) => { const k = f.objKey === o.key ? f.other : f.objKey; return { serverId: Number(k.split(':')[1]), name: `#${(f.objKey === o.key ? f.otherCvatId : f.cvatId) ?? k.split(':')[1]}` }; };
      card.append(tool.length ? h('ul', { class: 'ps-list' }, tool.map((f) => h('li', { class: f.severity === 'error' ? 'ps-err' : 'ps-warn' },
        h('span', { text: `${f.title}: ${f.short} (frame ${f.frames[0]}${f.frames.length > 1 ? `–${f.frames.at(-1)}` : ''}) ` }),
        f.other ? h('button', { class: 'ps-btn ps-sm', text: `Xem ${partner(f).name}`, on: { click: () => goTo(partner(f).serverId, f.frames[0]) } }) : null)))
        : h('div', { class: 'ps-muted', text: 'Tool không báo gì: QC tự xem.' }));
      card.append(h('div', { class: 'ps-row' },
        h('button', { class: 'ps-btn ps-ok', text: 'Đạt (Alt+1)', on: { click: () => run(() => qcAct('ok')) } }),
        h('button', { class: 'ps-btn ps-bad', text: 'Trả lỗi (Alt+2)', on: { click: () => returnForm(card, o) } }),
        h('button', { class: 'ps-btn', text: 'Báo nhầm (Alt+3)', on: { click: () => run(() => qcAct('false')) } }),
        h('button', { class: 'ps-btn', text: 'Xem lại box', on: { click: () => goTo(o.serverId, focusFrame(o)) } }),
        h('button', { class: 'ps-btn', text: 'Bỏ qua (Alt+J)', on: { click: () => skip() } })));
      box.append(card);
    } else box.append(h('div', { class: 'ps-ok-text', text: 'Đã duyệt hết object.' }));
    if (drafts.length) box.append(h('div', { class: 'ps-muted', text: `${drafts.length} lỗi đã trả, chưa gửi: xem lại ở tab "Chưa gửi" rồi bấm Gửi.` }));
    const missBtn = h('button', { class: 'ps-btn', text: '+ Thiếu vật ở frame này', on: { click: () => missingForm(box, missBtn, assignee) } });
    box.append(missBtn);
    box.append(h('button', { class: 'ps-btn', text: 'Hoàn thành duyệt job', on: { click: () => run(() => api(`/api/jobs/${P.jobId}/complete`, { method: 'POST', body: '{}' }).then(() => alert('Đã hoàn thành duyệt job'))) } }));
  }

  /** Lỗi QC đã trả mà chưa gửi: sửa lại (nhãn, frame, ghi chú) hoặc bỏ trả lỗi; cuối cùng mới Gửi cho annotator. */
  function draftsView(box, drafts, assignee) {
    if (!drafts.length) box.append(h('div', { class: 'ps-muted', text: 'Không có lỗi nào chờ gửi. Trả lỗi ở tab "Duyệt".' }));
    for (const o of drafts) {
      const is = P.data.objectReviews[o.key].issue || { tags: [], frame: null, text: '' };
      const card = h('div', { class: 'ps-card' },
        h('div', { class: 'ps-row' }, h('b', { text: `${o.label} #${o.cvatId ?? o.serverId}` }), h('span', { class: 'ps-muted', text: is.frame != null ? ` frame ${is.frame}` : ` frame ${o.first}–${o.last}` })),
        is.tags.length ? h('div', { class: 'ps-err', text: is.tags.join(' · ') }) : null, is.text ? h('div', { text: is.text }) : null);
      card.append(h('div', { class: 'ps-row' },
        h('button', { class: 'ps-btn', text: 'Tới box', on: { click: () => goTo(o.serverId, is.frame ?? focusFrame(o)) } }),
        h('button', { class: 'ps-btn', text: 'Sửa', on: { click: () => returnForm(card, o, is) } }),
        h('button', { class: 'ps-btn', text: 'Bỏ trả lỗi', on: { click: () => run(() => api(`/api/jobs/${P.jobId}/objects`, { method: 'POST', body: JSON.stringify({ keys: [o.key], status: null }) })) } })));
      box.append(card);
    }
    if (drafts.length) box.append(h('button', { class: 'ps-btn ps-pri', text: `Gửi ${drafts.length} lỗi cho ${assignee || 'annotator'}`, on: { click: () => run(async () => {
      if (!assignee) throw new Error('Job chưa giao annotator trên CVAT');
      await api('/api/tickets/batch', { method: 'POST', body: JSON.stringify({ jobId: P.jobId, assignee, keys: drafts.map((d) => d.key) }) });
    }) } }));
  }

  /** Phiếu đã gửi: annotator chưa đụng tới thì thu hồi được để sửa; đã nộp thì nghiệm thu / trả lại. */
  function sentView(box, list, accepted) {
    const LABEL = { open: ['Chờ annotator sửa', 'ps-muted'], returned: ['Đã trả lại, annotator sửa tiếp', 'ps-err'], submitted: ['Annotator đã nộp, chờ nghiệm thu', 'ps-warn'] };
    if (!list.length) box.append(h('div', { class: 'ps-muted', text: 'Chưa có phiếu nào đang mở.' }));
    for (const t of list) {
      const qcNote = [...t.thread].reverse().find((m) => m.role === 'qc' && m.text)?.text || '';
      const fresh = t.status === 'open' && t.kind !== 'missing' && !t.thread.some((m) => m.role === 'annotator');
      box.append(h('div', { class: 'ps-card' }, h('div', { class: 'ps-row' }, h('b', { text: `${t.id} · ${who(t)}` }), h('span', { class: (LABEL[t.status] || LABEL.open)[1], text: ` ${(LABEL[t.status] || LABEL.open)[0]}` })),
        h('div', { class: 'ps-err', text: t.title }), issueList(t), qcNote ? h('div', { text: qcNote }) : null,
        t.status === 'submitted' && t.unchanged ? h('div', { class: 'ps-warn', text: 'Object trên CVAT chưa đổi so với lúc trả lỗi.' }) : null,
        h('div', { class: 'ps-row' }, h('button', { class: 'ps-btn', text: 'Xem', on: { click: () => goTo(t.serverId, t.frames[0]) } }),
          fresh ? h('button', { class: 'ps-btn', text: 'Thu hồi để sửa', title: 'Annotator chưa bắt đầu: đưa về tab Chưa gửi', on: { click: () => run(() => api(`/api/tickets/${t.id}/recall`, { method: 'POST', body: '{}' })) } }) : null,
          t.status === 'submitted' ? h('button', { class: 'ps-btn ps-ok', text: 'Nghiệm thu', on: { click: () => run(() => api(`/api/tickets/${t.id}/accept`, { method: 'POST', body: '{}' })) } }) : null,
          t.status === 'submitted' ? h('button', { class: 'ps-btn ps-bad', text: 'Trả lại', on: { click: () => { const text = prompt('Lý do trả lại'); if (text) run(() => api(`/api/tickets/${t.id}/return`, { method: 'POST', body: JSON.stringify({ text }) })); } } }) : null,
          h('button', { class: 'ps-btn', text: 'Ghi chú', on: { click: () => { const text = prompt('Ghi chú thêm cho annotator'); if (text) run(() => api(`/api/tickets/${t.id}/comment`, { method: 'POST', body: JSON.stringify({ text }) })); } } }))));
    }
    if (accepted) box.append(h('div', { class: 'ps-ok-text', text: `${accepted} phiếu đã nghiệm thu.` }));
  }

  /** Tab con kiểu Segmented (dùng cho QC và annotator). */
  function seg(tabs, cur, pick) {
    return h('div', { class: 'ps-seg', role: 'tablist' }, tabs.map(([k, label, n]) => h('button', { class: `ps-seg-i${cur === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(cur === k), text: `${label} (${n})`,
      on: { click: () => { pick(k); render(); } } })));
  }

  function skip() {
    const q = queue(), i = q.findIndex((x) => x.key === P.cur), next = q[i + 1] || q[0];
    if (!next) return;
    P.cur = next.key; render(); goTo(next.serverId, focusFrame(next));
  }

  /** Form trả lỗi; `prev` là lỗi đã ghi (sửa lỗi chưa gửi): điền sẵn nhãn, frame, ghi chú và lưu tại chỗ. */
  function returnForm(card, o, prev = null) {
    card.querySelector('.ps-form')?.remove();
    const picked = new Set(prev ? prev.tags : toolFor(o).map((f) => f.title)); // mới: chọn sẵn mọi lỗi tool báo; QC bỏ tick lỗi báo nhầm
    const tags = [...new Set([...toolFor(o).map((f) => f.title), ...TAGS, ...picked])];
    const note = h('textarea', { rows: '2', placeholder: 'Ghi chú cho annotator', class: 'ps-in' });
    note.value = prev?.text || '';
    let frame = prev?.frame ?? state().player.frame.number;
    const frameText = h('span', { class: 'ps-muted', text: `Frame thấy lỗi: ${frame}` });
    const useCur = h('button', { class: 'ps-btn ps-sm', text: 'Lấy frame đang mở', on: { click: () => { frame = state().player.frame.number; frameText.textContent = `Frame thấy lỗi: ${frame}`; } } });
    const form = h('div', { class: 'ps-form' },
      h('div', { class: 'ps-row ps-wrap' }, tags.map((t) => { const b = h('button', { class: `ps-tag${picked.has(t) ? ' on' : ''}`, text: t }); b.addEventListener('click', () => { if (picked.has(t)) picked.delete(t); else picked.add(t); b.classList.toggle('on'); }); return b; })),
      h('div', { class: 'ps-row' }, frameText, useCur), note,
      h('div', { class: 'ps-row' }, h('button', { class: 'ps-btn ps-bad', text: prev ? 'Lưu' : 'Trả lỗi', on: { click: () => {
        if (!picked.size && !note.value.trim()) { note.placeholder = 'Chọn ít nhất một lỗi hoặc ghi chú'; return; }
        const keep = toolFor(o).filter((f) => picked.has(f.title)).map((f) => f.key);
        const issue = { tags: [...picked], frame, text: note.value.trim(), finding: keep[0] || null, findings: keep };
        if (prev) run(() => api(`/api/jobs/${P.jobId}/objects`, { method: 'POST', body: JSON.stringify({ keys: [o.key], status: 'returned', issue }) }));
        else run(() => qcAct('return', issue));
      } } }), h('button', { class: 'ps-btn', text: 'Huỷ', on: { click: () => form.remove() } })));
    card.append(form);
    note.focus();
  }

  /** Phiếu thiếu vật ở frame đang mở trong CVAT: class, vị trí, ghi chú; giao người được giao job. */
  function missingForm(box, after, assignee) {
    box.querySelector('.ps-miss')?.remove();
    const frame = state().player.frame.number;
    const label = h('input', { class: 'ps-in', placeholder: 'Class, vd: pedestrian', maxlength: '60' });
    const where = h('input', { class: 'ps-in', placeholder: 'Vị trí, vd: vỉa hè bên phải ~12 m', maxlength: '200' });
    const note = h('textarea', { rows: '2', class: 'ps-in', placeholder: 'Ghi chú cho annotator', maxlength: '500' });
    const form = h('div', { class: 'ps-form ps-miss' }, h('div', { class: 'ps-muted', text: `Thiếu box ở frame ${frame} (frame đang mở trong CVAT)` }), label, where, note,
      h('div', { class: 'ps-row' }, h('button', { class: 'ps-btn ps-bad', text: 'Tạo phiếu', on: { click: () => {
        if (!label.value.trim()) { label.placeholder = 'Nhập class của vật bị thiếu'; label.focus(); return; }
        run(async () => {
          if (!assignee) throw new Error('Job chưa giao annotator trên CVAT');
          await api('/api/tickets/missing', { method: 'POST', body: JSON.stringify({ jobId: P.jobId, assignee, label: label.value, frame, where: where.value, text: note.value }) });
        });
      } } }), h('button', { class: 'ps-btn', text: 'Huỷ', on: { click: () => form.remove() } })));
    after.after(form);
    label.focus();
  }

  // ------------------------------------------------------------------ annotator

  async function loadAnn() { P.tickets = (await api('/api/tickets')).filter((t) => t.jobId === P.jobId); }

  /** Từng lỗi tool báo trong phiếu: tới frame của lỗi đó, lỗi theo cặp thì tới cả vật kia. */
  const issueList = (t) => (t.issues?.length ? h('ul', { class: 'ps-list' }, t.issues.map((x) => h('li', { class: x.severity === 'error' ? 'ps-err' : 'ps-warn' },
    h('span', { text: `${x.title}: ${x.short} ` }),
    h('button', { class: 'ps-btn ps-sm', text: x.frames[0] === x.frames[1] ? `Frame ${x.frames[0]}` : `Frame ${x.frames[0]}–${x.frames[1]}`, on: { click: () => goTo(t.serverId, x.frames[0]) } }),
    x.other ? h('button', { class: 'ps-btn ps-sm', text: `Xem ${x.otherLabel || ''} #${x.otherCvatId ?? x.otherServerId}`, on: { click: () => goTo(x.otherServerId, x.frames[0]) } }) : null))) : null);

  /** Nộp (hoặc nộp lại để sửa ghi chú): chặn khi CVAT còn thay đổi chưa Lưu. */
  const submit = (t, text) => run(async () => {
    const job = state().job.instance;
    if (job?.annotations?.hasUnsavedChanges && await job.annotations.hasUnsavedChanges()) throw new Error('Còn thay đổi chưa Lưu: bấm Save (Ctrl+S) của CVAT trước');
    const r = await api(`/api/tickets/${t.id}/submit`, { method: 'POST', body: JSON.stringify({ text }) });
    if (r.unchanged) alert('Đã nộp, nhưng object trên CVAT chưa đổi so với lúc QC trả lỗi.');
  });

  function annView(box) {
    const todo = P.tickets.filter((t) => t.status === 'open' || t.status === 'returned'), sent = P.tickets.filter((t) => t.status === 'submitted');
    const done = P.tickets.filter((t) => t.status === 'accepted');
    const goBtn = (t) => [h('button', { class: 'ps-btn', text: t.kind === 'missing' ? `Tới frame ${t.frames[0]}` : 'Tới box', on: { click: () => goTo(t.serverId, t.frames[0]) } }),
      t.other && !t.issues?.length ? h('button', { class: 'ps-btn', text: `Xem ${t.otherLabel || ''} #${t.otherCvatId ?? t.otherServerId} (vật kia)`, on: { click: () => goTo(t.otherServerId, t.frames[0]) } }) : null];
    // Tab con thay cho cuộn dài. Mở job: còn lỗi chưa nộp thì vào "Chưa nộp", không thì tab chọn lần trước.
    if (!P.annTab) { try { P.annTab = localStorage.getItem(ANN_TAB_KEY); } catch (_) { /* bộ nhớ trang bị chặn */ } if (todo.length || !P.annTab) P.annTab = 'todo'; }
    box.append(seg([['todo', 'Chưa nộp', todo.length], ['sent', 'Đã nộp', sent.length], ['done', 'Đã nghiệm thu', done.length]], P.annTab,
      (k) => { P.annTab = k; try { localStorage.setItem(ANN_TAB_KEY, k); } catch (_) { /* bỏ qua */ } }));
    if (P.annTab === 'done') {
      if (!done.length) box.append(h('div', { class: 'ps-muted', text: 'Chưa có lỗi nào được QC nghiệm thu.' }));
      for (const t of done) box.append(h('div', { class: 'ps-card' }, h('div', { class: 'ps-row' }, h('b', { text: `${t.id} · ${who(t)}` }), h('span', { class: 'ps-ok-text', text: ' đã nghiệm thu (khoá)' })),
        h('div', { class: 'ps-muted', text: t.title }), h('div', { class: 'ps-row' }, goBtn(t))));
      return;
    }
    if (P.annTab === 'todo') {
      if (!todo.length) box.append(h('div', { class: 'ps-muted', text: 'Không còn lỗi nào cần sửa ở job này.' }));
      for (const t of todo) {
        const qcNote = [...t.thread].reverse().find((m) => m.role === 'qc' && m.text)?.text || t.message || '';
        const reply = h('textarea', { rows: '1', placeholder: 'Đã sửa gì (tuỳ chọn)', class: 'ps-in' });
        box.append(h('div', { class: 'ps-card' },
          h('div', { class: 'ps-row' }, h('b', { text: `${t.id} · ${who(t)}` }), h('span', { class: t.status === 'returned' ? 'ps-err' : 'ps-muted', text: t.status === 'returned' ? ' QC trả lại' : ` frame ${t.frames[0]}` })),
          h('div', { class: 'ps-err', text: t.title }), issueList(t), h('div', { text: qcNote }), reply,
          h('div', { class: 'ps-row' }, goBtn(t), h('button', { class: 'ps-btn ps-pri', text: 'Nộp', on: { click: () => submit(t, reply.value) } }))));
      }
      return;
    }
    // Đã nộp mà QC chưa xử lý: còn sửa ghi chú / nộp lại sau khi sửa thêm, hoặc rút về "Chưa nộp".
    if (!sent.length) box.append(h('div', { class: 'ps-muted', text: 'Không có bài nào đang chờ QC.' }));
    for (const t of sent) {
      const mine = [...t.thread].reverse().find((m) => m.role !== 'qc' && m.role !== 'bot' && m.kind === 'submit');
      const reply = h('textarea', { rows: '1', placeholder: 'Ghi chú khi nộp', class: 'ps-in' });
      reply.value = mine?.text || '';
      box.append(h('div', { class: 'ps-card' },
        h('div', { class: 'ps-row' }, h('b', { text: `${t.id} · ${who(t)}` }), h('span', { class: 'ps-muted', text: mine ? ` nộp ${new Date(mine.at).toLocaleTimeString('vi-VN')}` : '' })),
        h('div', { class: 'ps-err', text: t.title }), issueList(t), t.unchanged ? h('div', { class: 'ps-warn', text: 'Object trên CVAT chưa đổi so với lúc QC trả lỗi.' }) : null, reply,
        h('div', { class: 'ps-row' }, goBtn(t), h('button', { class: 'ps-btn', text: 'Nộp lại', on: { click: () => submit(t, reply.value) } }),
          h('button', { class: 'ps-btn', text: 'Rút lại để sửa', on: { click: () => run(() => api(`/api/tickets/${t.id}/withdraw`, { method: 'POST', body: '{}' })) } }))));
    }
  }

  // ------------------------------------------------------------------ bảng annotator (chung mã với extension)

  // Đo box, mặt đất, sửa cả track… là các script MAIN world của extension, dịch vụ gộp ở /annotator-panel.js. Bảng hỏi / lưu
  // bộ ngưỡng bằng postMessage (như với settings-bridge của extension); ở đây trả lời bằng spec theo project của dịch vụ
  // QC, nên cả nhóm dùng chung một spec. Phần `qc` của spec (luật chỉ QC) giữ nguyên khi annotator / QC sửa trong CVAT.
  const SETTINGS = 'POINTSNAP_ANNOTATOR_SETTINGS';
  let specKey = 'default';

  async function sendSettings() {
    const key = specKey;
    let shared = {}, name = '';
    try {
      const s = await api(`/api/specs/${key}`);
      shared = { ...s.override };
      delete shared.qc;
      name = s.name;
    } catch (_) { /* dịch vụ tắt / chưa đăng nhập: ngưỡng mặc định */ }
    if (key === specKey) window.postMessage({ type: SETTINGS, detail: { enabled: true, guidelineJson: JSON.stringify(shared), guidelineName: name, projectKey: key } }, location.origin);
  }

  async function saveSpec({ guidelineJson, guidelineName }) {
    const reply = (detail) => window.postMessage({ type: 'POINTSNAP_SPEC_SAVED', detail }, location.origin);
    try {
      const key = specKey, qc = (await api(`/api/specs/${key}`)).override?.qc;
      await api(`/api/specs/${key}`, { method: 'PUT', body: JSON.stringify({ name: String(guidelineName || '').slice(0, 80), note: 'Sửa trong CVAT',
        override: { ...JSON.parse(guidelineJson), ...(qc ? { qc } : {}) } }) });
      reply({ ok: true, projectKey: key });
      sendSettings();
    } catch (e) { reply({ ok: false, error: e.status === 403 ? 'Chỉ QC lưu được spec của project' : e.message }); }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const { type, detail } = event.data || {};
    if (type === `${SETTINGS}_REQUEST`) { specKey = Number(detail?.projectId) || 'default'; sendSettings(); }
    else if (type === 'POINTSNAP_SPEC_SAVE' && typeof detail?.guidelineJson === 'string') saveSpec(detail);
  });
  // Báo extension (nếu còn cài) để settings-bridge của nó đứng ngoài; annotator.js tự bỏ qua nếu đã có một bảng chạy.
  document.documentElement.dataset.pointsnapPlugin = '1';
  // CSS nạp ngay: tab được chèn trước khi khung QC / annotator dựng xong, thiếu CSS thì tab vỡ (logo to, nội dung lẫn).
  document.head.append(h('link', { rel: 'stylesheet', href: `${BASE}/plugin.css` }));
  document.head.append(h('script', { src: `${BASE}/annotator-panel.js` }));

  // ------------------------------------------------------------------ tab PointSnap trong thanh bên của CVAT

  // CVAT chưa có chỗ cắm plugin cho thanh bên, nên chèn một tab cùng kiểu antd cạnh Objects / Labels. Bật tab thì ẩn nội
  // dung của CVAT (không gỡ, React vẫn giữ) và hiện `.ps-pane` chứa bảng annotator + khung QC; không gì nổi đè lên canvas.
  // shortcut: dò lại mỗi 400 ms vì thanh bên được dựng lại khi đổi job / thu gọn; nếu CVAT có slot cho thanh bên thì chuyển sang.
  const TAB_KEY = 'pointsnap.sidebarTab';
  let tabOn = false;
  try { tabOn = localStorage.getItem(TAB_KEY) === '1'; } catch (_) { /* bộ nhớ trang bị chặn */ }

  function setTab(on) {
    tabOn = on;
    try { localStorage.setItem(TAB_KEY, on ? '1' : '0'); } catch (_) { /* bỏ qua */ }
    ensureTab();
  }

  function ensureTab() {
    const tabs = document.querySelector('.cvat-objects-sidebar-tabs'), list = tabs?.querySelector('.ant-tabs-nav-list');
    if (!list) return;
    let tab = list.querySelector('.ps-sidebar-tab'), pane = tabs.querySelector('.ps-pane');
    if (!tab) {
      const btn = h('div', { class: 'ant-tabs-tab-btn', role: 'tab', tabindex: '0', title: 'PointSnap: QC và phiếu sửa lỗi' });
      btn.innerHTML = `${LOGO}<span>PointSnap</span>`;
      tab = h('div', { class: 'ant-tabs-tab ps-sidebar-tab', on: { click: () => setTab(true), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(true); } } } }, btn);
      list.insertBefore(tab, list.querySelector('.ant-tabs-ink-bar'));
      // Bấm Objects / Labels: về nội dung của CVAT.
      list.addEventListener('click', (e) => { if (e.target.closest('.ant-tabs-tab') && !e.target.closest('.ps-sidebar-tab')) setTab(false); });
    }
    if (!pane) { pane = h('div', { class: 'ps-pane', role: 'tabpanel', 'aria-label': 'PointSnap' }); tabs.querySelector('.ant-tabs-content-holder').after(pane); }
    tabs.classList.toggle('ps-tab-on', tabOn);
    tab.firstChild.setAttribute('aria-selected', String(tabOn));
    if (P.el && P.el.parentNode !== pane) pane.append(P.el);
  }
  setInterval(ensureTab, 400);

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
    // Chưa gắn vào đâu: ensureTab đưa vào tab PointSnap khi thanh bên của CVAT có mặt, không nổi trên trang.
    if (!P.el) P.el = h('div', { id: 'pointsnap-plugin' });
    P.el.hidden = !P.jobId || !P.me;
    P.el.replaceChildren();
    const logo = h('span', { class: 'ps-logo', 'aria-hidden': 'true' });
    logo.innerHTML = LOGO;
    const head = h('div', { class: 'ps-head' }, logo, h('b', { text: 'PointSnap' }), h('span', { class: 'ps-role', text: P.me?.role === 'qc' ? 'QC' : 'Annotator' }), h('span', { class: 'ps-muted ps-name', text: P.me?.name || '' }),
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
    if (id !== P.jobId) { P.jobId = id; P.cur = null; P.data = null; P.annTab = null; refresh(); }
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || !P.jobId || P.me?.role !== 'qc' || P.qcTab !== 'review' || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    const o = P.data?.result?.objects.find((x) => x.key === P.cur);
    const act = { 1: () => run(() => qcAct('ok')), 2: () => o && returnForm(P.el.querySelector('.ps-card'), o), 3: () => run(() => qcAct('false')), j: skip }[e.key.toLowerCase()];
    if (act) { e.preventDefault(); e.stopPropagation(); act(); }
  }, true);

  // Đăng xuất / đăng nhập tài khoản khác trên CVAT không tải lại trang: hỏi lại vai trò mỗi khi tài khoản CVAT đổi, không
  // giữ vai trò (và dữ liệu) của người trước.
  function syncUser() {
    const name = P.ctx.store.getState().auth?.user?.username || null;
    if (name === P.user) return;
    Object.assign(P, { user: name, me: null, jobId: null, data: null, tickets: [], cur: null });
    if (P.el) P.el.hidden = true;
    // Dịch vụ QC tắt / đang khởi động: không hiện gì, lần cập nhật kế tiếp của CVAT hỏi lại (tối đa mỗi 5 giây).
    if (name) api('/api/me').then((me) => { if (P.user === name) { P.me = me; watch(); } })
      .catch(() => setTimeout(() => { if (P.user === name && !P.me) P.user = undefined; }, 5000));
  }

  function register() {
    window.cvatUI.registerComponent((ctx) => {
      P.ctx = ctx;
      syncUser();
      return { name: 'PointSnap QC', destructor: () => P.el?.remove(), globalStateDidUpdate: () => { syncUser(); if (P.me) watch(); } };
    });
  }
  (function wait(n = 0) { if (window.cvatUI) register(); else if (n < 200) setTimeout(() => wait(n + 1), 150); })();
}());

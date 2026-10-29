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
  const QC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="m9 13 2 2 4-4"/></svg>';
  /** Nút ký hiệu: chữ ngắn hoặc ký tự, đủ nghĩa ở chú thích (title) và cho trình đọc màn hình (aria-label). */
  const ib = (text, label, click, cls = '') => h('button', { class: `ps-btn ps-sm ${cls}`, text, title: label, 'aria-label': label, on: { click } });
  const P = { ctx: null, me: null, jobId: null, data: null, tickets: [], cur: null, busy: false, el: null, annTab: null, qcTab: null, threads: new Set(), showDrafts: false };
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
      const s = a.player.frame.number === frame && !a.player.frame.fetching && a.annotations.states.find((x) => x.serverID === serverId);
      if (s) {
        dispatch({ type: 'ACTIVATE_OBJECT', payload: { activatedStateID: s.clientID, activatedElementID: null, activatedAttributeID: null } });
        // Đưa camera 3D tới box như double-click object trong CVAT (canvas3d tự chọn khoảng cách / góc); giống cvat-adapter.select.
        const canvas = a.canvas?.instance;
        setTimeout(() => {
          try { if (canvas?.view?.focusObjectByClientId) canvas.view.focusObjectByClientId(s.clientID, true); else canvas?.focus?.(s.clientID); } catch (_) { /* canvas chưa vẽ xong: vẫn đã chọn box */ }
        }, 100);
        return true;
      }
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
    const assignee = state().job.instance?.assignee?.username;
    const by = (...s) => P.tickets.filter((t) => s.includes(t.status));
    // Vòng QC ↔ annotator: QC duyệt đủ object rồi gửi hết lỗi một lần, để đếm được số lần rework. Lỗi chờ gửi: object trả lỗi
    // chưa có phiếu, bài QC trả lại (giữ tới khi gửi), phiếu thiếu vật chưa gửi.
    const rounds = P.data.rounds || [], last = rounds.at(-1), held = P.tickets.filter((t) => t.status === 'submitted' && t.held), miss = by('draft');
    const roundNo = !last ? 1 : last.submittedAt ? rounds.length + 1 : rounds.length;
    const tabs = { review: null, ann: by('open', 'returned'), qc: P.tickets.filter((t) => t.status === 'submitted' && !t.held), done: by('accepted') };
    // Một dòng đầu: thanh tiến độ duyệt, vòng, giờ quét, quét lại. Vai trò / tên ở chú thích.
    const bar = h('i');
    bar.style.width = `${objs.length ? Math.round((done / objs.length) * 100) : 100}%`;
    box.append(h('div', { class: 'ps-top', title: `QC · ${P.me.name}` }, h('span', { class: 'ps-prog' }, bar), h('b', { class: 'ps-num', text: `${done}/${objs.length}` }),
      h('span', { class: 'ps-chip', text: `V${roundNo}`, title: `Vòng ${roundNo}${rounds.length ? ` · đã gửi ${rounds.length} vòng` : ''}` }),
      h('span', { class: 'ps-muted ps-xs', text: `quét ${new Date(r.startedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` }),
      ib('⟳', 'Quét lại job', () => run(() => api(`/api/jobs/${P.jobId}/scan`, { method: 'POST' })), 'ps-icon')));
    // Tab con đặt theo lượt của ai, cùng chữ với phía annotator: QC duyệt → annotator đang sửa → chờ QC nghiệm thu → xong.
    if (!(P.qcTab in tabs)) { try { P.qcTab = localStorage.getItem(QC_TAB_KEY); } catch (_) { /* bộ nhớ trang bị chặn */ } if (!(P.qcTab in tabs)) P.qcTab = 'review'; }
    box.append(seg([['review', 'Duyệt', queue().length, true, 'Object chưa duyệt'], ['ann', 'Đang sửa', tabs.ann.length, false, 'Phiếu chờ annotator sửa'],
      ['qc', 'Chờ QC', tabs.qc.length, true, 'Annotator đã nộp, chờ QC nghiệm thu'], ['done', 'Xong', tabs.done.length, false, 'Đã nghiệm thu']],
    P.qcTab, (k) => { P.qcTab = k; try { localStorage.setItem(QC_TAB_KEY, k); } catch (_) { /* bỏ qua */ } }, tabs));
    if (P.qcTab !== 'review') {
      const list = tabs[P.qcTab];
      if (!list.length) box.append(h('div', { class: 'ps-empty', text: { ann: 'Không có phiếu nào đang chờ annotator.', qc: 'Không có bài nào chờ nghiệm thu.', done: 'Chưa có phiếu nào nghiệm thu.' }[P.qcTab] }));
      for (const t of list) {
        const fresh = t.status === 'open' && t.kind !== 'missing' && !t.thread.some((m) => m.role === 'annotator');
        box.append(ticketRow(t, (reply) => (P.qcTab === 'ann' && fresh ? [h('button', { class: 'ps-btn ps-sm', text: 'Thu hồi', title: 'Annotator chưa bắt đầu: thu hồi về danh sách chưa gửi để sửa', on: { click: () => run(() => api(`/api/tickets/${t.id}/recall`, { method: 'POST', body: '{}' })) } })]
          : P.qcTab === 'qc' ? judge(t, reply) : [])));
      }
      return;
    }
    // Lỗi chờ gửi: thanh trên đầu "Duyệt", mở ra để sửa / bỏ từng lỗi. Gửi cả vòng khi đã duyệt đủ object và xử lý hết bài nộp.
    const pending = drafts.length + held.length + miss.length;
    if (pending) {
      const out = tabs.ann.length, why = queue().length ? `Còn ${queue().length} object chưa duyệt` : tabs.qc.length ? `Còn ${tabs.qc.length} bài chờ nghiệm thu / trả lại`
        : out && last?.submittedAt ? `Annotator còn ${out} phiếu chưa nộp lại` : '';
      const sendBtn = h('button', { class: 'ps-btn ps-pri ps-sm', text: `Gửi V${roundNo}`, title: why || `Gửi ${pending} lỗi cho ${assignee || 'annotator'} (vòng ${roundNo})`, on: { click: () => run(async () => {
        if (!assignee) throw new Error('Job chưa giao annotator trên CVAT');
        await api('/api/tickets/batch', { method: 'POST', body: JSON.stringify({ jobId: P.jobId, assignee }) });
      }) } });
      sendBtn.disabled = !!why;
      box.append(h('div', { class: 'ps-bar' }, h('b', { class: 'ps-ell', text: `${pending} lỗi chờ gửi` }),
        h('button', { class: 'ps-link', text: P.showDrafts ? 'Thu gọn' : 'Sửa ▸', 'aria-expanded': String(!!P.showDrafts), on: { click: () => { P.showDrafts = !P.showDrafts; render(); } } }), sendBtn));
      if (why) box.append(h('div', { class: 'ps-muted ps-xs', text: `${why}: duyệt xong mới gửi cả vòng.` }));
      if (P.showDrafts) draftsView(box, drafts, held, miss);
    }
    const o = objs.find((x) => x.key === P.cur);
    if (o) {
      const tool = toolFor(o);
      const card = h('div', { class: `ps-tk ps-s-${tool.some((f) => f.severity === 'error') ? 'err' : tool.length ? 'warn' : 'none'} open ps-cur` },
        h('div', { class: 'ps-l1' }, h('b', { class: 'ps-ell', text: `#${o.cvatId ?? o.serverId} ${o.label}` }), h('span', { class: 'ps-id', text: `F${o.first}–${o.last}` }),
          ib('◎', 'Xem lại box', () => goTo(o.serverId, focusFrame(o)), 'ps-icon')));
      // Lỗi theo cặp: nút tới vật kia (cùng frame) để so hai box.
      const partner = (f) => { const k = f.objKey === o.key ? f.other : f.objKey; return { serverId: Number(k.split(':')[1]), name: `#${(f.objKey === o.key ? f.otherCvatId : f.cvatId) ?? k.split(':')[1]}` }; };
      card.append(tool.length ? h('div', { class: 'ps-finds' }, tool.map((f) => h('div', { class: 'ps-find' }, chip(f.title, f.severity === 'error' ? 'err' : 'warn'),
        h('span', { class: 'ps-ell ps-muted', text: f.short, title: f.short }), chip(fr(f.frames[0], f.frames.at(-1))),
        f.other ? ib(`↔${partner(f).name}`, `Xem vật kia ${partner(f).name}`, () => goTo(partner(f).serverId, f.frames[0])) : null)))
        : h('div', { class: 'ps-muted ps-xs', text: 'Tool không báo lỗi: QC tự xem.' }));
      card.append(h('div', { class: 'ps-acts' },
        h('button', { class: 'ps-btn ps-ok', text: 'Đạt', title: 'Đạt (Alt+1)', on: { click: () => run(() => qcAct('ok')) } }),
        h('button', { class: 'ps-btn ps-bad', text: 'Trả lỗi', title: 'Trả lỗi (Alt+2)', on: { click: () => returnForm(card, o) } }),
        h('button', { class: 'ps-btn', text: 'Báo nhầm', title: 'Báo nhầm (Alt+3)', on: { click: () => run(() => qcAct('false')) } }),
        h('button', { class: 'ps-btn', text: 'Bỏ qua', title: 'Bỏ qua (Alt+J)', on: { click: () => skip() } })));
      box.append(card);
    } else box.append(h('div', { class: 'ps-empty ps-ok-text', text: 'Đã duyệt hết object.' }));
    const foot = h('div', { class: 'ps-foot' });
    const missBtn = h('button', { class: 'ps-btn ps-sm', text: '+ Thiếu vật', title: 'Phiếu thiếu vật ở frame đang mở', on: { click: () => missingForm(box, foot, assignee) } });
    foot.append(missBtn, h('button', { class: 'ps-btn ps-sm', text: 'Hoàn thành', title: 'Hoàn thành duyệt job (cần đủ 100% object, gửi hết lỗi, nghiệm thu hết phiếu)', on: { click: () => run(() => api(`/api/jobs/${P.jobId}/complete`, { method: 'POST', body: '{}' }).then(() => alert('Đã hoàn thành duyệt job'))) } }));
    box.append(foot);
  }

  /** Nghiệm thu có hiệu lực ngay; Trả lại giữ lời trả lại tới khi gửi cả vòng (bấm lại để sửa lời, Nghiệm thu để bỏ). */
  const judge = (t, reply) => [h('button', { class: 'ps-btn ps-sm ps-ok', text: 'Nghiệm thu', on: { click: () => run(() => api(`/api/tickets/${t.id}/accept`, { method: 'POST', body: JSON.stringify({ text: reply.value }) })) } }),
    h('button', { class: 'ps-btn ps-sm ps-bad', text: t.held ? 'Sửa lời' : 'Trả lại', title: 'Trả lại: gửi cùng vòng sau', on: { click: () => {
      if (!reply.value.trim()) { reply.placeholder = 'Ghi lý do trả lại vào đây'; reply.focus(); return; }
      run(() => api(`/api/tickets/${t.id}/return`, { method: 'POST', body: JSON.stringify({ text: reply.value }) }));
    } } })];

  /**
   * Lỗi chờ gửi: object đã trả lỗi (sửa nhãn, frame, ghi chú hoặc bỏ trả lỗi), bài QC trả lại (sửa lời hoặc đổi thành nghiệm
   * thu), phiếu thiếu vật chưa gửi (bỏ được). Nút Gửi ở thanh phía trên.
   */
  function draftsView(box, drafts, held, miss) {
    for (const t of held) box.append(ticketRow(t, (reply) => judge(t, reply)));
    for (const t of miss) box.append(ticketRow(t, () => [h('button', { class: 'ps-btn ps-sm', text: 'Bỏ', title: 'Bỏ phiếu thiếu vật chưa gửi', on: { click: () => run(() => api(`/api/tickets/${t.id}/recall`, { method: 'POST', body: '{}' })) } })]));
    for (const o of drafts) {
      const is = P.data.objectReviews[o.key].issue || { tags: [], frame: null, text: '' };
      const card = h('div', { class: 'ps-tk ps-s-err' },
        h('div', { class: 'ps-l1' }, h('b', { class: 'ps-ell', text: `#${o.cvatId ?? o.serverId} ${o.label}` }),
          ib('◎', 'Tới box', () => goTo(o.serverId, is.frame ?? focusFrame(o)), 'ps-icon'),
          ib('✎', 'Sửa lỗi này', () => returnForm(card, o, is), 'ps-icon'),
          ib('✕', 'Bỏ trả lỗi (object về chưa xem)', () => run(() => api(`/api/jobs/${P.jobId}/objects`, { method: 'POST', body: JSON.stringify({ keys: [o.key], status: null }) })), 'ps-icon')),
        h('div', { class: 'ps-chips' }, is.tags.map((x) => chip(x, 'err')), chip(is.frame != null ? `F${is.frame}` : fr(o.first, o.last))),
        is.text ? h('div', { class: 'ps-l3' }, h('span', { class: 'ps-ell', text: is.text, title: is.text })) : null);
      box.append(card);
    }
  }

  /** Nhãn nhỏ; `kind`: err / warn / ok / '' (xám). */
  const chip = (text, kind = '') => h('span', { class: `ps-chip${kind ? ` ps-c-${kind}` : ''}`, text });
  const fr = (a, b) => (a === b ? `F${a}` : `F${a}–${b}`);

  /**
   * Tab con chia đều bề ngang: chữ ngắn ở trên, số ở dưới. `need`: tab chờ người đang xem làm (số đỏ khi > 0); `title`:
   * tên đầy đủ. `lists`: phiếu của từng tab, để chấm tab có trao đổi mới.
   */
  function seg(tabs, cur, pick, lists = {}) {
    const el = h('div', { class: 'ps-seg', role: 'tablist' }, tabs.map(([k, label, n, need, title]) => {
      const fresh = (lists[k] || []).some(unread);
      return h('button', { class: `ps-seg-i${cur === k ? ' on' : ''}${need && n ? ' need' : ''}`, role: 'tab', 'aria-selected': String(cur === k), title: `${title}${fresh ? ' · có trao đổi mới' : ''}`,
        on: { click: () => { pick(k); render(); } } }, h('span', { class: 'ps-seg-l', text: label }), h('span', { class: 'ps-seg-n' }, h('span', { text: String(n) }), fresh ? h('span', { class: 'ps-dot' }) : null));
    }));
    el.style.gridTemplateColumns = `repeat(${tabs.length}, minmax(0, 1fr))`;
    return el;
  }

  // ------------------------------------------------------------------ phiếu: một kiểu thẻ cho mọi tab, có trao đổi QC ↔ annotator

  const KIND = { assign: 'trả lỗi', tool: 'tool báo', fix: 'đã sửa', submit: 'nộp', withdraw: 'rút lại', comment: 'ghi chú', accept: 'nghiệm thu', return: 'trả lại' };
  const SEEN_KEY = 'pointsnap.qc.seen';
  const seenMap = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (_) { return {}; } };
  function markSeen(id) { try { const m = seenMap(); m[id] = new Date().toISOString(); localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (_) { /* bỏ qua */ } }
  /** Tin cuối (không tính tool) là của bên kia và mới hơn lần mở trao đổi trước: đang chờ mình đọc / trả lời. */
  const unread = (t) => { const last = t.thread.filter((m) => m.role !== 'bot').at(-1); return !!last && last.role !== P.me?.role && last.at > (seenMap()[t.id] || ''); };
  const fmtAt = (iso) => new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

  /** Toàn bộ trao đổi kiểu chat: mình bên phải, bên kia bên trái, tool ở giữa nhạt; một dòng "tên · giờ · loại". */
  function threadView(t) {
    const msgs = t.thread.filter((m) => m.text || m.kind !== 'comment');
    return h('div', { class: 'ps-thread' }, msgs.map((m) => h('div', { class: `ps-msg ${m.role === P.me?.role ? 'me' : m.role === 'bot' ? 'bot' : 'them'}` },
      h('div', { class: 'ps-msg-h' }, h('b', { class: 'ps-ell', text: m.role === 'bot' ? 'Tool' : m.name || m.by }), h('span', { class: 'ps-muted', text: fmtAt(m.at) }),
        KIND[m.kind] ? h('span', { class: `ps-kind ps-k-${m.kind}`, text: KIND[m.kind] }) : null),
      m.text ? h('div', { class: 'ps-msg-t', text: m.text }) : null)));
  }

  /**
   * Phiếu dạng dòng gọn: sọc màu theo mức lỗi; dòng 1 vật + mã phiếu; dòng 2 nhãn lỗi + frame; dòng 3 tin cuối + số tin.
   * Bấm dòng để mở: từng lỗi (tới frame / vật kia), trao đổi, ô trả lời, các nút theo tab (`actions(ô trả lời)`).
   */
  function ticketRow(t, actions) {
    const open = P.threads.has(t.id), msgs = t.thread.filter((m) => m.text || m.kind !== 'comment');
    const last = [...msgs].reverse().find((m) => m.text && m.role !== 'bot') || msgs.at(-1);
    const sev = t.status === 'accepted' ? 'ok' : t.priority === 'warn' ? 'warn' : 'err';
    const toggle = () => { if (open) P.threads.delete(t.id); else { P.threads.add(t.id); markSeen(t.id); } render(); };
    const head = h('div', { class: 'ps-tk-h', role: 'button', tabindex: '0', 'aria-expanded': String(open), title: open ? 'Thu gọn' : 'Mở trao đổi',
      on: { click: toggle, keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } } },
    h('div', { class: 'ps-l1' }, unread(t) ? h('span', { class: 'ps-dot', title: 'Có trao đổi mới' }) : null,
      h('b', { class: 'ps-ell', text: t.kind === 'missing' ? `${t.label} · thiếu box` : `#${t.cvatId ?? t.serverId} ${t.label}` }), h('span', { class: 'ps-id', text: t.id })),
    // Mở ra thì danh sách lỗi bên dưới đã có nhãn từng lỗi: không lặp lại.
    h('div', { class: 'ps-chips' }, open && t.issues?.length ? null : [...t.title.split(' · ').map((x) => chip(x, sev === 'ok' ? '' : sev)), chip(fr(t.frames[0], t.frames[1]))],
      t.round > 1 ? chip(`V${t.round}`) : null, t.status === 'returned' ? chip('trả lại', 'err') : null, t.held ? chip('chờ gửi trả lại', 'err') : null,
      t.status === 'draft' ? chip('chưa gửi', 'warn') : null, t.fixed && t.status !== 'submitted' ? chip('đã sửa', 'ok') : null,
      t.status === 'submitted' && t.unchanged ? chip('CVAT chưa đổi', 'warn') : null),
    last ? h('div', { class: 'ps-l3' }, h('span', { class: `ps-ava ps-a-${last.role}`, text: (last.role === 'bot' ? 'T' : (last.name || '?')[0]).toUpperCase() }),
      h('span', { class: 'ps-ell', text: last.text || KIND[last.kind] || '' }), h('span', { class: 'ps-muted ps-xs', text: `· ${msgs.length}` })) : null);
    const card = h('div', { class: `ps-tk ps-s-${sev}${open ? ' open' : ''}` }, head);
    if (!open) return card;
    const reply = h('textarea', { rows: '1', class: 'ps-in', placeholder: 'Trả lời…', maxlength: '1000', 'aria-label': `Trả lời phiếu ${t.id}` });
    card.append(issueList(t), threadView(t), reply,
      h('div', { class: 'ps-acts-r' }, ib(t.kind === 'missing' ? `F${t.frames[0]}` : '◎', t.kind === 'missing' ? `Tới frame ${t.frames[0]}` : 'Tới box', () => goTo(t.serverId, t.frames[0]), 'ps-icon'),
        t.other && !t.issues?.length ? ib(`↔#${t.otherCvatId ?? t.otherServerId}`, `Xem ${t.otherLabel || 'vật kia'} #${t.otherCvatId ?? t.otherServerId}`, () => goTo(t.otherServerId, t.frames[0])) : null,
        h('span', { class: 'ps-grow' }), actions(reply),
        h('button', { class: 'ps-btn ps-sm', text: 'Gửi', title: 'Gửi trả lời', on: { click: () => { if (!reply.value.trim()) { reply.focus(); return; } run(() => api(`/api/tickets/${t.id}/comment`, { method: 'POST', body: JSON.stringify({ text: reply.value }) })); } } })));
    return card;
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
  const issueList = (t) => (t.issues?.length ? h('div', { class: 'ps-finds' }, t.issues.map((x) => h('div', { class: 'ps-find' }, chip(x.title, x.severity === 'error' ? 'err' : 'warn'),
    h('span', { class: 'ps-ell ps-muted', text: x.short, title: x.short }),
    ib(fr(x.frames[0], x.frames[1]), `Tới frame ${x.frames[0]}`, () => goTo(t.serverId, x.frames[0])),
    x.other ? ib(`↔#${x.otherCvatId ?? x.otherServerId}`, `Xem ${x.otherLabel || 'vật kia'} #${x.otherCvatId ?? x.otherServerId}`, () => goTo(x.otherServerId, x.frames[0])) : null))) : null);

  /** Nộp cả vòng: chặn khi CVAT còn thay đổi chưa Lưu. */
  const submitAll = () => run(async () => {
    const job = state().job.instance;
    if (job?.annotations?.hasUnsavedChanges && await job.annotations.hasUnsavedChanges()) throw new Error('Còn thay đổi chưa Lưu: bấm Save (Ctrl+S) của CVAT trước');
    const same = (await api('/api/tickets/submit-all', { method: 'POST', body: JSON.stringify({ jobId: P.jobId }) })).filter((x) => x.unchanged);
    if (same.length) alert(`Đã nộp, nhưng ${same.length} object trên CVAT chưa đổi so với lúc QC trả lỗi: ${same.map((x) => `#${x.cvatId ?? x.serverId}`).join(', ')}.`);
  });

  function annView(box) {
    const by = (...s) => P.tickets.filter((t) => s.includes(t.status));
    const tabs = { todo: by('open', 'returned'), qc: by('submitted'), done: by('accepted') };
    // Mở job: còn lỗi cần sửa thì vào "Cần sửa", không thì tab chọn lần trước.
    if (!(P.annTab in tabs)) { try { P.annTab = localStorage.getItem(ANN_TAB_KEY); } catch (_) { /* bộ nhớ trang bị chặn */ } if (tabs.todo.length || !(P.annTab in tabs)) P.annTab = 'todo'; }
    const fixed = tabs.todo.filter((t) => t.fixed).length;
    box.append(seg([['todo', 'Cần sửa', tabs.todo.length - fixed, true, 'Lỗi QC trả về chưa sửa'], ['qc', 'Chờ QC', tabs.qc.length, false, 'Đã nộp, chờ QC nghiệm thu'], ['done', 'Xong', tabs.done.length, false, 'QC đã nghiệm thu']], P.annTab,
      (k) => { P.annTab = k; try { localStorage.setItem(ANN_TAB_KEY, k); } catch (_) { /* bỏ qua */ } }, tabs));
    const list = tabs[P.annTab];
    // Sửa từng lỗi rồi đánh dấu "Đã sửa"; nộp cả vòng một lần khi mọi lỗi của vòng đã đánh dấu.
    if (P.annTab === 'todo' && list.length) {
      const round = Math.max(...list.map((t) => t.round || 1)), left = list.length - fixed;
      const btn = h('button', { class: 'ps-btn ps-pri ps-sm', text: 'Nộp tất cả', title: left ? `Còn ${left} lỗi chưa đánh dấu đã sửa` : `Nộp ${list.length} lỗi của vòng ${round} cho QC`, on: { click: submitAll } });
      btn.disabled = left > 0;
      box.append(h('div', { class: 'ps-bar' }, h('b', { class: 'ps-ell', text: `V${round} · ${fixed}/${list.length} đã sửa` }), btn));
    }
    if (!list.length) box.append(h('div', { class: 'ps-empty', text: { todo: 'Không còn lỗi nào cần sửa ở job này.', qc: 'Không có bài nào đang chờ QC.', done: 'Chưa có lỗi nào được QC nghiệm thu.' }[P.annTab] }));
    // Ô trả lời cũng là ghi chú khi đánh dấu đã sửa. Đã nộp mà QC chưa xử lý thì còn rút về sửa tiếp; nghiệm thu rồi thì khoá.
    for (const t of list) {
      box.append(ticketRow(t, (reply) => (P.annTab === 'todo' ? [h('button', { class: `ps-btn ps-sm${t.fixed ? '' : ' ps-ok'}`, text: t.fixed ? 'Sửa ghi chú' : 'Đã sửa', title: 'Đánh dấu lỗi này đã sửa (nộp cả vòng ở thanh trên)', on: { click: () => run(() => api(`/api/tickets/${t.id}/fix`, { method: 'POST', body: JSON.stringify({ text: reply.value }) })) } })]
        : P.annTab === 'qc' ? [h('button', { class: 'ps-btn ps-sm', text: 'Rút lại', title: 'Rút lại để sửa tiếp (QC chưa xử lý), rồi nộp lại cả vòng', on: { click: () => run(() => api(`/api/tickets/${t.id}/withdraw`, { method: 'POST', body: JSON.stringify({ text: reply.value }) })) } })] : [])));
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
      const btn = h('div', { class: 'ant-tabs-tab-btn', role: 'tab', tabindex: '0', title: 'PointSnap: QC và phiếu sửa lỗi', 'aria-label': 'PointSnap: QC và phiếu sửa lỗi' });
      btn.innerHTML = `${QC_ICON}<span class="ps-tab-badge" hidden></span>`;
      tab = h('div', { class: 'ant-tabs-tab ps-sidebar-tab', on: { click: () => setTab(true), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(true); } } } }, btn);
      list.insertBefore(tab, list.querySelector('.ant-tabs-ink-bar'));
      // Bấm Objects / Labels: về nội dung của CVAT.
      list.addEventListener('click', (e) => { if (e.target.closest('.ant-tabs-tab') && !e.target.closest('.ps-sidebar-tab')) setTab(false); });
    }
    if (!pane) { pane = h('div', { class: 'ps-pane', role: 'tabpanel', 'aria-label': 'PointSnap' }); tabs.querySelector('.ant-tabs-content-holder').after(pane); }
    tabs.classList.toggle('ps-tab-on', tabOn);
    tab.firstChild.setAttribute('aria-selected', String(tabOn));
    const badge = tab.querySelector('.ps-tab-badge');
    badge.hidden = !P.badge;
    badge.textContent = P.badge > 99 ? '99+' : String(P.badge || '');
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
    P.el.title = P.me ? `PointSnap · ${P.me.role === 'qc' ? 'QC' : 'Annotator'} · ${P.me.name}` : '';
    // Huy hiệu trên biểu tượng tab: phiếu đang chờ chính người xem (QC: chờ nghiệm thu; annotator: cần sửa).
    P.badge = P.tickets.filter((t) => (P.me?.role === 'qc' ? t.status === 'submitted' && !t.held : (t.status === 'open' || t.status === 'returned') && !t.fixed)).length;
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
    const act = { 1: () => run(() => qcAct('ok')), 2: () => o && returnForm(P.el.querySelector('.ps-cur'), o), 3: () => run(() => qcAct('false')), j: skip }[e.key.toLowerCase()];
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

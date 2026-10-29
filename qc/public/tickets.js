'use strict';
/*
 * Giao việc sửa lỗi (phía QC): hộp thoại tạo phiếu (từ mục tool báo hoặc object trả lỗi) và màn "Giao việc Lỗi" của một job:
 * danh sách phiếu, trao đổi, nghiệm thu đạt / trả lại sửa tiếp. Theo Figma "Chi tiết Job" và "Giao việc sửa lỗi nhãn".
 */
(function () {
  const { api, esc, toast, $, fmtTime, frameRange, ticketObj, ticketUrl: cvatUrl } = window.QC;
  const STATUS = { draft: ['Chưa gửi', 'warning'], open: ['Chờ sửa', 'warning'], submitted: ['Đã nộp lại', 'accent'], accepted: ['Đã duyệt đạt', 'ok'], returned: ['Trả lại sửa tiếp', 'error'] };
  const T = { list: [], cur: null, users: null };

  const status = (t) => (t.held ? '<span class="pill error">Trả lại · chờ gửi vòng sau</span>' : `<span class="pill ${STATUS[t.status][1]}">${STATUS[t.status][0]}</span>`);
  const prio = (t) => (t.priority === 'must' ? '<span class="pill error">Lỗi bắt buộc sửa</span>' : '<span class="pill warning">Cảnh báo</span>');

  async function badge() {
    try {
      const all = await api('/api/tickets');
      window.QC.setBadge('tickets', all.filter((t) => t.status === 'submitted').length);
    } catch (_) { /* chưa đăng nhập */ }
  }

  // ---------------------------------------------------------------- trả lỗi nhanh + gửi annotator một lượt

  const COMMON = ['Lơ lửng / lún', 'Kích thước', 'Hướng (yaw)', 'Lệch vị trí', 'Sai class', 'Thiếu thuộc tính', 'Đứt / đổi ID', 'Thiếu box ở frame'];

  /** Mở hộp thoại; `onSubmit(form)` trả về giá trị đóng hộp (lỗi thì ghi vào #m-err). Trả về giá trị đó hoặc null nếu huỷ. */
  function dialog(html, onSubmit, focus, doc = document) {
    const el = doc.querySelector('#modal');
    el.hidden = false;
    el.innerHTML = html;
    el.querySelector(focus)?.focus();
    return new Promise((resolve) => {
      const close = (v) => { el.hidden = true; el.innerHTML = ''; doc.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el.querySelector('form')?.requestSubmit(); } // lưu nhanh khi đang gõ ghi chú
      };
      doc.addEventListener('keydown', onKey);
      el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
      // Gắn vào form (mới mỗi lần mở), không gắn vào #modal: #modal dùng lại nên trình nghe sẽ cộng dồn.
      el.querySelector('form').addEventListener('click', (e) => { const b = e.target.closest('[data-tag]'); if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); });
      el.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { const v = await onSubmit(e.target); if (v) close(v); } catch (error) { el.querySelector('#m-err').textContent = error.message; }
      });
    });
  }

  /** QC ghi lỗi của một object khi duyệt (chưa gửi ai): nhãn lỗi, frame thấy lỗi, ghi chú. Trả về issue hoặc null. */
  function returnForm({ objKey, findingKey, frame, doc = document }) {
    const r = window.QC.S.detail.result, obj = r.objects.find((o) => o.key === objKey);
    const tool = r.findings.filter((x) => (x.objKey === objKey || x.other === objKey) && x.severity !== 'info');
    const f = findingKey ? r.findings.find((x) => x.key === findingKey) : null;
    const tags = [...new Set([...tool.map((x) => x.title), ...COMMON])];
    // Một cuboid có thể có nhiều lỗi: chọn sẵn mọi lỗi tool báo, QC bỏ tick lỗi nào thấy báo nhầm.
    const on = new Set(tool.map((x) => x.title));
    const html = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="m-h"><div><h2 id="m-title">Trả lỗi · ${esc(ticketObj(obj))}</h2><div class="muted">${frameRange(obj.first, obj.last)} · gom lại, gửi annotator một lượt</div></div>
        <button type="button" class="act" data-close aria-label="Đóng">✕</button></div>
      <div class="m-body">
        <div><div class="muted small">Lỗi gì${tool.length ? ' (đầu danh sách: tool báo)' : ''}</div><div class="chips tags">${tags.map((t) => `<button type="button" class="tagb" data-tag="${esc(t)}" aria-pressed="${on.has(t)}">${esc(t)}</button>`).join('')}</div></div>
        <label>Frame thấy lỗi<input name="frame" type="number" min="${obj.first}" max="${obj.last}" value="${f ? f.frames[0] : frame}"></label>
        <label>Ghi chú cho annotator<textarea name="text" rows="2" maxlength="500" placeholder="Ví dụ: đáy box cao hơn mặt đường ~30 cm">${esc(f ? f.message : '')}</textarea></label>
        <div class="err" id="m-err" role="alert"></div></div>
      <div class="m-f"><span class="muted small">Ctrl+Enter để lưu · Esc huỷ</span><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary" type="submit">✕ Trả lỗi</button></div></form>`;
    return dialog(html, (form) => {
      const picked = [...form.querySelectorAll('[data-tag][aria-pressed="true"]')].map((b) => b.dataset.tag), text = form.text.value.trim();
      if (!picked.length && !text) throw new Error('Chọn ít nhất một lỗi hoặc ghi chú');
      const fr = Number.parseInt(form.frame.value, 10);
      // Lỗi QC bấm từ danh sách đứng đầu; giữ mọi lỗi tool báo có nhãn còn được tick.
      const keep = [...(f ? [f] : []), ...tool.filter((x) => x !== f)].filter((x) => picked.includes(x.title)).map((x) => x.key);
      return { tags: picked, frame: Number.isInteger(fr) ? fr : null, text, finding: keep[0] || null, findings: keep };
    }, 'textarea', doc);
  }

  /** Gửi các object đã trả lỗi (chưa gửi) cho một annotator: mỗi object một phiếu. Trả về danh sách phiếu hoặc null. */
  async function send(jobId, objs) {
    const d = window.QC.S.detail;
    if (!T.users) T.users = await api('/api/users').catch(() => []);
    const annotators = T.users.filter((u) => u.role !== 'qc'), assignee = d.result.job.assignee;
    const line = (o) => { const is = d.objectReviews[o.key].issue; return is ? [is.tags.join(', '), is.frame != null ? `frame ${is.frame}` : '', is.text].filter(Boolean).join(' · ') : 'không ghi lỗi'; };
    const html = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="m-h"><div><h2 id="m-title">Gửi cả vòng cho annotator</h2><div class="muted">Job #${jobId} / ${esc(d.result.job.taskName)} · gửi một lần mọi lỗi chờ gửi, để đếm được số lần rework</div></div>
        <button type="button" class="act" data-close aria-label="Đóng">✕</button></div>
      <div class="m-body">
        <div class="send-list">${objs.map((o) => `<div><b>${esc(ticketObj(o))}</b> <span class="muted">${esc(line(o))}</span></div>`).join('')}
          ${d.pendingTickets ? `<div class="muted">+ ${d.pendingTickets} phiếu trả lại / thiếu vật chờ gửi</div>` : ''}</div>
        <label>Giao cho *<select name="assignee" required>${annotators.map((u) => `<option value="${esc(u.username)}"${u.username === assignee ? ' selected' : ''}>${esc(u.name)} · ${esc(u.username)}</option>`).join('')
          || '<option value="">Không có tài khoản annotator nào</option>'}</select></label>
        <div class="muted small">${assignee ? `Người làm job trên CVAT: ${esc(assignee)}` : 'Job chưa giao ai trên CVAT'} · annotator sửa trên CVAT, nộp lại, QC nghiệm thu.</div>
        <div class="err" id="m-err" role="alert"></div></div>
      <div class="m-f"><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary" type="submit">✉ Gửi</button></div></form>`;
    return dialog(html, async (form) => {
      if (!form.assignee.value) throw new Error('Chưa có annotator để giao');
      return api('/api/tickets/batch', { method: 'POST', body: JSON.stringify({ jobId, assignee: form.assignee.value }) });
    }, 'select');
  }

  /** QC ghi "thiếu vật" (vật chưa có box) theo frame + vị trí; phiếu chờ gửi cùng vòng. Trả về phiếu hoặc null. */
  async function missingForm({ frame, doc = document }) {
    const r = window.QC.S.detail.result, job = r.job;
    if (!T.users) T.users = await api('/api/users').catch(() => []);
    const annotators = T.users.filter((u) => u.role !== 'qc'), labels = [...new Set((r.objects || []).map((o) => o.label))].sort();
    const html = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="m-h"><div><h2 id="m-title">Thiếu vật · Job #${job.id}</h2><div class="muted">Vật chưa có box. Job không hoàn thành được tới khi nghiệm thu phiếu này.</div></div>
        <button type="button" class="act" data-close aria-label="Đóng">✕</button></div>
      <div class="m-body">
        <label>Class *<input name="label" list="m-labels" maxlength="60" placeholder="vd: pedestrian" required><datalist id="m-labels">${labels.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></label>
        <label>Frame thấy thiếu *<input name="frame" type="number" min="${job.start}" max="${job.stop}" value="${frame}" required></label>
        <label>Vị trí<input name="where" maxlength="200" placeholder="vd: vỉa hè bên phải, cách xe ~12 m"></label>
        <label>Ghi chú cho annotator<textarea name="text" rows="2" maxlength="500" placeholder="vd: có ở frame 4–12, bị che một phần"></textarea></label>
        <label>Giao cho *<select name="assignee" required>${annotators.map((u) => `<option value="${esc(u.username)}"${u.username === job.assignee ? ' selected' : ''}>${esc(u.name)} · ${esc(u.username)}</option>`).join('')
          || '<option value="">Không có tài khoản annotator nào</option>'}</select></label>
        <div class="err" id="m-err" role="alert"></div></div>
      <div class="m-f"><span class="muted small">Ctrl+Enter để lưu · Esc huỷ</span><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary" type="submit">Tạo phiếu thiếu vật</button></div></form>`;
    return dialog(html, (form) => {
      if (!form.label.value.trim()) throw new Error('Nhập class của vật bị thiếu');
      if (!form.assignee.value) throw new Error('Chưa có annotator để giao');
      return api('/api/tickets/missing', { method: 'POST', body: JSON.stringify({ jobId: job.id, assignee: form.assignee.value, label: form.label.value,
        frame: Number.parseInt(form.frame.value, 10), where: form.where.value, text: form.text.value }) });
    }, '[name=label]', doc);
  }

  // ---------------------------------------------------------------- màn Giao việc Lỗi

  async function open(jobId) {
    T.list = await api(`/api/tickets?job=${jobId}`);
    if (!T.list.some((t) => t.id === T.cur)) T.cur = T.list[0]?.id || null;
    render(jobId);
    badge();
  }

  function thread(t) {
    const who = (m) => (m.role === 'bot' ? 'Tool' : `${esc(m.name)} (${m.role === 'qc' ? 'QC' : 'Annotator'})`);
    const kindTxt = { assign: 'giao việc', fix: 'đã sửa', submit: 'nộp cả vòng', withdraw: 'rút lại để sửa', accept: 'nghiệm thu đạt', return: 'trả lại sửa tiếp', comment: '', tool: 'tự phát hiện' };
    return t.thread.map((m) => `<div class="msg ${m.role}"><div class="msg-h"><span class="ava">${esc((m.name || '?').slice(0, 2).toUpperCase())}</span>
      <b>${who(m)}</b>${kindTxt[m.kind] ? `<span class="muted"> · ${kindTxt[m.kind]}</span>` : ''}<span class="right muted">${fmtTime(m.at)}</span></div>
      <div>${esc(m.text) || '<span class="muted">—</span>'}</div></div>`).join('');
  }

  function render(jobId) {
    const S = window.QC.S, r = S.detail?.result, list = T.list;
    const objs = r?.objects || [], done = objs.filter((o) => { const v = S.detail.objectReviews?.[o.key]; return v && v.fingerprint === o.fingerprint; }).length;
    const n = (s) => list.filter((t) => t.status === s).length;
    const t = list.find((x) => x.id === T.cur);
    let html = `<div class="crumb">JOBS / #${jobId} / GIAO VIỆC LỖI</div>
      <div class="page-h"><div><h1>Giao việc lỗi · Job #${jobId}</h1><div class="sub">Theo dõi phiếu sửa lỗi giao cho annotator, trao đổi và nghiệm thu.</div></div>
        <div class="right muted">${n('open') + n('returned')} phiếu đang sửa · ${n('submitted')} chờ nghiệm thu · ${done}/${objs.length} object đã duyệt</div></div>
      <div class="tiles"><div class="tile"><div class="k">TIẾN ĐỘ OBJECT</div><div class="v num">${done} / ${objs.length}</div><div class="s">${objs.length ? Math.round((done / objs.length) * 100) : 0}% đã duyệt</div></div>
        <div class="tile"><div class="k">ĐANG SỬA</div><div class="v c-err num">${n('open') + n('returned')}</div><div class="s">${n('returned')} trả lại sửa tiếp</div></div>
        <div class="tile"><div class="k">CHỜ QC NGHIỆM THU</div><div class="v c-acc num">${n('submitted')}</div><div class="s">annotator đã nộp lại</div></div>
        <div class="tile"><div class="k">HOÀN THÀNH</div><div class="v c-ok num">${n('accepted')}</div><div class="s">đã duyệt đạt</div></div></div>`;
    if (!list.length) {
      $('#main').innerHTML = `${html}<div class="card"><div class="empty">Chưa có phiếu nào. Trả lỗi object khi duyệt (phím 2), rồi bấm "Gửi lỗi cho annotator" ở bước Gửi lỗi.</div></div>`;
      return;
    }
    html += `<div class="t-grid"><div class="card t-list"><div class="card-h"><h2>Phiếu trong job #${jobId}</h2><span class="pill outline">${list.length}</span></div>
      ${list.map((x) => `<button class="tcard ${x.id === T.cur ? 'on' : ''}" data-tid="${x.id}">
        <span class="tc-h"><b>#${x.id}</b>${prio(x)}<span class="right">${status(x)}</span></span>
        <span>${esc(ticketObj(x))}</span><span class="muted">${frameRange(x.frames[0], x.frames[1])} · ${esc(x.assignee)}</span>
        <span class="${x.priority === 'must' ? 'c-err' : 'c-warn'}">${esc(x.title)}</span></button>`).join('')}</div>`;
    html += t ? `<div class="card t-thread"><div class="card-h"><h2>Trao đổi</h2><span class="pill outline">#${t.id}</span><span class="right">${status(t)}</span></div>
      <div class="facts"><div><span class="muted">VẬT THỂ</span><b>${esc(ticketObj(t))}</b></div><div><span class="muted">FRAME</span><b>${t.frames[0]}–${t.frames[1]}</b></div>
        <div><span class="muted">TAG LỖI</span><b class="${t.priority === 'must' ? 'c-err' : 'c-warn'}">${esc(t.title)}</b></div><div><span class="muted">NGƯỜI SỬA</span><b>${esc(t.assignee)}</b></div></div>
      <div class="msgs">${thread(t)}</div>
      <textarea id="t-text" rows="2" placeholder="Ghi chú cho annotator (tuỳ chọn)…" aria-label="Ghi chú"></textarea>
      <div class="actions"><a class="btn" href="${esc(cvatUrl(t))}" target="pointsnap-cvat" rel="noopener">↗ Mở CVAT</a>
        <button class="btn ok" data-tact="accept" ${t.status === 'accepted' ? 'disabled' : ''}>✓ Nghiệm thu đạt</button>
        <button class="btn" data-tact="return" ${t.status === 'accepted' ? '' : ''}>✕ Trả lại sửa tiếp</button>
        <button class="btn ghost" data-tact="comment">Gửi ghi chú</button></div>
      ${t.status === 'submitted' && t.unchanged ? '<div class="banner warn"><div><b>Object trên CVAT chưa đổi so với lúc trả lỗi</b><span class="muted">Annotator có thể quên Lưu (Ctrl+S) trên CVAT. Kiểm lại trước khi nghiệm thu.</span></div></div>' : ''}
      ${t.status === 'submitted' && !t.unchanged ? '<div class="muted small">Annotator đã nộp lại và object trên CVAT đã đổi: mở CVAT kiểm bản sửa rồi nghiệm thu.</div>' : ''}</div>` : '';
    $('#main').innerHTML = `${html}</div>`;
  }

  document.addEventListener('click', async (e) => {
    if (window.QC.S.view !== 'tickets') return;
    const card = e.target.closest('[data-tid]');
    if (card) { T.cur = card.dataset.tid; render(window.QC.S.jobId); return; }
    const b = e.target.closest('[data-tact]');
    if (!b) return;
    const text = $('#t-text')?.value || '';
    if (b.dataset.tact === 'return' && !text.trim()) { toast('Ghi lý do trả lại vào ô ghi chú'); $('#t-text').focus(); return; }
    try {
      await api(`/api/tickets/${T.cur}/${b.dataset.tact}`, { method: 'POST', body: JSON.stringify({ text }) });
      toast({ accept: 'Đã nghiệm thu đạt', return: 'Đã ghi trả lại: gửi cùng vòng sau', comment: 'Đã gửi ghi chú' }[b.dataset.tact]);
      window.QC.S.detail = await api(`/api/jobs/${window.QC.S.jobId}`);
      window.QC.loadJobs();
      await open(window.QC.S.jobId);
    } catch (error) { toast(error.message); }
  });

  window.QCTickets = { returnForm, missingForm, send, open, badge };
}());

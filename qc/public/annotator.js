'use strict';
/*
 * Màn "Việc của tôi" của annotator (Figma "Annotator Workspace"): phiếu QC giao cho mình, nhóm theo job ở cột trái,
 * hàng đợi lỗi có tìm / lọc, mở CVAT đúng object, trả lời và nộp lại cho QC nghiệm thu.
 */
(function () {
  const { api, esc, toast, $, icon, classIcon, fmtTime, PAGE } = window.QC;
  const STATUS = { open: ['Cần sửa', 'error'], returned: ['Trả lại', 'error'], submitted: ['Đã nộp', 'ok'], accepted: ['Đạt', 'ok'] };
  const A = { list: [], job: null, cur: null, q: '', status: new Set(), prio: '', page: 0 };

  const cvatUrl = (t) => `${window.QC.S.status?.cvatUrl || ''}/tasks/${t.taskId}/jobs/${t.jobId}?frame=${t.frames[0]}&type=${t.kind}&serverID=${t.serverId}`;
  const qcNote = (t) => [...t.thread].reverse().find((m) => m.role === 'qc' && m.text)?.text || t.message || '';
  const canSubmit = (t) => t.status === 'open' || t.status === 'returned';
  const mine = () => A.list.filter((t) => t.jobId === A.job);

  async function open() {
    A.list = await api('/api/tickets');
    const jobs = [...new Set(A.list.map((t) => t.jobId))];
    if (!jobs.includes(A.job)) A.job = jobs[0] ?? null;
    if (!mine().some((t) => t.id === A.cur)) A.cur = (mine().find(canSubmit) || mine()[0])?.id || null;
    window.QC.setBadge('mine', A.list.filter(canSubmit).length);
    side();
    render();
  }

  function side() {
    const q = $('#job-filter').value.trim().toLowerCase();
    const jobs = [...new Map(A.list.map((t) => [t.jobId, t])).values()];
    $('#job-count').textContent = `${String(jobs.length).padStart(2, '0')} JOB`;
    $('#job-list').innerHTML = jobs.filter((t) => !q || `${t.jobId} ${t.taskName}`.toLowerCase().includes(q)).map((t) => {
      const todo = A.list.filter((x) => x.jobId === t.jobId && canSubmit(x)).length;
      return `<li><button class="job ${t.jobId === A.job ? 'active' : ''}" data-ajob="${t.jobId}">
        <span class="j-top">Job #${t.jobId}${t.jobId === A.job ? '<span class="j-sel">ĐANG CHỌN</span>' : ''}</span>
        <span class="j-name">${esc(t.taskName)}</span>
        <span class="${todo ? 'c-err' : 'c-ok'}"><span class="dot ${todo ? 'error' : 'ok'}"></span> ${todo ? `${todo} lỗi chưa nộp` : 'đã nộp hết'}</span></button></li>`;
    }).join('') || '<li class="muted">Chưa có phiếu nào giao cho bạn.</li>';
    $('#session').innerHTML = `<div class="sync"><span class="dot ok"></span>Đã đồng bộ · ${new Date().toLocaleTimeString('vi-VN')}</div>`;
  }

  function filtered() {
    const q = A.q.toLowerCase();
    return mine().filter((t) => (!A.status.size || A.status.has(t.status)) && (!A.prio || t.priority === A.prio)
      && (!q || `${t.id} ${t.label} ${t.cvatId} ${t.title} ${t.frames.join(' ')}`.toLowerCase().includes(q)));
  }

  function render() {
    const me = window.QC.S.me, list = mine(), t = list.find((x) => x.id === A.cur);
    const n = (...s) => list.filter((x) => s.includes(x.status)).length;
    const head = `<div class="crumb">KHÔNG GIAN CỦA BẠN</div>
      <div class="page-h"><div><h1>Xin chào ${esc(me.name)}</h1>
        <div class="sub">${A.job ? `Job #${A.job} · ${list.length} lỗi được giao · ${list.filter((x) => x.priority === 'must' && canSubmit(x)).length} lỗi ưu tiên cao · ${n('submitted')} lỗi chờ QC` : 'Chưa có lỗi nào được giao.'}</div></div>
        ${t ? `<div class="right"><a class="btn" href="${esc(cvatUrl(t))}" target="pointsnap-cvat" rel="noopener">↗ Mở CVAT</a></div>` : ''}</div>`;
    if (!A.job) { $('#main').innerHTML = `${head}<div class="card"><div class="empty">QC chưa giao phiếu sửa lỗi nào cho bạn.</div></div>`; return; }
    const pct = (k) => (list.length ? Math.round((k / list.length) * 100) : 0);
    const tiles = `<div class="tiles">
      <div class="tile"><div class="k">TỔNG LỖI</div><div class="v num">${list.length}</div><div class="s">${n('open', 'returned')} chưa nộp</div></div>
      <div class="tile"><div class="k">ĐÃ SỬA</div><div class="v num c-ok">${n('submitted', 'accepted')}</div><div class="s">${pct(n('submitted', 'accepted'))}% lỗi đã nộp lại</div></div>
      <div class="tile"><div class="k">CHỜ QC</div><div class="v num c-warn">${n('submitted')}</div><div class="s">${pct(n('submitted'))}% đang chờ kiểm tra</div></div>
      <div class="tile"><div class="k">TRẢ LẠI</div><div class="v num c-err">${n('returned')}</div><div class="s">${pct(n('returned'))}% lỗi cần sửa lại</div></div></div>`;

    const rows = filtered(), pages = Math.max(1, Math.ceil(rows.length / PAGE));
    A.page = Math.min(A.page, pages - 1);
    const shown = rows.slice(A.page * PAGE, (A.page + 1) * PAGE);
    const queue = `<div class="card"><div class="card-h"><h2>Hàng đợi lỗi</h2><span class="pill outline">${list.length} lỗi</span><span class="right muted">Trang ${A.page + 1} / ${pages}</span></div>
      <div class="tbl-tools"><label class="search grow">${icon('search')}<input data-afilter="q" type="search" value="${esc(A.q)}" placeholder="Tìm theo ID lỗi, class, frame hoặc lỗi" aria-label="Tìm lỗi"></label>
        <select data-afilter="prio" aria-label="Ưu tiên"><option value="">Mọi mức ưu tiên</option><option value="must"${A.prio === 'must' ? ' selected' : ''}>Ưu tiên cao</option><option value="warn"${A.prio === 'warn' ? ' selected' : ''}>Cảnh báo</option></select></div>
      <div class="tbl-wrap"><table class="a-tbl"><thead><tr><th>Lỗi</th><th>Đối tượng</th><th>Frame</th><th>Trạng thái</th><th>Ghi chú QC</th><th>Hành động</th></tr></thead><tbody>
      ${shown.map((x) => `<tr class="${x.id === A.cur ? 'cur' : ''}" data-aid="${x.id}">
        <td><span class="a-id ${x.priority === 'must' ? 'c-err' : 'c-warn'}"><b>${esc(x.id)}</b>${esc(x.title)}</span></td>
        <td><span class="obj">${icon(classIcon(x.label))}<b>${esc(x.label)} #${x.cvatId ?? x.serverId}</b></span></td>
        <td class="num">${x.frames[0]}–${x.frames[1]}</td>
        <td><span class="pill ${STATUS[x.status][1]}">${STATUS[x.status][0]}</span></td>
        <td class="muted a-note">${esc(qcNote(x))}</td>
        <td class="ops"><a class="btn sm" href="${esc(cvatUrl(x))}" target="pointsnap-cvat" rel="noopener">CVAT</a>
          <button class="btn sm" data-asubmit="${x.id}" ${canSubmit(x) ? '' : 'disabled'}>${canSubmit(x) ? 'Nộp' : 'Đã nộp'}</button></td></tr>`).join('')
        || '<tr><td colspan="6" class="muted">Không có lỗi khớp bộ lọc.</td></tr>'}
      </tbody></table></div>
      <div class="pager"><span class="muted">Hiển thị ${rows.length ? A.page * PAGE + 1 : 0}–${A.page * PAGE + shown.length} / ${rows.length} lỗi</span>
        <span class="pg"><button class="btn sm" data-apage="${A.page - 1}" ${A.page ? '' : 'disabled'}>Trước</button><button class="btn sm" data-apage="${A.page + 1}" ${A.page + 1 < pages ? '' : 'disabled'}>Tiếp</button></span></div></div>`;

    const cur = t ? `<div class="card"><div class="card-h"><h2>Lỗi đang mở</h2><span class="right pill outline">${esc(t.id)}</span></div>
      <div class="obj">${icon(classIcon(t.label))}<div><b>${esc(t.label)} #${t.cvatId ?? t.serverId}</b><div class="muted">Frame ${t.frames[0]}–${t.frames[1]}</div></div></div>
      <div class="chips"><span class="pill ${t.priority === 'must' ? 'error' : 'warning'}">${esc(t.title)}</span><span class="pill ${STATUS[t.status][1]}">${STATUS[t.status][0]}</span>
        <span class="pill outline">${t.priority === 'must' ? 'Ưu tiên cao' : 'Cảnh báo'}</span></div>
      <div class="a-k">TRAO ĐỔI VỚI QC</div>
      <div class="msgs">${t.thread.map((m) => `<div class="msg ${m.role}"><div class="msg-h"><b>${m.role === 'bot' ? 'Tool' : esc(m.name)}</b><span class="right muted">${fmtTime(m.at)}</span></div><div>${esc(m.text) || '<span class="muted">—</span>'}</div></div>`).join('')}</div>
      ${t.status === 'accepted' ? '<div class="muted small">QC đã nghiệm thu đạt.</div>' : `<textarea id="a-text" rows="2" maxlength="1000" placeholder="Đã sửa gì, ở frame nào…" aria-label="Phản hồi cho QC"></textarea>
      <div class="actions"><button class="btn primary" data-aact="submit" ${canSubmit(t) ? '' : 'disabled'}>Nộp lại</button><button class="btn ghost" data-aact="comment">Gửi ghi chú</button></div>`}</div>` : '';
    const counts = [['open', 'Cần sửa'], ['returned', 'Trả lại'], ['submitted', 'Đã nộp'], ['accepted', 'Đạt']];
    const filter = `<div class="card"><div class="card-h"><h2>Bộ lọc trạng thái</h2></div><div class="a-filter">
      ${counts.map(([s, l]) => `<label class="check"><input type="checkbox" data-astatus="${s}"${A.status.has(s) ? ' checked' : ''}> ${l}<span class="right muted num">${n(s)}</span></label>`).join('')}</div></div>`;
    const by = new Map();
    for (const x of list) for (const k of x.title.split(' · ')) by.set(k, { n: (by.get(k)?.n || 0) + 1, must: x.priority === 'must' });
    const dist = `<div class="card"><div class="card-h"><h2>Phân bố lỗi</h2></div><div class="a-filter">
      ${[...by].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `<div class="a-row"><span class="dot ${v.must ? 'error' : 'warning'}"></span>${esc(k)}<span class="right muted num">${v.n} lỗi</span></div>`).join('')}</div></div>`;
    const recent = list.flatMap((x) => x.thread.filter((m) => m.role === 'qc' && m.text).map((m) => ({ ...m, id: x.id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
    const feed = `<div class="card"><div class="card-h"><h2>Phản hồi gần đây</h2></div>
      ${recent.map((m) => `<div class="msg qc"><div class="msg-h"><b>${esc(m.name)}</b><span class="right muted">${fmtTime(m.at)} · ${esc(m.id)}</span></div><div>${esc(m.text)}</div></div>`).join('') || '<div class="muted">Chưa có phản hồi.</div>'}</div>`;

    $('#main').innerHTML = `${head}${tiles}<div class="a-grid"><div>${queue}</div><div>${cur}${filter}${dist}${feed}</div></div>`;
  }

  async function act(id, kind, text = '') {
    try {
      const t = await api(`/api/tickets/${id}/${kind}`, { method: 'POST', body: JSON.stringify({ text }) });
      toast(kind !== 'submit' ? 'Đã gửi ghi chú' : t.unchanged ? 'Đã nộp, nhưng object trên CVAT chưa đổi: bạn đã Lưu (Ctrl+S) chưa?' : 'Đã nộp lại cho QC');
      await open();
    } catch (error) { toast(error.message); }
  }

  document.addEventListener('click', (e) => {
    if (window.QC.S.view !== 'mine') return;
    const j = e.target.closest('[data-ajob]');
    if (j) { A.job = Number(j.dataset.ajob); A.cur = null; A.page = 0; open(); return; }
    const sub = e.target.closest('[data-asubmit]');
    if (sub) { act(sub.dataset.asubmit, 'submit'); return; }
    const b = e.target.closest('[data-aact]');
    if (b) {
      const text = $('#a-text')?.value || '';
      if (b.dataset.aact === 'comment' && !text.trim()) { $('#a-text').focus(); return; }
      act(A.cur, b.dataset.aact, text);
      return;
    }
    const pg = e.target.closest('[data-apage]');
    if (pg) { A.page = Number(pg.dataset.apage); render(); return; }
    const row = e.target.closest('[data-aid]');
    if (row && !e.target.closest('a,button')) { A.cur = row.dataset.aid; render(); }
  });
  document.addEventListener('change', (e) => {
    if (window.QC.S.view !== 'mine') return;
    const s = e.target.dataset?.astatus;
    if (s) { if (e.target.checked) A.status.add(s); else A.status.delete(s); A.page = 0; render(); }
    if (e.target.dataset?.afilter === 'prio') { A.prio = e.target.value; A.page = 0; render(); }
  });
  document.addEventListener('input', (e) => {
    if (window.QC.S.view !== 'mine') return;
    if (e.target.id === 'job-filter') side();
    if (e.target.dataset?.afilter === 'q') {
      A.q = e.target.value; A.page = 0;
      clearTimeout(A.typing);
      A.typing = setTimeout(() => { render(); const el = $('[data-afilter="q"]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 220);
    }
  });

  window.Annot = { open };
}());

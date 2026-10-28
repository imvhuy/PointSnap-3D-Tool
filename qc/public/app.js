'use strict';
/*
 * Trang QC (docs/qc-giao-dien-ke-hoach.md): Duyệt job (hàng đợi object + object đang xem, phím 1/2/3/J/K) và Tổng quan
 * (phân tích, mục tool báo, bảng mọi object). Guideline ở spec.js. Tool chỉ xếp chỗ cần xem trước; QC vẫn duyệt đủ 100% object.
 */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEV = { error: 'Lỗi', warning: 'Cảnh báo', info: 'Thông tin' };
const PRIO = { fail: ['high', 'Ưu tiên cao'], review: ['mid', 'Ưu tiên vừa'], pass: ['low', 'Ít vấn đề'] };
const PAGE = 20;
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* không lưu được */ } } };

const S = { view: 'review', status: null, jobs: [], jobId: null, detail: null, poll: null, open: new Set(), evidence: new Map(),
  filter: { sev: 'real', rule: '', frame: null, text: '', page: 0 },
  obj: { tab: 'all', only: '', label: '', text: '', page: 0, walk: null, cur: null } };

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-PointSnap-QC': '1', ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  // Hết phiên (khởi động lại dịch vụ, quá hạn): về trang đăng nhập.
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') { S.me = null; window.QCLogin.show(); }
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body, status: res.status });
  return body;
}
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), Math.max(1800, text.length * 60));
  if (S.float) paintFloat(text);
}
/** Đặt chiều rộng thanh sau khi vẽ (CSP không cho style viết trong HTML). */
function paintWidths(root = document) { for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`; }
const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '');
const frameRange = (a, b) => (a === b ? `Frame ${a}` : `Frame ${a}–${b}`);
/** Tên vật của phiếu; phiếu thiếu vật không gắn object nào. */
const ticketObj = (t) => (t.kind === 'missing' ? `${t.label} · thiếu box` : `${t.label} #${t.cvatId ?? t.serverId}`);
/** Link CVAT của phiếu; phiếu thiếu vật chỉ mở đúng frame. */
const ticketUrl = (t, frame = t.frames[0]) => `${S.status?.cvatUrl || ''}/tasks/${t.taskId}/jobs/${t.jobId}?frame=${frame}${t.kind === 'missing' ? '' : `&type=${t.kind}&serverID=${t.serverId}`}`;

function classIcon(label = '') {
  const l = label.toLowerCase();
  if (/bus/.test(l)) return 'bus';
  if (/truck|trailer|construction|van/.test(l)) return 'truck';
  if (/car|vehicle/.test(l)) return 'car';
  if (/ped|person|people/.test(l)) return 'ped';
  if (/bicycle|motorcycle|two-wheel|bike/.test(l)) return 'bike';
  if (/barrier|obstacle/.test(l)) return 'barrier';
  if (/cone/.test(l)) return 'cone';
  return 'box';
}

// ------------------------------------------------------------------ giao diện sáng / tối, người duyệt

/** Tô mọi nút .theme (đầu trang và trang đăng nhập) theo giao diện hiện tại. */
function paintTheme() {
  const t = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  for (const b of document.querySelectorAll('.theme')) {
    b.classList.toggle('is-dark', t === 'dark');
    b.setAttribute('aria-pressed', String(t === 'dark'));
  }
}
function initChrome() {
  const saved = store.get('qc-theme', '');
  if (saved) document.documentElement.dataset.theme = saved;
  paintTheme();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.theme');
    if (!b) return;
    const next = b.classList.contains('is-dark') ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('qc-theme', next);
    paintTheme();
  });
  $('#account').addEventListener('click', () => {
    const menu = $('#acct-menu'), open = menu.hidden;
    menu.hidden = !open;
    $('#account').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.acct')) { $('#acct-menu').hidden = true; $('#account').setAttribute('aria-expanded', 'false'); } });
}

// ------------------------------------------------------------------ đăng nhập, vai trò

const TABS = {
  qc: [['review', 'Duyệt job'], ['overview', 'Tổng quan'], ['tickets', 'Giao việc Lỗi'], ['spec', 'Guideline']],
  annotator: [['mine', 'Việc của tôi']],
};

/** Sau khi biết người dùng: dựng đầu trang theo vai trò rồi mở trang mặc định. */
async function start(me) {
  S.me = me;
  $('#login').hidden = true;
  for (const id of ['#top', '#layout']) $(id).hidden = false;
  $('#acct-role').textContent = me.role === 'qc' ? 'QC' : 'ANNOTATOR';
  $('#acct-name').textContent = me.name;
  $('#acct-user').textContent = `${me.name} · ${me.username}`;
  $('#tabs').innerHTML = TABS[me.role].map(([v, t]) => `<button class="tab" data-view="${v}">${esc(t)}<span class="badge" data-badge="${v}" hidden></span></button>`).join('');
  await loadStatus();
  if (me.role === 'qc') { await loadJobs(); setView('review'); window.QCTickets.badge(); } else setView('mine');
}

/** Số trên tab (phiếu chờ QC / phiếu cần sửa). */
function setBadge(view, n) {
  const el = document.querySelector(`[data-badge="${view}"]`);
  if (el) { el.hidden = !n; el.textContent = n; }
}

// ------------------------------------------------------------------ trạng thái + danh sách job

async function loadStatus() {
  try { S.status = await api('/api/status'); } catch (error) { S.status = { ok: false, error: error.message }; }
  const el = $('#status');
  el.className = `conn ${S.status.ok ? '' : 'bad'}`;
  el.textContent = S.status.ok ? `CVAT ${S.status.version} · ${S.status.user}` : 'Chưa kết nối CVAT';
  el.title = S.status.ok ? S.status.cvatUrl : S.status.error || '';
}

function renderSetup() {
  $('#main').innerHTML = `<div class="setup"><h1>Kết nối CVAT</h1>
    <ol><li>CVAT ${esc(S.status?.cvatUrl || '')} → tên tài khoản → <b>Settings</b> → <b>Access tokens</b>.</li>
    <li>Tạo token <b>Read only</b>, đặt hạn; chép giá trị (chỉ hiện một lần).</li>
    <li>Dán vào <code>CVAT_TOKEN=</code> trong <code>qc/.env.local</code>.</li>
    <li>Chạy lại <code>node qc/server.js</code>, tải lại trang.</li></ol>
    <p class="muted">Token chỉ nằm trên máy chạy dịch vụ, không xuống trình duyệt.</p></div>`;
}

async function loadJobs() {
  if (!S.status?.ok) return renderSetup();
  S.jobs = await api('/api/jobs');
  renderJobs();
  return undefined;
}

function renderJobs() {
  const q = $('#job-filter').value.trim().toLowerCase();
  const jobs = S.jobs.filter((j) => !q || `${j.id} ${j.taskName}`.toLowerCase().includes(q));
  $('#job-count').textContent = `${String(S.jobs.length).padStart(2, '0')} JOB`;
  $('#job-list').innerHTML = jobs.map((j) => {
    const running = j.run && ['queued', 'running'].includes(j.run.state);
    const l = j.last, dot = running ? 'run' : l ? PRIO[l.gate][0] : '';
    const issues = l ? l.errors + l.warnings : 0;
    const right = l ? `<span class="${l.errors ? 'c-err' : issues ? 'c-warn' : 'c-ok'}">${issues ? `${issues} lỗi/cảnh báo` : 'không có vấn đề'}</span>` : '<span>chưa quét</span>';
    const pct = l && l.objects ? Math.round((l.reviewed / l.objects) * 100) : 0;
    return `<li><button class="job ${j.id === S.jobId ? 'active' : ''}" data-job="${j.id}">
      <span class="j-top"><span class="dot ${dot}"></span>Job #${j.id}${j.id === S.jobId ? '<span class="j-sel">ĐANG CHỌN</span>' : ''}</span>
      <span class="j-name">${esc(j.taskName)}</span>
      <span class="muted">${j.frames} frame${j.assignee ? ` · ${esc(j.assignee)}` : ''}</span>
      <span class="j-meta"><span>${l ? `${l.boxes} box · ${l.objects} object` : ''}</span>${right}</span>
      ${l ? `<span class="bar ${l.done ? 'ok' : ''}" title="Đã duyệt ${l.reviewed}/${l.objects} object"><i data-w="${pct}"></i></span>` : ''}
    </button></li>`;
  }).join('') || '<li class="muted">Không có job 3D nào.</li>';
  paintWidths($('#job-list'));
  renderSession();
}

/** Cột trái, dưới danh sách job: thông tin của job đang chọn (guideline, lần quét, lỗi chưa gửi). */
function renderSession() {
  const r = S.detail?.result, unsent = r?.objects ? drafts().length : 0;
  $('#session').innerHTML = `${r ? `<h4>JOB #${S.jobId}</h4><dl>
    <dt>Guideline</dt><dd>${esc(r.spec?.name || 'Mặc định')} v${r.spec?.version || 0}</dd>
    <dt>Lần quét cuối</dt><dd>${fmtTime(r.startedAt)}</dd>
    <dt>Frame</dt><dd>${r.job.start}–${r.job.stop}</dd>
    <dt>Lỗi chưa gửi</dt><dd class="${unsent ? 'c-err' : ''}">${unsent}</dd></dl>` : ''}
    <div class="sync"><span class="dot ${S.status?.ok ? 'ok' : ''}"></span>${S.status?.ok ? `Đã đồng bộ · ${new Date().toLocaleTimeString('vi-VN')}` : 'Chưa kết nối'}</div>`;
}

// ------------------------------------------------------------------ một job

async function openJob(jobId) {
  if (S.jobId !== jobId) {
    S.filter = { sev: 'real', rule: '', frame: null, text: '', page: 0 };
    S.obj = { ...S.obj, tab: 'all', only: '', label: '', text: '', page: 0, walk: null, cur: null };
    S.open.clear();
  }
  S.jobId = jobId;
  renderJobs();
  await refreshJob();
}

async function refreshJob() {
  if (!S.jobId || S.view === 'spec') return;
  S.detail = await api(`/api/jobs/${S.jobId}`);
  render();
  const running = S.detail.run && ['queued', 'running'].includes(S.detail.run.state);
  clearTimeout(S.poll);
  if (running) S.poll = setTimeout(refreshJob, 700);
  else if (['done', 'error'].includes(S.detail.run?.state)) loadJobs();
}

const jobInfo = () => S.jobs.find((j) => j.id === S.jobId) || {};

/** Link CVAT tại frame; `only` = { kind, serverId } để CVAT lọc còn một object. Mục theo cặp mặc định không lọc. */
function cvatLink(frame, only) {
  const job = S.detail.result.job, base = `${S.status.cvatUrl}/tasks/${job.taskId}/jobs/${job.id}?frame=${frame}`;
  return only ? `${base}&type=${only.kind}&serverID=${only.serverId}` : base;
}
const num = (cvatId, serverId) => `#${cvatId ?? serverId}`;
const otherRef = (x) => ({ kind: x.other.split(':')[0], serverId: Number(x.other.split(':')[1]) });
const otherFrame = (x) => (x.rule === 'track.fragment' ? x.frames[x.frames.length - 1] : x.frames[0]);

/**
 * Trạng thái duyệt của object theo nội dung hiện tại: 'ok' | 'returned' | 'changed' (đã duyệt bản cũ) | 'rescan' (đã nghiệm
 * thu bản sửa, chờ quét lại) | null. Object đã gửi phiếu mà bị sửa là việc annotator đang làm, vẫn tính là trả lỗi.
 */
function objState(o) {
  const r = S.detail.objectReviews?.[o.key];
  if (!r) return null;
  if (r.fingerprint === o.fingerprint) return r.status;
  if (r.ticket) return r.status === 'returned' ? 'returned' : 'rescan';
  return 'changed';
}

function headActions(result, run) {
  const info = jobInfo(), running = run && ['queued', 'running'].includes(run.state);
  const cvat = info.taskId ? `${S.status.cvatUrl}/tasks/${info.taskId}/jobs/${S.jobId}` : null;
  return `${running ? '<button class="btn" data-act="cancel">Dừng</button>' : `<button class="btn ${result ? '' : 'primary'}" data-act="scan">${result ? 'Quét lại' : 'Quét job'}</button>`}
    ${cvat ? `<a class="btn" href="${esc(cvat)}" target="pointsnap-cvat" rel="noopener">CVAT ↗</a>` : ''}
    ${result ? `<a class="btn" href="/api/jobs/${S.jobId}/export.csv" title="Mở bằng Excel">CSV</a><a class="btn" href="/api/jobs/${S.jobId}/export.json">JSON</a>` : ''}`;
}

function notices(result, run) {
  let html = '';
  if (run && ['queued', 'running'].includes(run.state)) {
    const p = run.progress || {}, pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    html += `<div class="progress">${esc(p.phase || 'Đang chờ')}${p.total ? ` · ${p.done}/${p.total} frame` : ''}<div class="bar"><i data-w="${pct}"></i></div></div>`;
  }
  if (run?.state === 'error') html += `<div class="banner err">Lần quét vừa rồi lỗi: ${esc(run.error)}</div>`;
  const now = S.detail.specNow, used = result?.spec;
  if (result && now && used && (now.version !== (used.version || 0) || (now.project ?? null) !== (used.project ?? null))) {
    html += `<div class="banner"><div><b>Guideline đã đổi sau lần quét này</b><span class="muted">${esc(used.name || 'Mặc định')} v${used.version || 0} → ${esc(now.name)} v${now.version}</span></div>
      <button class="btn sm primary" data-act="scan">Quét lại</button></div>`;
  }
  return html;
}

function pageHead(crumb, title, sub, result, run) {
  return `<div class="crumb">JOBS / #${S.jobId} / ${crumb}</div>
    <div class="page-h"><div><h1>${title}</h1><div class="sub">${sub}</div></div><div class="right">${headActions(result, run)}</div></div>${notices(result, run)}`;
}

// ------------------------------------------------------------------ màn Duyệt Job

/** Khung 5 frame liền có nhiều mục nhất (để gắn nhãn "vùng lỗi cao"). */
function hotWindow(score, start, stop) {
  let best = null;
  for (let a = start; a <= stop; a += 1) {
    const b = Math.min(stop, a + 4);
    let s = 0;
    for (let f = a; f <= b; f += 1) s += score(f);
    if (s && (!best || s > best.s)) best = { a, b, s };
  }
  return best;
}

function heatHtml(result) {
  const { start, stop } = result.job, err = new Map(), warn = new Map();
  for (const f of result.findings) {
    if (f.severity === 'info') continue;
    const m = f.severity === 'error' ? err : warn;
    for (const fr of f.frames) m.set(fr, (m.get(fr) || 0) + 1);
  }
  const common = new Set((result.coverage.commonFrames || []).map((x) => x.frame));
  const score = (fr) => 2 * (err.get(fr) || 0) + (warn.get(fr) || 0);
  let max = 1;
  for (let fr = start; fr <= stop; fr += 1) max = Math.max(max, score(fr));
  const cells = [], labels = [], n = stop - start + 1, every = n <= 60 ? 1 : Math.ceil(n / 20);
  for (let fr = start; fr <= stop; fr += 1) {
    const lv = score(fr) ? Math.ceil((4 * score(fr)) / max) : 0;
    cells.push(`<button class="${lv ? `l${lv}` : ''}${S.filter.frame === fr ? ' sel' : ''}${common.has(fr) ? ' common' : ''}" data-frame="${fr}"
      title="Frame ${fr}: ${err.get(fr) || 0} lỗi, ${warn.get(fr) || 0} cảnh báo" aria-label="Frame ${fr}"></button>`);
    labels.push(`<span class="${(fr - start) % 5 ? '' : 'm5'}">${(fr - start) % every === 0 ? fr : ''}</span>`);
  }
  const hot = hotWindow(score, start, stop);
  return `<div class="card"><div class="card-h"><div><h2>Mật độ lỗi theo frame</h2><div class="hint">Chọn ô frame để lọc danh sách · ${n} frame (${start}–${stop})</div></div>
    <div class="right">${S.filter.frame !== null ? `<button class="pill accent" data-act="clear-frame">frame ${S.filter.frame} ✕</button>` : ''}
    ${hot ? `<span class="pill warning">Frame ${hot.a}–${hot.b} · vùng lỗi cao</span>` : ''}</div></div>
    <div class="heat ${n > 60 ? 'dense' : ''}">${cells.join('')}</div><div class="heat-ax">${labels.join('')}</div>
    <div class="heat-foot"><span>${esc(result.job.taskName)} / Frame ${start}–${stop}</span>
    <span class="legend">Ít lỗi <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> Nhiều lỗi</span></div></div>`;
}

function rulesHtml(result) {
  const rows = result.summary.perRule;
  if (!rows.length) return '<div class="card"><div class="card-h"><h2>Phân bố theo quy tắc</h2></div><div class="muted">Tool không tự phát hiện vấn đề nào. QC vẫn duyệt hết object.</div></div>';
  const by = (rule, sev) => result.findings.filter((f) => f.rule === rule && f.severity === sev).length;
  const max = Math.max(...rows.map((r) => r.groups));
  const twice = (t) => rows.filter((r) => r.title === t).length > 1;
  return `<div class="card"><div class="card-h"><h2>Phân bố theo quy tắc</h2><span class="right hint">${result.findings.length} phát hiện · ${rows.length} quy tắc</span></div><div class="rules">
    ${rows.map((r) => {
      const e = by(r.rule, 'error'), w = by(r.rule, 'warning'), i = by(r.rule, 'info'), wd = (x) => Math.round((x / max) * 100);
      // Độ chính xác của luật theo kết luận của QC (PP-18): bao nhiêu mục là lỗi thật, bao nhiêu báo nhầm.
      const v = (x) => result.findings.filter((f) => f.rule === r.rule && S.detail.reviews[f.key]?.verdict === x).length, ok = v('confirmed'), bad = v('false_alarm');
      return `<button class="rule ${S.filter.rule === r.rule ? 'sel' : ''}" data-rule="${esc(r.rule)}" title="${esc(r.rule)}">
        <span class="t">${esc(r.title)}${twice(r.title) ? ` <span class="muted">${esc(r.rule)}</span>` : ''}${ok + bad ? `<span class="prec" title="Theo kết luận của QC">${ok} lỗi thật · ${bad} báo nhầm · đúng ${Math.round((ok / (ok + bad)) * 100)}%</span>` : ''}</span>
        <span class="split">${e ? `<i class="e" data-w="${wd(e)}"></i>` : ''}${w ? `<i class="w" data-w="${wd(w)}"></i>` : ''}${i ? `<i class="n" data-w="${wd(i)}"></i>` : ''}</span>
        <span class="n">${r.groups}</span></button>`;
    }).join('')}</div></div>`;
}

function scopeHtml(result) {
  const s = result.summary, c = result.coverage, blindCount = (result.objects || []).filter(blind).length;
  return `<div class="card scope"><div class="card-h"><h2>Phạm vi kiểm tra</h2></div><dl>
    <div><dt>Dữ liệu</dt><dd>${s.boxes} box / ${(result.objects || []).length} object / ${s.frames} frame</dd></div>
    <div><dt>Quy tắc đã chạy</dt><dd>Mặt đất · Kích thước · Hướng · Chồng lấn · Spec · Track (đứt, đổi ID, nhảy, trùng)${c.disabledRules?.length ? ` · tắt ${c.disabledRules.length} luật` : ''}</dd></div>
    <div><dt>Tool không kiểm — QC tự xem</dt><dd><div class="chips">${c.notChecked.map((x) => `<span class="pill outline">${esc(x)}</span>`).join('')}</div></dd></div>
    <div><dt>Tool không đo được</dt><dd>${c.boxesWithoutGround} box không đo được mặt đất${c.framesWithoutPoints.length ? ` · ${c.framesWithoutPoints.length} frame thiếu point cloud` : ''}
      ${blindCount ? `<br><button class="lnk" data-goto="blind">${blindCount} object cần xem tay ›</button>` : ''}</dd></div>
    <div><dt>Kết quả</dt><dd>${s.errorGroups} lỗi · ${s.warningGroups} cảnh báo</dd></div></dl></div>`;
}

function findingsHtml(result, reviews) {
  const f = S.filter, all = result.findings;
  const bySev = (x) => (f.sev === 'all' || (f.sev === 'real' ? x.severity !== 'info' : x.severity === f.sev));
  const rest = (x) => (!f.rule || x.rule === f.rule) && (f.frame === null || x.frames.includes(f.frame))
    && (!f.text || `${x.title} ${x.short} ${x.message} ${x.label} ${x.otherLabel || ''} #${x.cvatId} #${x.otherCvatId}`.toLowerCase().includes(f.text.toLowerCase()));
  const shown = all.filter((x) => bySev(x) && rest(x));
  const count = (sev) => all.filter((x) => rest(x) && x.severity === sev).length;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE)), page = Math.min(f.page, pages - 1);
  const rows = shown.slice(page * PAGE, page * PAGE + PAGE).map((x) => {
    const r = reviews[x.key]?.verdict, open = S.open.has(x.key);
    const me = num(x.cvatId, x.serverId), them = x.other && num(x.otherCvatId, otherRef(x).serverId);
    const short = x.other ? x.short.replace(/ (lên|với) \S+ #\S+$/, '') : x.short;
    const openTitle = x.other ? `Mở frame trong CVAT, hiện mọi object: tìm ${me} và ${them} trong danh sách Objects` : `Mở trong CVAT, chỉ hiện ${me}`;
    let html = `<tr class="${r ? 'done' : ''}">
      <td><span class="obj"><span class="dot ${x.severity}"></span><span><b>${esc(x.label)} ${esc(me)}</b>${x.other ? `<span class="with">↔ ${esc(x.otherLabel || '')} ${esc(them)}</span>` : ''}</span></span></td>
      <td class="what" data-toggle="${esc(x.key)}" title="Bấm để xem chi tiết"><b>${esc(x.title)}</b> <span class="muted">· ${esc(short)}</span></td>
      <td class="num">${x.frames.length} frame<span class="two">${frameRange(x.frames[0], x.frames[x.frames.length - 1])}</span></td>
      <td>${r === 'confirmed' ? '<span class="st ret">● Lỗi thật</span>' : r === 'false_alarm' ? '<span class="st none">○ Báo nhầm</span>' : '<span class="faint">—</span>'}</td>
      <td><span class="ops"><a class="lnk" href="${esc(cvatLink(x.frames[0], x.other ? null : x))}" target="pointsnap-cvat" rel="noopener" title="${esc(openTitle)}">Mở CVAT ↗</a>
        <button class="btn sm" data-assign="${esc(x.objKey)}" data-finding="${esc(x.key)}" title="Lỗi thật: ghi lỗi cho object này, gửi annotator một lượt ở bước Gửi lỗi">Trả lỗi</button>
        <button class="btn sm ghost ${r === 'false_alarm' ? 'on' : ''}" data-verdict="false_alarm" data-key="${esc(x.key)}" aria-pressed="${r === 'false_alarm'}" title="Tool báo nhầm: không phải lỗi">Báo nhầm</button></span></td></tr>`;
    if (open) {
      html += `<tr class="more"><td></td><td colspan="4"><div class="detail">${esc(x.message)}</div>
        ${x.other ? `<div class="solo">Chỉ hiện một object: <a href="${esc(cvatLink(x.frames[0], x))}" target="pointsnap-cvat" rel="noopener">${esc(x.label)} ${esc(me)} · frame ${x.frames[0]} ↗</a>
          <a href="${esc(cvatLink(otherFrame(x), otherRef(x)))}" target="pointsnap-cvat" rel="noopener">${esc(x.otherLabel || '')} ${esc(them)} · frame ${otherFrame(x)} ↗</a></div>` : ''}
        ${x.rule === 'track.fragment' ? evidenceHtml(x) : ''}
        <div class="frames">${x.frames.slice(0, 120).map((fr) => `<a href="${esc(cvatLink(fr, x.other ? null : x))}" target="pointsnap-cvat" rel="noopener">${fr}</a>`).join('')}${x.frames.length > 120 ? ' …' : ''}</div></td></tr>`;
    }
    return html;
  }).join('');
  const ruleChip = f.rule ? `<button class="pill accent" data-act="clear-rule">${esc(all.find((x) => x.rule === f.rule)?.title || f.rule)} ✕</button>` : '';
  return `<div class="card"><div class="card-h"><h2>Danh sách lỗi &amp; cảnh báo</h2>
      <button class="lnk c-err" data-sev="error">Lỗi (${count('error')})</button><button class="lnk c-warn" data-sev="warning">Cảnh báo (${count('warning')})</button>
      <button class="lnk" data-sev="real">Cả hai</button><button class="lnk muted" data-sev="info">Thông tin (${count('info')})</button>
      <span class="right tbl-tools">${ruleChip}<input type="search" data-filter="text" placeholder="Tìm mã CVAT / class…" value="${esc(f.text)}" aria-label="Tìm"></span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Đối tượng</th><th>Mô tả lỗi</th><th>Frame vi phạm</th><th>QC kết luận</th><th>Thao tác</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">Không có mục nào.</td></tr>'}</tbody></table></div>
    ${pager(page, pages, shown.length, 'mục', 'f-page')}</div>`;
}

function pager(page, pages, total, unit, act) {
  const from = total ? page * PAGE + 1 : 0, to = Math.min(total, (page + 1) * PAGE);
  const btns = [];
  for (let i = 0; i < pages; i += 1) if (pages <= 9 || i < 2 || i >= pages - 2 || Math.abs(i - page) <= 1) btns.push(i); else if (btns.at(-1) !== '…') btns.push('…');
  return `<div class="pager"><span>Hiển thị ${from}–${to} / ${total} ${unit}</span><span class="pg">${pages > 1 ? btns.map((i) => (i === '…' ? '<span>…</span>'
    : `<button class="${i === page ? 'on' : ''}" data-${act}="${i}" aria-label="Trang ${i + 1}">${i + 1}</button>`)).join('') : ''}</span></div>`;
}

// ------------------------------------------------------------------ hàng đợi object, thanh bước (dùng chung hai màn)

/** Thứ tự xem: có lỗi, có cảnh báo, tool không kiểm được, còn lại; rồi theo frame. */
/**
 * Lỗi / cảnh báo tool báo còn hiệu lực của object: bỏ mục QC đã ghi Báo nhầm (kết luận gắn với object + luật nên quét lại vẫn
 * giữ), để mục báo nhầm không đẩy object lên đầu hàng đợi nữa. Tính lại khi danh sách kết luận đổi.
 */
function live(o) {
  const d = S.detail;
  if (d.liveOf !== d.reviews) {
    d.liveOf = d.reviews;
    d.live = new Map();
    for (const f of d.result.findings) {
      if (f.severity === 'info' || d.reviews[f.key]?.verdict === 'false_alarm') continue;
      for (const k of [f.objKey, f.other].filter(Boolean)) {
        const c = d.live.get(k) || { errors: 0, warnings: 0 };
        c[f.severity === 'error' ? 'errors' : 'warnings'] += 1;
        d.live.set(k, c);
      }
    }
  }
  return d.live.get(o.key) || { errors: 0, warnings: 0 };
}
const rank = (o) => { const l = live(o); return l.errors ? 0 : l.warnings ? 1 : blind(o) ? 2 : 3; };
const byRank = (a, b) => rank(a) - rank(b) || a.first - b.first || (a.cvatId ?? 0) - (b.cvatId ?? 0);
/** Hàng đợi duyệt: object chưa duyệt (hoặc bị sửa sau khi duyệt), theo `byRank`. */
function queue(objs) {
  return objs.filter((o) => !['ok', 'returned', 'rescan'].includes(objState(o))).sort(byRank);
}
/** Tool không kiểm được object này: không đo được mặt đất ở quá nửa số box, hoặc có frame thiếu point cloud. */
const blind = (o) => o.noPoints > 0 || o.noGround >= o.boxes / 2;
/** Frame nên mở cho object: frame đầu của mục tool báo nặng nhất, không thì frame đầu của object. */
function focusFrame(o) {
  const f = S.detail.result.findings.find((x) => (x.objKey === o.key || x.other === o.key) && x.severity !== 'info');
  return f ? f.frames[0] : o.first;
}
const objLink = (o) => cvatLink(focusFrame(o), o);

function objectRows(objs) {
  const o = S.obj;
  const st = (x) => objState(x);
  const tabs = [
    ['all', 'Tất cả', () => true],
    ['todo', 'Cần xem', (x) => !['ok', 'returned'].includes(st(x))],
    ['issues', 'Có vấn đề', (x) => live(x).errors || live(x).warnings],
    ['done', 'Đã duyệt', (x) => ['ok', 'returned'].includes(st(x))],
    ['changed', 'Bị sửa sau khi duyệt', (x) => st(x) === 'changed'],
  ];
  // Bộ lọc phụ, chồng lên tab: "chưa kiểm được" và "đứng yên chưa xem" (để duyệt nhanh cả nhóm).
  const onlys = [
    ['blind', 'Tool chưa kiểm được', blind],
    ['static', 'Đứng yên chưa xem', (x) => x.static && !live(x).errors && !live(x).warnings && !['ok', 'returned'].includes(st(x))],
    ...(S.detail.prev ? [['diff', 'Đổi so với lần quét trước', (x) => S.detail.prev.objects[x.key]?.fingerprint !== x.fingerprint]] : []),
  ];
  const tabFn = (tabs.find((t) => t[0] === o.tab) || tabs[0])[2], onlyFn = onlys.find((t) => t[0] === o.only)?.[2] || (() => true);
  const match = (x) => onlyFn(x) && (!o.label || x.label === o.label) && (!o.text || `${x.label} #${x.cvatId}`.toLowerCase().includes(o.text.toLowerCase()));
  return { tabs: tabs.filter(([k, , fn]) => k === 'all' || k === o.tab || objs.some(fn)).map(([k, t, fn]) => [k, t, objs.filter((x) => fn(x) && match(x)).length]),
    onlys: onlys.filter(([k, , fn]) => k === o.only || objs.some(fn)).map(([k, t, fn]) => [k, t, objs.filter(fn).length]),
    rows: objs.filter((x) => tabFn(x) && match(x)) };
}

/** Ô lọc dùng chung: tìm, class, tab trạng thái, bộ lọc phụ, nút duyệt nhanh nhóm đứng yên. */
function filtersHtml(objs, rows, { compact = false } = {}) {
  const { tabs, onlys } = objectRows(objs), o = S.obj, labels = [...new Set(objs.map((x) => x.label))].sort();
  const bulk = o.only === 'static' && rows.length ? `<button class="btn sm ok" data-act="bulk-ok" title="Chỉ bấm khi đã xem nhóm này trên CVAT">✓ Đạt cả ${rows.length} vật đang hiện</button>` : '';
  const tools = `<input type="search" data-ofilter="text" placeholder="Tìm mã CVAT / class…" value="${esc(o.text)}" aria-label="Tìm object">
    <select data-ofilter="label" aria-label="Class"><option value="">Class: Tất cả</option>${labels.map((l) => `<option value="${esc(l)}"${l === o.label ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const tabBtns = tabs.map(([k, t, n]) => `<button class="${compact ? `pill ${o.tab === k ? 'accent' : 'outline'}` : `subtab ${o.tab === k ? 'on' : ''}`}" data-objtab="${k}" aria-pressed="${o.tab === k}">${t} (${n})</button>`).join('');
  const onlyBtns = onlys.map(([k, t, n]) => `<button class="pill ${o.only === k ? 'accent' : 'outline'}" data-only="${k}" aria-pressed="${o.only === k}">${t} · ${n}${o.only === k ? ' ✕' : ''}</button>`).join('');
  return { tools, tabBtns, onlyBtns, bulk };
}

/** Đếm theo trạng thái duyệt: dùng cho thanh bước và nút chính. */
function jobSteps(result) {
  const objs = result.objects, st = objs.map(objState), rev = S.detail.objectReviews || {};
  const reviewed = st.filter((s) => s === 'ok' || s === 'returned').length, full = reviewed === objs.length;
  const missing = (S.detail.missing || []).filter((t) => t.status !== 'accepted').length;
  const sendN = drafts().length, waiting = objs.filter((o, i) => st[i] === 'returned' && rev[o.key]?.ticket).length + missing;
  const rescan = st.filter((s) => s === 'rescan').length, changed = st.filter((s) => s === 'changed').length, comp = S.detail.completion;
  const anyErr = st.some((s) => s === 'returned' || s === 'rescan');
  const cur = sendN ? 'send' : !full ? 'review' : waiting ? 'wait' : rescan ? 'rescan' : 'done';
  return { objs, reviewed, full, sendN, waiting, rescan, changed, comp, anyErr, cur };
}

/** Thanh bước Quét → Duyệt → Gửi lỗi → Chờ sửa → Quét lại → Hoàn thành, với đúng một nút chính cho bước hiện tại. */
function stepsHtml(result) {
  const j = jobSteps(result), order = ['scan', 'review', 'send', 'wait', 'rescan', 'done'], at = order.indexOf(j.cur);
  const steps = [
    ['scan', 'Quét', fmtTime(result.startedAt)],
    ['review', 'Duyệt', `${j.reviewed}/${j.objs.length} object`],
    ['send', 'Gửi lỗi', j.sendN ? `${j.sendN} chờ gửi` : j.anyErr ? 'đã gửi' : 'chưa có lỗi'],
    ['wait', 'Chờ sửa', j.waiting ? `${j.waiting} phiếu` : '—'],
    ['rescan', 'Quét lại', j.rescan ? `${j.rescan} object đã sửa` : '—'],
    ['done', 'Hoàn thành', j.comp ? fmtTime(j.comp.at) : ''],
  ];
  const state = (k, i) => (k === 'done' && j.comp ? 'done' : i < at ? 'done' : i === at ? 'cur' : 'todo');
  const pct = j.objs.length ? Math.round((j.reviewed / j.objs.length) * 100) : 100;
  const main = {
    review: S.view === 'review' ? `<span class="muted">Còn ${j.objs.length - j.reviewed} object cần xem</span>` : `<button class="btn primary" data-view-go="review">${icon('play')} Duyệt object tiếp</button>`,
    send: `<button class="btn primary" data-act="send">✉ Gửi ${j.sendN} lỗi cho annotator</button>`,
    wait: '<button class="btn primary" data-view-go="tickets">Mở Giao việc Lỗi ›</button>',
    rescan: `<button class="btn primary" data-act="scan" title="Bản sửa đã nghiệm thu; quét lại để tool kiểm bản mới">⟳ Quét lại ${j.rescan} object đã sửa</button>`,
    done: j.comp ? '<button class="btn sm ghost" data-act="complete">Hoàn thành lại</button>' : '<button class="btn primary ok-bg" data-act="complete" title="Cần gửi hết lỗi và nghiệm thu hết phiếu sửa">✓ Hoàn thành duyệt job</button>',
  }[j.cur];
  return `<div class="steps"><ol>${steps.map(([k, t, s], i) => `<li class="${state(k, i)}"><span class="n">${state(k, i) === 'done' ? '✓' : i + 1}</span><span><b>${t}</b><small>${s}</small></span></li>`).join('')}</ol>
    <div class="steps-act">${main}${j.changed ? `<button class="btn sm ghost warnc" data-objtab="changed">⚠ ${j.changed} object bị sửa, duyệt lại</button>` : ''}
      <button class="btn sm ghost" data-act="missing" title="Vật chưa có box: ghi theo frame + vị trí (phím N)">+ Thiếu vật</button></div>
    <div class="bar ${j.full ? 'ok' : ''}"><i data-w="${pct}"></i></div></div>`;
}

const noResult = (html) => { $('#main').innerHTML = `${html}<div class="empty">Chưa quét. Bấm <b>Quét job</b>.</div>`; paintWidths(); };
const oldResult = (html) => { $('#main').innerHTML = `${html}<div class="banner"><div><b>Kết quả quét cũ chưa có danh sách object</b><span class="muted">Quét lại để duyệt theo object.</span></div><button class="btn sm primary" data-act="scan">Quét lại</button></div>`; };
const keepSearch = () => document.activeElement?.dataset?.ofilter || document.activeElement?.dataset?.filter;
function restoreSearch(keep) {
  const el = keep && $(`[data-ofilter="${keep}"],[data-filter="${keep}"]`);
  if (el && el.type === 'search') { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

// ------------------------------------------------------------------ màn Duyệt job: hàng đợi trái, object đang xem phải

const STATE_MARK = { ok: '<span class="st ok" title="Đạt">✓</span>', returned: '<span class="st ret" title="Trả lỗi">✕</span>',
  changed: '<span class="st chg" title="Bị sửa sau khi duyệt">⚠</span>', rescan: '<span class="st ok" title="Đã nghiệm thu, chờ quét lại">⟳</span>' };

function renderReview() {
  const { run, result } = S.detail, info = jobInfo();
  const sub = result ? `${esc(result.job.taskName)} · ${result.summary.boxes} box · ${(result.objects || []).length} object` : `${esc(info.taskName || '')} · ${info.frames || '?'} frame`;
  const html = pageHead('DUYỆT TỪNG OBJECT', 'Duyệt job', sub, result, run);
  if (!result) return noResult(html);
  if (!result.objects) return oldResult(html);
  const objs = result.objects;
  if (!objs.some((x) => x.key === S.obj.cur)) S.obj.cur = (queue(objs)[0] || objs[0])?.key || null;
  S.obj.walk = S.obj.walk || { history: [] }; // màn này luôn ở chế độ duyệt lần lượt (phím 1/2/3/J/K)
  const keep = keepSearch();
  $('#main').innerHTML = `${html}${stepsHtml(result)}<div class="rv">${queueHtml(objs)}${detailHtml(objs)}</div>`;
  paintWidths();
  restoreSearch(keep);
  // Chỉ cuộn trong hàng đợi để object đang xem hiện ra; scrollIntoView sẽ cuộn cả trang.
  const list = $('.q-list'), it = list?.querySelector('.cur');
  if (it) {
    const d = it.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (d < 0 || d > list.clientHeight - it.offsetHeight) list.scrollTop += d - list.clientHeight / 2;
  }
  return undefined;
}

function queueHtml(objs) {
  const { rows } = objectRows(objs), f = filtersHtml(objs, rows, { compact: true }), cur = S.obj.cur;
  const list = rows.slice().sort(byRank).map((x) => {
    const l = live(x), tag = l.errors ? `<span class="pill error">${l.errors} lỗi</span>` : l.warnings ? `<span class="pill warning">${l.warnings} c.báo</span>`
      : blind(x) ? '<span class="pill outline">chưa kiểm</span>' : x.static ? '<span class="pill outline">đứng yên</span>' : '';
    return `<li><button class="q-it ${x.key === cur ? 'cur' : ''}" id="o-${esc(x.key.replace(':', '-'))}" data-pick="${esc(x.key)}" aria-current="${x.key === cur}">
      ${STATE_MARK[objState(x)] || '<span class="st none" title="Chưa xem">○</span>'}${icon(classIcon(x.label))}
      <span class="q-n"><b>${esc(x.label)} #${x.cvatId ?? x.serverId}</b><small>${frameRange(x.first, x.last)}</small></span>${tag}</button></li>`;
  }).join('');
  return `<aside class="card rv-q" aria-label="Hàng đợi object"><div class="q-tools">${f.tools}</div>
    <div class="q-chips">${f.tabBtns}${f.onlyBtns}</div>${f.bulk ? `<div class="q-bulk">${f.bulk}</div>` : ''}
    <ol class="q-list">${list || '<li class="muted">Không có object nào khớp.</li>'}</ol></aside>`;
}

const SEV_ORDER = { error: 0, warning: 1, info: 2 };

function findingItem(x, o) {
  const v = S.detail.reviews[x.key]?.verdict, open = S.open.has(x.key), mine = x.objKey === o.key;
  const pair = x.other ? (mine ? `↔ ${esc(x.otherLabel || '')} #${x.otherCvatId ?? otherRef(x).serverId}` : `↔ ${esc(x.label)} #${x.cvatId ?? x.serverId}`) : '';
  const short = x.other ? x.short.replace(/ (lên|với) \S+ #\S+$/, '') : x.short;
  const me = num(x.cvatId, x.serverId), them = x.other && num(x.otherCvatId, otherRef(x).serverId);
  return `<li class="fd ${x.severity}${v === 'false_alarm' ? ' off' : ''}">
    <div class="fd-h"><span class="dot ${x.severity}"></span>
      <button class="fd-t" data-toggle="${esc(x.key)}" aria-expanded="${open}"><b>${esc(x.title)}</b> <span class="muted">· ${esc(short)} ${pair}</span></button>
      <span class="fd-fr num">${frameRange(x.frames[0], x.frames[x.frames.length - 1])}</span>
      ${v === 'confirmed' ? '<span class="st ret">● Lỗi thật</span>' : ''}
      ${x.severity !== 'info' ? `<button class="btn sm ghost ${v === 'false_alarm' ? 'on' : ''}" data-verdict="false_alarm" data-key="${esc(x.key)}" aria-pressed="${v === 'false_alarm'}" title="Tool báo nhầm mục này">${v === 'false_alarm' ? '✓ Báo nhầm' : 'Báo nhầm'}</button>` : ''}</div>
    ${open ? `<div class="fd-more"><div class="detail">${esc(x.message)}</div>
      ${x.other ? `<div class="solo">Chỉ hiện một object: <a href="${esc(cvatLink(x.frames[0], x))}" target="pointsnap-cvat" rel="noopener">${esc(x.label)} ${esc(me)} · frame ${x.frames[0]} ↗</a>
        <a href="${esc(cvatLink(otherFrame(x), otherRef(x)))}" target="pointsnap-cvat" rel="noopener">${esc(x.otherLabel || '')} ${esc(them)} · frame ${otherFrame(x)} ↗</a></div>` : ''}
      ${x.rule === 'track.fragment' ? evidenceHtml(x) : ''}
      <div class="frames">${x.frames.slice(0, 120).map((fr) => `<a href="${esc(cvatLink(fr, x.other ? null : x))}" target="pointsnap-cvat" rel="noopener">${fr}</a>`).join('')}${x.frames.length > 120 ? ' …' : ''}</div></div>` : ''}</li>`;
}

/** Vòng duyệt lại (PP-17): object khác gì lần quét trước: khoảng frame, số box, mục tool hết báo / báo mới. */
function diffHtml(o, real) {
  const pv = S.detail.prev, po = pv?.objects[o.key];
  if (!pv || (po && po.fingerprint === o.fingerprint)) return '';
  const lines = [];
  if (!po) lines.push('Object mới, lần quét trước chưa có.');
  else {
    if (po.first !== o.first || po.last !== o.last) lines.push(`Khoảng frame: ${frameRange(po.first, po.last)} → ${frameRange(o.first, o.last)}`);
    if (po.boxes !== o.boxes) lines.push(`Số box: ${po.boxes} → ${o.boxes}`);
    const was = pv.findings.filter((f) => f.objKey === o.key || f.other === o.key);
    const gone = was.filter((f) => !real.some((x) => x.key === f.key)), added = real.filter((x) => !was.some((f) => f.key === x.key));
    if (gone.length) lines.push(`Tool hết báo: ${gone.map((f) => f.title).join(', ')}`);
    if (added.length) lines.push(`Tool báo mới: ${added.map((f) => f.title).join(', ')}`);
    if (!lines.length) lines.push('Box đã đổi (vị trí, kích thước hoặc hướng); tool báo như cũ.');
  }
  return `<div class="rv-sec rv-diff"><h3>So với lần quét trước <span class="muted">${fmtTime(pv.startedAt)}</span></h3>
    <ul class="notes">${lines.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
}

function detailHtml(objs) {
  const o = objs.find((x) => x.key === S.obj.cur);
  if (!o) return '<section class="card rv-d"><div class="empty">Không có object.</div></section>';
  const s = objState(o), r = S.detail.objectReviews?.[o.key], q = queue(objs), pos = q.findIndex((x) => x.key === o.key);
  const mine = S.detail.result.findings.filter((x) => x.objKey === o.key || x.other === o.key).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const real = mine.filter((x) => x.severity !== 'info');
  const badge = { ok: '<span class="pill ok">✓ Đạt</span>', returned: '<span class="pill error">✕ Trả lỗi</span>', changed: '<span class="pill warning">⚠ Bị sửa sau khi duyệt</span>',
    rescan: '<span class="pill ok">✓ Đã nghiệm thu · chờ quét lại</span>' }[s] || '<span class="pill outline">○ Chưa xem</span>';
  const issueTxt = r?.issue ? [r.issue.tags.join(', '), r.issue.frame != null ? `frame ${r.issue.frame}` : '', r.issue.text].filter(Boolean).join(' · ') : '';
  const data = [o.far ? `Ở xa · cách xe ${Math.round(o.minRange)} m` : '',
    o.noGround ? `${o.noGround}/${o.boxes} box tool không đo được mặt đất${o.noGround >= o.boxes / 2 ? ': hãy tự xem đáy box' : ''}` : '',
    o.noPoints ? `Thiếu point cloud ở ${o.noPoints} frame` : '', o.static ? 'Đứng yên (theo toạ độ đã bù chuyển động xe thu)' : ''].filter(Boolean);
  return `<section class="card rv-d" aria-label="Object đang xem">
    <div class="rv-h"><div class="rv-t">${icon(classIcon(o.label))}<h2>${esc(o.label)} #${o.cvatId ?? o.serverId}</h2>${badge}
        <span class="muted rv-pos">${pos >= 0 ? `${pos + 1}/${q.length} cần xem` : 'đã duyệt'}</span></div>
      <div class="muted">${frameRange(o.first, o.last)} · ${o.boxes} box${r ? ` · ${esc(r.by || '—')} · ${fmtTime(r.at)}` : ''}</div>
      ${s === 'returned' || s === 'rescan' ? `<div class="rv-issue"><b>Lỗi đã ghi:</b> ${esc(issueTxt || 'không ghi chi tiết')} · ${r.ticket ? esc(r.ticket) : 'chưa gửi annotator'}</div>` : ''}</div>
    <div class="rv-sec"><h3>Tool nghi ngờ${real.length ? ` <span class="pill outline">${real.length}</span>` : ''}</h3>
      ${mine.length ? `<ul class="fds">${mine.map((x) => findingItem(x, o)).join('')}</ul>` : '<p class="muted">Tool không báo gì ở object này. QC tự xem trên CVAT.</p>'}</div>
    ${diffHtml(o, real)}
    ${data.length ? `<div class="rv-sec"><h3>Lưu ý dữ liệu</h3><ul class="notes">${data.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
    <div class="rv-keys">
      <button class="btn ok-bg" data-wk="ok"><kbd>1</kbd> Đạt</button>
      <button class="btn err-bg" data-wk="returned"><kbd>2</kbd> Trả lỗi…</button>
      ${real.length ? '<button class="btn" data-wk="false" title="Đạt, và ghi mọi mục tool báo của object này là Báo nhầm"><kbd>3</kbd> Đạt · tool báo nhầm</button>' : ''}
      <span class="sp"></span>
      <button class="btn ghost" data-wk="prev" title="Object vừa xem"><kbd>K</kbd> Lùi</button>
      <button class="btn ghost" data-wk="next" title="Bỏ qua, sang object cần xem tiếp"><kbd>J</kbd> Bỏ qua</button>
      <a class="btn" href="${esc(objLink(o))}" target="pointsnap-cvat" rel="noopener">Mở CVAT ↗</a>
      ${window.documentPictureInPicture ? '<button class="btn ghost" data-wk="float" title="Cửa sổ nhỏ luôn nằm trên CVAT">⧉ Bảng nổi</button>' : ''}</div></section>`;
}

// ------------------------------------------------------------------ màn Tổng quan: phân tích, mục tool báo, bảng mọi object

function renderOverview() {
  const { run, result, reviews } = S.detail, info = jobInfo();
  const sub = result ? `${esc(result.job.taskName)} · Lần quét cuối: ${fmtTime(result.startedAt)} · ${result.seconds} s · guideline ${esc(result.spec?.name || 'Mặc định')} v${result.spec?.version || 0}`
    : `${esc(info.taskName || '')} · ${info.frames || '?'} frame`;
  const html = pageHead('TỔNG QUAN JOB', 'Tổng quan', sub, result, run);
  if (!result) return noResult(html);
  const s = result.summary, [cls, label] = PRIO[s.gate.verdict], real = result.findings.filter((x) => x.severity !== 'info');
  const done = real.filter((x) => reviews[x.key]).length;
  const keep = keepSearch();
  $('#main').innerHTML = `${html}${result.objects ? stepsHtml(result) : ''}
    <div class="sum">
      <div class="sum-n" title="Xếp thứ tự xem, không phải kết luận"><div class="k">Ưu tiên</div><div class="v prio ${cls}">${label}</div></div>
      <div class="sum-n"><div class="k">Lỗi</div><div class="v c-err num">${s.errorGroups}</div></div>
      <div class="sum-n"><div class="k">Cảnh báo</div><div class="v c-warn num">${s.warningGroups}</div></div>
      <div class="sum-n"><div class="k">Mục tool báo đã kết luận</div><div class="v num">${done}/${real.length}</div></div></div>
    ${heatHtml(result)}<div class="grid-2">${rulesHtml(result)}${scopeHtml(result)}</div>${findingsHtml(result, reviews)}${result.objects ? objectTableHtml(result.objects) : ''}`;
  paintWidths();
  restoreSearch(keep);
  return undefined;
}

function objectTableHtml(objs) {
  const { rows } = objectRows(objs), o = S.obj, f = filtersHtml(objs, rows);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), page = Math.min(o.page, pages - 1);
  const body = rows.slice(page * PAGE, page * PAGE + PAGE).map((x) => {
    const s = objState(x), r = S.detail.objectReviews?.[x.key];
    // Một cột "Vấn đề": lỗi tool báo, rồi các lý do tool không kiểm chắc (ở xa, thiếu điểm đất, thiếu point cloud).
    const l = live(x), issue = [l.errors ? `<span class="pill error">${l.errors} lỗi</span>` : l.warnings ? `<span class="pill warning">${l.warnings} cảnh báo</span>` : '',
      x.far ? `<span class="pill outline">Ở xa · ${Math.round(x.minRange)} m</span>` : '',
      // Quá nửa số box không đo được mặt đất mới là "chưa kiểm được"; ít hơn thì chỉ ghi chú nhỏ.
      x.noGround >= x.boxes / 2 ? `<span class="pill outline" title="${x.noGround}/${x.boxes} box tool không đo được mặt đất">Thiếu điểm đất · ${x.noGround}/${x.boxes}</span>`
        : x.noGround ? `<span class="muted" title="Box tool không đo được mặt đất">${x.noGround}/${x.boxes} box không đo đất</span>` : '',
      x.noPoints ? `<span class="pill outline">Thiếu point cloud · ${x.noPoints} frame</span>` : ''].filter(Boolean).join(' ') || '<span class="faint">—</span>';
    const issueTxt = r?.issue ? [r.issue.tags.join(', '), r.issue.frame != null ? `frame ${r.issue.frame}` : '', r.issue.text].filter(Boolean).join(' · ') : '';
    const stHtml = s === 'ok' ? '<span class="st ok">✓ Đạt</span>' : s === 'returned'
      ? `<span class="st ret" title="${esc(issueTxt)}">✕ Trả lỗi</span><span class="two">${r.ticket ? esc(r.ticket) : 'chưa gửi annotator'}${issueTxt ? ` · ${esc(issueTxt.slice(0, 40))}` : ''}</span>`
      : s === 'changed' ? '<span class="st chg">⚠ Chưa xem (đã sửa)</span>'
        : s === 'rescan' ? `<span class="st ok">✓ Đã nghiệm thu</span><span class="two">${esc(r.ticket)} · quét lại để xác nhận</span>` : '<span class="st none">○ Chưa xem</span>';
    return `<tr id="o-${esc(x.key.replace(':', '-'))}">
      <td><button class="obj lnk-obj" data-pick="${esc(x.key)}" title="Duyệt object này">${icon(classIcon(x.label))}${esc(x.label)}${x.static ? ' <span class="pill outline" title="Đứng yên theo toạ độ đã bù chuyển động xe thu">đứng yên</span>' : ''}</button></td>
      <td><span class="cid">#${x.cvatId ?? x.serverId}</span></td>
      <td class="num">${frameRange(x.first, x.last)}<span class="two">${x.boxes} box</span></td>
      <td><span class="iss">${issue}</span></td>
      <td>${stHtml}${r ? `<span class="two">${esc(r.by || '—')} · ${fmtTime(r.at)}</span>` : ''}</td>
      <td><span class="ops"><a class="lnk" href="${esc(objLink(x))}" target="pointsnap-cvat" rel="noopener" title="Mở object trong CVAT">↗ CVAT</a>
        <button class="act yes ${s === 'ok' ? 'on' : ''}" data-obj="ok" data-key="${esc(x.key)}" aria-pressed="${s === 'ok'}" title="Đạt" aria-label="Đạt">✓</button>
        <button class="act no ${s === 'returned' ? 'on' : ''}" data-obj="returned" data-key="${esc(x.key)}" aria-pressed="${s === 'returned'}" title="Trả lỗi về annotator" aria-label="Trả lỗi">✕</button></span></td></tr>`;
  }).join('');
  return `<div class="card"><div class="card-h"><h2>Mọi object</h2><span class="pill outline">${objs.length}</span>
      <span class="right tbl-tools">${f.bulk}${f.tools}</span></div>
    <div class="subtabs">${f.tabBtns}${f.onlyBtns ? `<span class="onlys">${f.onlyBtns}</span>` : ''}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Class</th><th>Mã CVAT</th><th>Khoảng frame</th><th>Vấn đề</th><th>Trạng thái duyệt</th><th>Thao tác</th></tr></thead>
    <tbody>${body || '<tr><td colspan="6" class="muted">Không có object nào khớp.</td></tr>'}</tbody></table></div>
    ${pager(page, pages, rows.length, 'object', 'o-page')}</div>`;
}

/** Đưa object vào khung nhìn (đúng trang của bảng) và mở trong cửa sổ CVAT dùng chung. */
function focusObject(key, { open = true } = {}) {
  const objs = S.detail.result.objects;
  S.obj.cur = key;
  if (!key) return render();
  const o = objs.find((x) => x.key === key);
  if ((S.obj.tab !== 'all' || S.obj.only) && !objectRows(objs).rows.some((x) => x.key === key)) { S.obj.tab = 'all'; S.obj.only = ''; }
  const idx = objectRows(objs).rows.findIndex((x) => x.key === key);
  if (idx >= 0) S.obj.page = Math.floor(idx / PAGE);
  render();
  if (S.view === 'overview') $(`#o-${key.replace(':', '-')}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (open && o) window.open(objLink(o), 'pointsnap-cvat');
  return undefined;
}

async function setObjects(keys, status) {
  S.detail.objectReviews = await api(`/api/jobs/${S.jobId}/objects`, { method: 'POST', body: JSON.stringify({ keys, status }) });
}

/** Trả lỗi = ghi nhanh lỗi (nhãn, frame, ghi chú) vào object; gom lại rồi gửi annotator một lượt. Trả về true nếu đã ghi. */
async function returnObject(objKey, findingKey = null, doc = document) {
  const issue = await window.QCTickets.returnForm({ objKey, findingKey, frame: focusFrame(S.detail.result.objects.find((x) => x.key === objKey)), doc });
  if (!issue) return false;
  S.detail.objectReviews = await api(`/api/jobs/${S.jobId}/objects`, { method: 'POST', body: JSON.stringify({ keys: [objKey], status: 'returned', issue }) });
  return true;
}
/** Object đã trả lỗi nhưng chưa gửi annotator. */
const drafts = () => S.detail.result.objects.filter((o) => { const r = S.detail.objectReviews?.[o.key]; return r?.status === 'returned' && !r.ticket; });

async function walkStep(kind) {
  const objs = S.detail.result.objects, cur = S.obj.cur;
  if (kind === 'exit') { S.obj.walk = null; S.obj.cur = null; S.float?.close(); return render(); }
  if (kind === 'float') return openFloat();
  if (kind === 'reopen') return focusObject(cur);
  if (kind === 'ok' || kind === 'returned' || kind === 'false') {
    // Đang dùng bảng nổi thì hộp trả lỗi mở ngay trong bảng nổi (trên CVAT).
    if (kind === 'returned') {
      try { S.float?.resizeTo(460, 560); } catch (_) { /* không đổi được cỡ: hộp tự cuộn */ }
      if (!await returnObject(cur, null, S.float?.document)) return undefined;
    } else await setObjects([cur], 'ok');
    if (kind === 'false') {
      for (const f of S.detail.result.findings.filter((x) => (x.objKey === cur || x.other === cur) && !S.detail.reviews[x.key])) {
        S.detail.reviews = await api(`/api/jobs/${S.jobId}/reviews`, { method: 'POST', body: JSON.stringify({ key: f.key, verdict: 'false_alarm' }) });
      }
    }
    S.obj.walk.history.push(cur);
    const next = queue(objs)[0];
    if (!next) { toast('Đã duyệt hết object'); return render(); }
    return focusObject(next.key);
  }
  if (kind === 'next') {
    const q = queue(objs), i = q.findIndex((x) => x.key === cur);
    const next = q[i + 1] || q[0];
    if (next && next.key !== cur) S.obj.walk.history.push(cur);
    return focusObject(next ? next.key : cur);
  }
  if (kind === 'prev') {
    const back = S.obj.walk.history.pop();
    return back ? focusObject(back) : toast('Đây là object đầu tiên');
  }
  return undefined;
}

// ------------------------------------------------------------------ hình point cloud chỗ nối (đứt track)

const VERDICT_TEXT = { one: 'Point cloud: một cụm điểm ở chỗ nối, không thấy vật thứ hai.', unknown: 'Point cloud: không đủ điểm để kết luận.' };

function evidenceHtml(x) {
  const ev = S.evidence.get(x.key);
  if (!ev) return `<button class="btn sm" data-evidence="${esc(x.key)}">Xem point cloud chỗ nối</button>`;
  if (ev === 'loading') return '<div class="muted">Đang tải point cloud từ CVAT…</div>';
  if (ev.error) return `<div class="muted">Không tải được: ${esc(ev.error)}</div>`;
  const name = (b) => (b.role === 'a' ? `#${x.cvatId}` : b.role === 'b' ? `#${x.otherCvatId}` : `#${b.cvatId}`);
  const panels = ev.frames.map((f, i) => {
    if (!f.points.length) return `<div class="ev-panel"><div class="ev-cap">frame ${f.frame}: không có point cloud</div></div>`;
    const W = 340, H = 240, sc = Math.min(W, H) / (2 * f.range);
    const px = (x0) => (W / 2 + (x0 - f.center[0]) * sc).toFixed(1), py = (y0) => (H / 2 - (y0 - f.center[1]) * sc).toFixed(1);
    let dots = '';
    for (let k = 0; k < f.points.length; k += 3) dots += `<rect x="${px(f.points[k])}" y="${py(f.points[k + 1])}" width="1.6" height="1.6" class="${f.points[k + 2] ? 'pt-hi' : 'pt-lo'}"/>`;
    const poly = (c) => c.map(([a, b]) => `${px(a)},${py(b)}`).join(' ');
    const boxes = f.boxes.map((b) => `<polygon points="${poly(b.corners)}" class="bx ${b.role}"/><text x="${px(b.corners[0][0])}" y="${py(b.corners[0][1]) - 3}" class="bt ${b.role}">${esc(name(b))}</text>`).join('');
    const ghosts = f.ghosts.map((c) => `<polygon points="${poly(c)}" class="bx ghost ${i ? 'a' : 'b'}"/>`).join('');
    return `<div class="ev-panel"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Nhìn từ trên, frame ${f.frame}">${dots}${ghosts}${boxes}</svg>
      <div class="ev-cap">frame ${f.frame} · ${i ? `#${x.otherCvatId} bắt đầu; nét đứt: chỗ #${x.cvatId} lẽ ra tới` : `#${x.cvatId} hết; nét đứt: chỗ #${x.otherCvatId} lẽ ra ở`}</div></div>`;
  }).join('');
  return `<div class="ev">${panels}</div><div class="ev-note">${esc(VERDICT_TEXT[ev.verdict] || '')} Điểm sáng: cao hơn đáy box (thân vật); điểm mờ: mặt đất. Ô ${ev.frames[0]?.range * 2 || 24} m.</div>`;
}

// ------------------------------------------------------------------ chuyển trang

function render() {
  if (S.view === 'spec' || !S.detail) return;
  if (S.view === 'overview') renderOverview(); else renderReview();
  renderSession();
  paintFloat();
}

function setView(view) {
  S.view = view;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === view);
  $('#layout').classList.toggle('no-side', view === 'spec');
  clearTimeout(S.poll);
  if (view === 'spec') return window.QCSpec.open();
  if (view === 'mine') return window.Annot.open();
  if (view === 'tickets') return S.jobId ? window.QCTickets.open(S.jobId) : ($('#main').innerHTML = '<div class="empty">Chọn một job bên trái.</div>');
  if (S.jobId) return refreshJob();
  $('#main').innerHTML = '<div class="empty">Chọn một job bên trái.</div>';
  return undefined;
}

// ------------------------------------------------------------------ sự kiện

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-view]');
  if (tab) return setView(tab.dataset.view);
  const go = e.target.closest('[data-view-go]');
  if (go) return setView(go.dataset.viewGo);
  if (e.target.closest('[data-act="logout"]')) {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    S.me = null;
    return window.QCLogin.show();
  }
  if (S.view === 'spec' || S.view === 'mine') return undefined;
  const jobBtn = e.target.closest('[data-job]');
  if (jobBtn) {
    await openJob(Number(jobBtn.dataset.job));
    return S.view === 'tickets' ? window.QCTickets.open(S.jobId) : undefined;
  }
  if (S.view === 'tickets') return undefined;
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const key = pick.dataset.pick;
    if (S.obj.cur && S.obj.cur !== key) (S.obj.walk ||= { history: [] }).history.push(S.obj.cur);
    if (S.view !== 'review') { S.obj.cur = key; await setView('review'); }
    return focusObject(key);
  }
  const t = e.target.closest('[data-act],[data-verdict],[data-obj],[data-wk],[data-evidence],[data-assign]');
  try {
    const act = t?.dataset.act;
    if (t?.dataset.assign) {
      if (await returnObject(t.dataset.assign, t.dataset.finding || null)) {
        // Trả lỗi từ một mục tool báo nghĩa là mục đó là lỗi thật: ghi luôn, khỏi bấm thêm.
        const fk = t.dataset.finding;
        if (fk && S.detail.reviews[fk]?.verdict !== 'confirmed') S.detail.reviews = await api(`/api/jobs/${S.jobId}/reviews`, { method: 'POST', body: JSON.stringify({ key: fk, verdict: 'confirmed' }) });
        toast('Đã ghi lỗi · gửi annotator ở bước Gửi lỗi'); loadJobs(); render();
      }
      return undefined;
    }
    if (act === 'send') {
      const made = await window.QCTickets.send(S.jobId, drafts());
      if (made) { toast(`Đã gửi ${made.length} lỗi cho annotator`); S.detail = await api(`/api/jobs/${S.jobId}`); window.QCTickets.badge(); loadJobs(); render(); }
      return undefined;
    }
    if (act === 'missing') {
      const cur = S.detail.result.objects?.find((x) => x.key === S.obj.cur);
      const made = await window.QCTickets.missingForm({ frame: cur ? focusFrame(cur) : S.detail.result.job.start });
      if (made) { toast(`Đã tạo ${made.id} · thiếu box ${made.label}`); S.detail = await api(`/api/jobs/${S.jobId}`); window.QCTickets.badge(); render(); }
      return undefined;
    }
    if (act === 'scan') { await api(`/api/jobs/${S.jobId}/scan`, { method: 'POST' }); return refreshJob(); }
    if (act === 'cancel') { await api(`/api/jobs/${S.jobId}/cancel`, { method: 'POST' }); return refreshJob(); }
    if (act === 'complete') {
      S.detail.completion = await api(`/api/jobs/${S.jobId}/complete`, { method: 'POST', body: '{}' });
      toast('Đã hoàn thành duyệt job');
      loadJobs();
      return render();
    }
    if (act === 'bulk-ok') {
      const keys = objectRows(S.detail.result.objects).rows.map((x) => x.key);
      if (!confirm(`Đánh dấu Đạt ${keys.length} vật đứng yên (tool không báo gì)? Hãy chắc đã xem chúng trên CVAT.`)) return undefined;
      await setObjects(keys, 'ok');
      S.obj.tab = 'all';
      S.obj.only = '';
      loadJobs();
      return render();
    }
    if (t?.dataset.wk) { await walkStep(t.dataset.wk); return loadJobs(); }
    if (t?.dataset.obj) {
      const s = objState(S.detail.result.objects.find((x) => x.key === t.dataset.key));
      // Trả lỗi lần đầu = ghi lỗi; bấm lại khi đã trả lỗi = bỏ trạng thái.
      if (t.dataset.obj === 'returned' && s !== 'returned') { if (await returnObject(t.dataset.key)) { loadJobs(); render(); } return undefined; }
      await setObjects([t.dataset.key], s === t.dataset.obj ? null : t.dataset.obj);
      loadJobs();
      return render();
    }
    if (t?.dataset.verdict) {
      const verdict = S.detail.reviews[t.dataset.key]?.verdict === t.dataset.verdict ? null : t.dataset.verdict;
      S.detail.reviews = await api(`/api/jobs/${S.jobId}/reviews`, { method: 'POST', body: JSON.stringify({ key: t.dataset.key, verdict }) });
      return render();
    }
    if (t?.dataset.evidence) {
      const key = t.dataset.evidence;
      S.evidence.set(key, 'loading');
      render();
      try { S.evidence.set(key, await api(`/api/jobs/${S.jobId}/evidence?key=${encodeURIComponent(key)}`)); } catch (error) { S.evidence.set(key, { error: error.message }); }
      return render();
    }
    if (act === 'clear-frame') { S.filter.frame = null; S.filter.page = 0; return render(); }
    if (act === 'clear-rule') { S.filter.rule = ''; S.filter.page = 0; return render(); }
  } catch (error) {
    return toast(error.message);
  }
  const sev = e.target.closest('[data-sev]');
  if (sev) { S.filter.sev = sev.dataset.sev; S.filter.page = 0; return render(); }
  const frame = e.target.closest('[data-frame]');
  if (frame) { const fr = Number(frame.dataset.frame); S.filter.frame = S.filter.frame === fr ? null : fr; S.filter.page = 0; return render(); }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) { const k = toggle.dataset.toggle; if (S.open.has(k)) S.open.delete(k); else S.open.add(k); return render(); }
  const rule = e.target.closest('[data-rule]');
  if (rule) { S.filter.rule = S.filter.rule === rule.dataset.rule ? '' : rule.dataset.rule; S.filter.page = 0; return render(); }
  const gotoBlind = e.target.closest('[data-goto]');
  if (gotoBlind) { S.obj.tab = 'all'; S.obj.only = gotoBlind.dataset.goto; S.obj.page = 0; return setView('review'); }
  const only = e.target.closest('[data-only]');
  if (only) { S.obj.only = S.obj.only === only.dataset.only ? '' : only.dataset.only; S.obj.page = 0; return render(); }
  const otab = e.target.closest('[data-objtab]');
  if (otab) { S.obj.tab = otab.dataset.objtab; S.obj.page = 0; return render(); }
  const fp = e.target.closest('[data-f-page]');
  if (fp) { S.filter.page = Number(fp.dataset.fPage); return render(); }
  const op = e.target.closest('[data-o-page]');
  if (op) { S.obj.page = Number(op.dataset.oPage); return render(); }
  return undefined;
});

document.addEventListener('change', (e) => {
  if (e.target.dataset?.ofilter === 'label') { S.obj.label = e.target.value; S.obj.page = 0; render(); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'job-filter' && S.me?.role === 'qc') renderJobs();
  const f = e.target.dataset?.filter, of = e.target.dataset?.ofilter;
  if (f === 'text' || of === 'text') {
    if (f) { S.filter.text = e.target.value; S.filter.page = 0; } else { S.obj.text = e.target.value; S.obj.page = 0; }
    clearTimeout(S.typing);
    S.typing = setTimeout(render, 220);
  }
});
/** Phím tắt Xem tiếp, ở trang chính hoặc bảng nổi (`doc`). */
function walkKey(e, doc) {
  if (!S.obj.walk || S.view !== 'review' || !doc.querySelector('#modal').hidden || /INPUT|TEXTAREA|SELECT/.test(doc.activeElement?.tagName || '')) return;
  if (doc === document && e.key.toLowerCase?.() === 'n') { e.preventDefault(); $('[data-act="missing"]')?.click(); return; }
  const map = { 1: 'ok', 2: 'returned', 3: 'false', j: 'next', k: 'prev' };
  const kind = map[e.key] || map[e.key.toLowerCase?.()];
  if (kind) { e.preventDefault(); walkStep(kind).then(() => loadJobs()).catch((error) => toast(error.message)); }
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#job-filter').focus(); return; }
  walkKey(e, document);
});

// ------------------------------------------------------------------ bảng nổi trên CVAT
// Cửa sổ nhỏ luôn nằm trên (Document Picture-in-Picture, Edge / Chrome ≥ 116): QC nhìn box trên CVAT và bấm Đạt / Trả lỗi /
// Tiếp ngay đó, không phải chuyển tab. Trình duyệt không hỗ trợ thì đặt hai cửa sổ cạnh nhau.

async function openFloat() {
  if (S.float) return S.float.focus();
  if (!window.documentPictureInPicture) return toast('Trình duyệt không có bảng nổi: đặt trang QC và CVAT cạnh nhau (Win + ← / →)');
  const pip = await window.documentPictureInPicture.requestWindow({ width: 420, height: 300 })
    .catch(() => { throw new Error('Không mở được bảng nổi: đặt trang QC và CVAT cạnh nhau (Win + ← / →)'); });
  for (const href of ['/style.css', '/workspace.css']) pip.document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${href}">`);
  if (document.documentElement.dataset.theme) pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  pip.document.title = 'PointSnap QC';
  pip.document.body.innerHTML = `${$('.sprite').outerHTML}<div id="fl" class="fl"></div><div id="modal" class="modal-bg" hidden></div>`;
  pip.document.addEventListener('keydown', (e) => walkKey(e, pip.document));
  pip.document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wk]');
    if (b) walkStep(b.dataset.wk).then(() => loadJobs()).catch((error) => toast(error.message));
  });
  pip.addEventListener('pagehide', () => { S.float = null; });
  S.float = pip;
  return paintFloat();
}

function paintFloat(msg) {
  const fl = S.float?.document.querySelector('#fl');
  if (!fl) return;
  if (msg !== undefined) { const m = fl.querySelector('.fl-msg'); if (m) m.textContent = msg; return; }
  const objs = S.detail?.result?.objects || [], o = objs.find((x) => x.key === S.obj.cur);
  if (!S.obj.walk || !o) { fl.innerHTML = '<div class="fl-h">Chưa chọn object.</div><div class="muted">Mở tab Duyệt job ở trang QC.</div>'; return; }
  const q = queue(objs), done = objs.filter((x) => ['ok', 'returned'].includes(objState(x))).length;
  const tool = S.detail.result.findings.filter((x) => (x.objKey === o.key || x.other === o.key) && x.severity !== 'info');
  fl.innerHTML = `<div class="fl-h">${icon(classIcon(o.label))}<b>${esc(o.label)} #${o.cvatId ?? o.serverId}</b><span class="muted">${frameRange(o.first, o.last)}</span><span class="right muted num">${done}/${objs.length}</span></div>
    <div class="fl-tool">${tool.length ? tool.map((x) => `<span class="pill ${x.severity === 'error' ? 'error' : 'warning'}">${esc(x.title)}</span>`).join('') : '<span class="muted">Tool không báo gì: QC tự xem.</span>'}</div>
    <div class="fl-k"><button class="k ok" data-wk="ok"><kbd>1</kbd> Đạt</button><button class="k ret" data-wk="returned"><kbd>2</kbd> Trả lỗi</button>
      <button class="k" data-wk="false"><kbd>3</kbd> Báo nhầm</button><button class="k" data-wk="prev"><kbd>K</kbd> Lùi</button><button class="k" data-wk="next"><kbd>J</kbd> Tiếp</button>
      <button class="k" data-wk="reopen">↗ Mở lại CVAT</button></div>
    <div class="fl-msg muted">${q.length} chưa xem · ${drafts().length} lỗi chưa gửi</div>`;
}

window.QC = { S, api, esc, toast, paintWidths, $, icon, classIcon, fmtTime, frameRange, ticketObj, ticketUrl, start, setBadge, loadJobs, openJob, paintTheme, PAGE };

(async () => {
  initChrome();
  try { await start(await api('/api/me')); } catch (_) { window.QCLogin.show(); }
})();

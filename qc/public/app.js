'use strict';
/*
 * Trang QC theo thiết kế Figma: Duyệt Job (kết quả quét tự động) và Mọi Object & Tiến độ (QC duyệt hết mọi object, có
 * "Xem tiếp" và phím tắt). Guideline ở spec.js. Tool chỉ xếp chỗ cần xem trước; QC vẫn duyệt đủ 100% object.
 */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEV = { error: 'Lỗi', warning: 'Cảnh báo', info: 'Thông tin' };
const PRIO = { fail: ['high', 'Ưu tiên cao'], review: ['mid', 'Ưu tiên vừa'], pass: ['low', 'Ít vấn đề'] };
const PAGE = 20;
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* không lưu được */ } } };

const S = { view: 'review', status: null, jobs: [], jobId: null, detail: null, poll: null, open: new Set(), evidence: new Map(),
  filter: { sev: 'real', rule: '', frame: null, text: '', page: 0 },
  obj: { tab: 'all', label: '', text: '', page: 0, walk: null, cur: null } };

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

function paintTheme() {
  const t = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  $('#theme').classList.toggle('is-dark', t === 'dark');
  $('#theme').setAttribute('aria-pressed', String(t === 'dark'));
}
function initChrome() {
  const saved = store.get('qc-theme', '');
  if (saved) document.documentElement.dataset.theme = saved;
  paintTheme();
  $('#theme').addEventListener('click', () => {
    const next = $('#theme').classList.contains('is-dark') ? 'light' : 'dark';
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
  qc: [['review', 'Duyệt Job'], ['objects', 'Mọi Object & Tiến độ'], ['tickets', 'Giao việc Lỗi'], ['spec', 'Guideline']],
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

function renderSession() {
  const r = S.detail?.result;
  $('#session').innerHTML = `<h4>PHIÊN KIỂM DUYỆT</h4><dl>
    <dt>Nguồn dữ liệu</dt><dd>LiDAR · 3D Cuboid</dd>
    ${r ? `<dt>Chuỗi frame</dt><dd>${r.job.start}–${r.job.stop} / ${r.summary.frames} frame</dd><dt>Guideline</dt><dd>${esc(r.spec?.name || 'Mặc định')} v${r.spec?.version || 0}</dd>` : ''}
    <dt>Chính sách QC</dt><dd>100% object</dd></dl>
    <p>Mọi box đều quan trọng. Tool chỉ xếp chỗ cần xem trước; QC duyệt toàn bộ object trước khi hoàn thành job.</p>
    <div class="sync"><span class="dot ok"></span>${S.status?.ok ? `Đã đồng bộ · ${new Date().toLocaleTimeString('vi-VN')}` : 'Chưa kết nối'}</div>`;
}

// ------------------------------------------------------------------ một job

async function openJob(jobId) {
  if (S.jobId !== jobId) {
    S.filter = { sev: 'real', rule: '', frame: null, text: '', page: 0 };
    S.obj = { ...S.obj, tab: 'all', label: '', text: '', page: 0, walk: null, cur: null };
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
  return `${running ? '<button class="btn" data-act="cancel">Dừng</button>' : `<button class="btn primary" data-act="scan">${result ? 'Quét lại' : 'Quét job'}</button>`}
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
      return `<button class="rule ${S.filter.rule === r.rule ? 'sel' : ''}" data-rule="${esc(r.rule)}" title="${esc(r.rule)}">
        <span class="t">${esc(r.title)}${twice(r.title) ? ` <span class="muted">${esc(r.rule)}</span>` : ''}</span>
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
      <td>${r === 'confirmed' ? '<span class="st ok">✓ Đúng</span>' : r === 'false_alarm' ? '<span class="st none">✕ Báo nhầm</span>' : '<span class="faint">—</span>'}</td>
      <td><span class="ops"><a class="lnk" href="${esc(cvatLink(x.frames[0], x.other ? null : x))}" target="pointsnap-cvat" rel="noopener" title="${esc(openTitle)}">Mở CVAT ↗</a>
        <button class="lnk" data-assign="${esc(x.objKey)}" data-finding="${esc(x.key)}" title="Ghi lỗi cho object này; gửi annotator một lượt ở Mọi Object">✕ Trả lỗi</button>
        <button class="act yes ${r === 'confirmed' ? 'on' : ''}" data-verdict="confirmed" data-key="${esc(x.key)}" aria-pressed="${r === 'confirmed'}" title="Đúng: lỗi thật" aria-label="Đúng">✓</button>
        <button class="act no ${r === 'false_alarm' ? 'on' : ''}" data-verdict="false_alarm" data-key="${esc(x.key)}" aria-pressed="${r === 'false_alarm'}" title="Báo nhầm" aria-label="Báo nhầm">✕</button></span></td></tr>`;
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
    <div class="tbl-wrap"><table><thead><tr><th>Đối tượng</th><th>Mô tả lỗi</th><th>Frame vi phạm</th><th>Xác minh QC</th><th>Thao tác</th></tr></thead>
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

function renderReview() {
  const { run, result, reviews } = S.detail, info = jobInfo();
  const title = 'Duyệt Job', sub = result ? `${esc(result.job.taskName)} · Kết quả quét LiDAR 3D Bounding Cuboid<br>Lần quét cuối: ${fmtTime(result.startedAt)} · ${result.seconds} s · guideline ${esc(result.spec?.name || 'Mặc định')} v${result.spec?.version || 0}`
    : `${esc(info.taskName || '')} · ${info.frames || '?'} frame`;
  let html = pageHead('QUÉT LỖI TỰ ĐỘNG', title, sub, result, run);
  if (!result) { $('#main').innerHTML = `${html}<div class="empty">Chưa quét. Bấm <b>Quét job</b>.</div>`; paintWidths(); return; }
  const s = result.summary, real = result.findings.filter((x) => x.severity !== 'info');
  const done = real.filter((x) => reviews[x.key]).length, objs = result.objects || [];
  const okObjs = objs.filter((o) => ['ok', 'returned'].includes(objState(o))).length;
  const [cls, label] = PRIO[s.gate.verdict];
  html += `<div class="tiles">
    <div class="tile prio ${cls}" title="Xếp thứ tự xem, không phải kết luận"><div class="k">Mức ưu tiên</div><div class="v">${label}</div><div class="s">${s.boxes} box / ${objs.length} object</div></div>
    <div class="tile"><div class="k">Số lỗi</div><div class="v c-err num">${s.errorGroups}</div><div class="s">${s.errorBoxesPer100} box / 100</div></div>
    <div class="tile"><div class="k">Cảnh báo</div><div class="v c-warn num">${s.warningGroups}</div><div class="s">${s.warningBoxesPer100} box / 100</div></div>
    <div class="tile"><div class="k">Đã xác minh mục tool báo</div><div class="v num ${done === real.length ? 'c-ok' : ''}">${done}/${real.length}<small>${real.length ? Math.round((done / real.length) * 100) : 100}%</small></div>
      <div class="s">Đúng / Báo nhầm cho từng mục</div><div class="bar ok"><i data-w="${real.length ? Math.round((done / real.length) * 100) : 100}"></i></div></div></div>
    <div class="note"><span class="pill ${okObjs === objs.length ? 'ok' : 'accent'}">${okObjs}/${objs.length} object đã duyệt</span>
      Mục tool báo chỉ là chỗ cần xem trước. Job chỉ hoàn thành khi QC duyệt đủ 100% object. <button class="lnk" data-view-go="objects">Mọi Object &amp; Tiến độ ›</button></div>`;
  html += heatHtml(result) + `<div class="grid-2">${rulesHtml(result)}${scopeHtml(result)}</div>` + findingsHtml(result, reviews);
  const keep = document.activeElement?.dataset?.filter;
  $('#main').innerHTML = html;
  paintWidths();
  restoreFocus(keep);
}

// ------------------------------------------------------------------ màn Mọi Object & Tiến độ

/** Hàng đợi "Xem tiếp": object chưa duyệt (hoặc bị sửa sau khi duyệt), có vấn đề trước, rồi tool không đo được, rồi theo frame. */
function queue(objs) {
  const rank = (o) => (o.errors ? 0 : o.warnings ? 1 : blind(o) ? 2 : 3);
  return objs.filter((o) => !['ok', 'returned', 'rescan'].includes(objState(o))).sort((a, b) => rank(a) - rank(b) || a.first - b.first || (a.cvatId ?? 0) - (b.cvatId ?? 0));
}
/** Tool không kiểm được object này: không đo được mặt đất ở quá nửa số box, hoặc có frame thiếu point cloud. */
const blind = (o) => o.noPoints > 0 || o.noGround >= o.boxes / 2;
const issueOf = (o) => (o.errors ? `${o.errors} lỗi` : o.warnings ? `${o.warnings} cảnh báo` : '');
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
    ['issues', 'Có vấn đề', (x) => x.errors || x.warnings],
    ['blind', 'Chưa kiểm được', blind],
    ['todo', 'Chưa xem', (x) => !['ok', 'returned'].includes(st(x))],
    ['changed', 'Bị sửa sau khi duyệt', (x) => st(x) === 'changed'],
    ['done', 'Đã duyệt', (x) => ['ok', 'returned'].includes(st(x))],
    ['static', 'Đứng yên chưa xem', (x) => x.static && !x.errors && !x.warnings && !['ok', 'returned'].includes(st(x))],
  ];
  const tabFn = (tabs.find((t) => t[0] === o.tab) || tabs[0])[2];
  const match = (x) => (!o.label || x.label === o.label) && (!o.text || `${x.label} #${x.cvatId}`.toLowerCase().includes(o.text.toLowerCase()));
  return { tabs: tabs.filter(([k, , fn]) => k === 'all' || k === o.tab || objs.some(fn)).map(([k, t, fn]) => [k, t, objs.filter((x) => fn(x) && match(x)).length]),
    rows: objs.filter((x) => tabFn(x) && match(x)) };
}

function renderObjects() {
  const { run, result } = S.detail;
  let html = pageHead('KIỂM DUYỆT TOÀN BỘ OBJECT', 'Mọi Object &amp; Tiến độ', result ? `${esc(result.job.taskName)} · ${result.summary.boxes} box · ${(result.objects || []).length} object` : '', result, run);
  if (!result) { $('#main').innerHTML = `${html}<div class="empty">Chưa quét. Bấm <b>Quét job</b>.</div>`; paintWidths(); return; }
  if (!result.objects) { $('#main').innerHTML = `${html}<div class="banner"><div><b>Kết quả quét cũ chưa có danh sách object</b><span class="muted">Quét lại để duyệt theo object.</span></div><button class="btn sm primary" data-act="scan">Quét lại</button></div>`; return; }
  const objs = result.objects, reviewed = objs.filter((x) => ['ok', 'returned'].includes(objState(x))).length;
  const rescan = objs.filter((x) => objState(x) === 'rescan').length;
  const changed = objs.filter((x) => objState(x) === 'changed').length, pct = objs.length ? Math.round((reviewed / objs.length) * 100) : 100;
  const comp = S.detail.completion, full = reviewed === objs.length;
  const statics = objs.filter((x) => x.static && !x.errors && !x.warnings && !['ok', 'returned'].includes(objState(x)));
  html += `<div class="card"><div class="prog"><div>
      <div class="lbl"><span>TIẾN ĐỘ KIỂM DUYỆT BẮT BUỘC</span><span class="pill accent">${objs.length - reviewed} object còn lại</span></div>
      <div class="big"><b class="num">${reviewed}/${objs.length}</b><span>object đã duyệt</span><span class="pct">(${pct}%)</span></div>
      <div class="bar ${full ? 'ok' : ''}"><i data-w="${pct}"></i></div>
      <div class="foot">${comp && full ? `Đã hoàn thành lúc ${fmtTime(comp.at)}${comp.by ? ` · ${esc(comp.by)}` : ''}` : 'Cần đạt 100% để hoàn thành job.'}</div></div>
    <div class="btns">
      <button class="btn primary wide" data-act="walk" ${reviewed === objs.length ? 'disabled' : ''}>${icon('play')} ${S.obj.walk ? 'Tiếp tục Xem tiếp' : 'Bắt đầu Xem tiếp'}</button>
      ${full ? `<button class="btn wide ok" data-act="complete" title="Cần gửi hết lỗi và nghiệm thu hết phiếu sửa">✓ ${comp ? 'Hoàn thành lại' : 'Hoàn thành duyệt job'}</button>` : '<button class="btn wide" disabled>✕ Chưa đủ 100% (khoá hoàn thành)</button>'}
      ${drafts().length ? `<button class="btn wide primary" data-act="send">✉ Gửi ${drafts().length} lỗi cho annotator</button>` : ''}
      ${rescan ? `<button class="btn wide" data-act="scan" title="Bản sửa đã nghiệm thu; quét lại để tool kiểm bản mới">⟳ Quét lại để xác nhận ${rescan} object đã sửa</button>` : ''}
      ${changed ? `<button class="btn wide warnc" data-objtab="changed">⟳ ${changed} object bị sửa (duyệt lại)</button>` : ''}
    </div></div></div>`;
  if (statics.length) {
    html += `<div class="banner warn">${icon('layers')}<div><b>Có ${statics.length} vật đứng yên (hàng nón, rào chắn…) chưa xem, tool không báo gì.</b>
      <span class="muted">Có thể duyệt cùng một lượt: lọc ra, xem trên CVAT, rồi đánh dấu OK cả nhóm.</span></div>
      <button class="btn sm" data-objtab="static">✓ Duyệt nhanh nhóm đứng yên (${statics.length} vật)</button></div>`;
  }
  const { tabs, rows } = objectRows(objs), o = S.obj;
  const labels = [...new Set(objs.map((x) => x.label))].sort();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), page = Math.min(o.page, pages - 1);
  const body = rows.slice(page * PAGE, page * PAGE + PAGE).map((x) => {
    const s = objState(x), r = S.detail.objectReviews?.[x.key];
    const issue = x.errors ? `<span class="pill error">${x.errors} lỗi</span>` : x.warnings ? `<span class="pill warning">${x.warnings} cảnh báo</span>` : '<span class="faint">—</span>';
    const data = [x.far ? `<span class="pill warning">Ở xa · ${Math.round(x.minRange)} m</span>` : '',
      // Quá nửa số box không đo được mặt đất mới là "chưa kiểm được"; ít hơn thì chỉ ghi chú nhỏ.
      x.noGround >= x.boxes / 2 ? `<span class="pill warning" title="${x.noGround}/${x.boxes} box tool không đo được mặt đất">Thiếu điểm đất · ${x.noGround}/${x.boxes} box</span>`
        : x.noGround ? `<span class="muted" title="Box tool không đo được mặt đất">${x.noGround}/${x.boxes} box không đo đất</span>` : '',
      x.noPoints ? `<span class="pill warning">Thiếu point cloud · ${x.noPoints} frame</span>` : ''].join(' ') || '<span class="muted">Đủ điểm đất</span>';
    const issueTxt = r?.issue ? [r.issue.tags.join(', '), r.issue.frame != null ? `frame ${r.issue.frame}` : '', r.issue.text].filter(Boolean).join(' · ') : '';
    const stHtml = s === 'ok' ? '<span class="st ok">✓ OK</span>' : s === 'returned'
      ? `<span class="st ret" title="${esc(issueTxt)}">✕ Trả lỗi</span><span class="two">${r.ticket ? esc(r.ticket) : 'chưa gửi annotator'}${issueTxt ? ` · ${esc(issueTxt.slice(0, 40))}` : ''}</span>`
      : s === 'changed' ? '<span class="st chg">⚠ Chưa xem (đã sửa)</span>'
        : s === 'rescan' ? `<span class="st ok">✓ Đã nghiệm thu</span><span class="two">${esc(r.ticket)} · quét lại để xác nhận</span>` : '<span class="st none">○ Chưa xem</span>';
    return `<tr class="${S.obj.cur === x.key ? 'cur' : ''}" id="o-${esc(x.key.replace(':', '-'))}">
      <td><span class="obj">${icon(classIcon(x.label))}${esc(x.label)}${x.static ? ' <span class="pill outline" title="Đứng yên theo toạ độ đã bù chuyển động xe thu">đứng yên</span>' : ''}</span></td>
      <td><span class="cid">#${x.cvatId ?? x.serverId}</span></td>
      <td class="num">${frameRange(x.first, x.last)}<span class="two">${x.boxes} box</span></td>
      <td>${issue}</td><td>${data}</td><td>${stHtml}</td>
      <td class="who-cell">${r ? `${esc(r.by || '—')}<small>${s === 'changed' ? 'Track đã sửa sau lần duyệt · ' : ''}${fmtTime(r.at)}</small>` : '<span class="faint">—</span><small>Chưa xem</small>'}</td>
      <td><span class="ops"><a class="lnk" href="${esc(objLink(x))}" target="pointsnap-cvat" rel="noopener" title="Mở object trong CVAT">↗ CVAT</a>
        <button class="act yes ${s === 'ok' ? 'on' : ''}" data-obj="ok" data-key="${esc(x.key)}" aria-pressed="${s === 'ok'}" title="OK / Đạt" aria-label="OK">✓</button>
        <button class="act no ${s === 'returned' ? 'on' : ''}" data-obj="returned" data-key="${esc(x.key)}" aria-pressed="${s === 'returned'}" title="Trả lỗi về annotator" aria-label="Trả lỗi">✕</button></span></td></tr>`;
  }).join('');
  const bulk = o.tab === 'static' && rows.length ? `<button class="btn sm ok" data-act="bulk-ok">✓ Đánh dấu OK ${rows.length} vật đang hiện</button>` : '';
  html += `<div class="card"><div class="card-h"><h2>Danh sách object</h2><span class="pill outline">${objs.length}</span>
      <span class="right tbl-tools">${bulk}<select data-ofilter="label" aria-label="Class"><option value="">Class: Tất cả</option>${labels.map((l) => `<option value="${esc(l)}"${l === o.label ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input type="search" data-ofilter="text" placeholder="Tìm mã CVAT / class…" value="${esc(o.text)}" aria-label="Tìm object"></span></div>
    <div class="subtabs">${tabs.map(([k, t, n]) => `<button class="subtab ${o.tab === k ? 'on' : ''}" data-objtab="${k}">${t} (${n})</button>`).join('')}</div>
    <div class="tbl-note">${reviewed} đã duyệt + ${objs.length - reviewed} chưa xem = ${objs.length} object. "Có vấn đề" và "Chưa kiểm được" có thể giao nhau.</div>
    <div class="tbl-wrap"><table><thead><tr><th>Class</th><th>Mã CVAT</th><th>Khoảng frame</th><th>Lỗi tool báo</th><th>Xa / thiếu điểm đất</th><th>Trạng thái duyệt</th><th>Người duyệt &amp; thời gian</th><th>Thao tác</th></tr></thead>
    <tbody>${body || '<tr><td colspan="8" class="muted">Không có object nào khớp.</td></tr>'}</tbody></table></div>
    ${pager(page, pages, rows.length, 'object', 'o-page')}</div>`;
  html += walkHtml(objs);
  const keep = document.activeElement?.dataset?.ofilter;
  $('#main').innerHTML = html;
  paintWidths();
  if (keep) { const el = $(`[data-ofilter="${keep}"]`); if (el && el.type === 'search') { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
}

function walkHtml(objs) {
  const w = S.obj.walk;
  if (!w) return '';
  const o = objs.find((x) => x.key === S.obj.cur);
  if (!o) return '';
  const q = queue(objs), pos = q.findIndex((x) => x.key === o.key);
  return `<div class="walk" role="region" aria-label="Xem tiếp">
    <span class="now">Đang xem ${pos >= 0 ? `${pos + 1}/${q.length} còn lại` : 'object'}: ${esc(o.label)} #${o.cvatId ?? o.serverId} (${frameRange(o.first, o.last)})${issueOf(o) ? `<span class="c-err">· ${issueOf(o)} tool báo</span>` : ''}</span>
    <span class="keys">
      <button class="k ok" data-wk="ok"><kbd>[1]</kbd>OK / Đạt</button>
      <button class="k ret" data-wk="returned"><kbd>[2]</kbd>Trả lỗi</button>
      <button class="k" data-wk="false" title="OK, và ghi mục tool báo của object này là Báo nhầm"><kbd>[3]</kbd>Báo nhầm</button>
      <button class="k" data-wk="prev"><kbd>[K]</kbd>Lùi</button>
      <button class="k" data-wk="next"><kbd>[J]</kbd>Tiếp</button>
      <a class="k" href="${esc(objLink(o))}" target="pointsnap-cvat" rel="noopener">Mở CVAT ↗</a>
      ${window.documentPictureInPicture ? '<button class="k" data-wk="float" title="Cửa sổ nhỏ luôn nằm trên CVAT">⧉ Bảng nổi trên CVAT</button>' : ''}</span>
    <span class="tag">XEM TIẾP ĐANG BẬT</span><button class="exit" data-wk="exit">✕ Thoát (Esc)</button></div>`;
}

/** Đưa object vào khung nhìn (đúng trang của bảng) và mở trong cửa sổ CVAT dùng chung. */
function focusObject(key, { open = true } = {}) {
  const objs = S.detail.result.objects;
  S.obj.cur = key;
  if (!key) return render();
  const o = objs.find((x) => x.key === key);
  if (S.obj.tab !== 'all' && !objectRows(objs).rows.some((x) => x.key === key)) S.obj.tab = 'all';
  const idx = objectRows(objs).rows.findIndex((x) => x.key === key);
  if (idx >= 0) S.obj.page = Math.floor(idx / PAGE);
  render();
  $(`#o-${key.replace(':', '-')}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    if (!next) { S.obj.walk = null; S.obj.cur = null; toast('Đã duyệt hết object'); return render(); }
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
  if (S.view === 'objects') renderObjects(); else renderReview();
  renderSession();
  paintFloat();
}
function restoreFocus(keep) {
  if (!keep) return;
  const el = $(`[data-filter="${keep}"]`);
  if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); }
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
  const t = e.target.closest('[data-act],[data-verdict],[data-obj],[data-wk],[data-evidence],[data-assign]');
  try {
    const act = t?.dataset.act;
    if (t?.dataset.assign) {
      if (await returnObject(t.dataset.assign, t.dataset.finding || null)) { toast('Đã ghi lỗi · gửi annotator ở Mọi Object'); loadJobs(); render(); }
      return undefined;
    }
    if (act === 'send') {
      const made = await window.QCTickets.send(S.jobId, drafts());
      if (made) { toast(`Đã gửi ${made.length} lỗi cho annotator`); S.detail = await api(`/api/jobs/${S.jobId}`); window.QCTickets.badge(); loadJobs(); render(); }
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
    if (act === 'walk') {
      const next = S.obj.cur && queue(S.detail.result.objects).some((x) => x.key === S.obj.cur) ? S.obj.cur : queue(S.detail.result.objects)[0]?.key;
      if (!next) return toast('Không còn object chưa duyệt');
      S.obj.walk = S.obj.walk || { history: [] };
      return focusObject(next);
    }
    if (act === 'bulk-ok') {
      const keys = objectRows(S.detail.result.objects).rows.map((x) => x.key);
      if (!confirm(`Đánh dấu OK ${keys.length} vật đứng yên (tool không báo gì)? Hãy chắc đã xem chúng trên CVAT.`)) return undefined;
      await setObjects(keys, 'ok');
      S.obj.tab = 'all';
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
  if (gotoBlind) { S.obj.tab = gotoBlind.dataset.goto; S.obj.page = 0; return setView('objects'); }
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
  if (!S.obj.walk || S.view !== 'objects' || !doc.querySelector('#modal').hidden || /INPUT|TEXTAREA|SELECT/.test(doc.activeElement?.tagName || '')) return;
  const map = { 1: 'ok', 2: 'returned', 3: 'false', j: 'next', k: 'prev', Escape: 'exit' };
  const kind = map[e.key] || map[e.key.toLowerCase?.()];
  if (kind) { e.preventDefault(); walkStep(kind).then(() => loadJobs()).catch((error) => toast(error.message)); }
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#job-filter').focus(); return; }
  walkKey(e, document);
});

// ------------------------------------------------------------------ bảng nổi trên CVAT
// Cửa sổ nhỏ luôn nằm trên (Document Picture-in-Picture, Edge / Chrome ≥ 116): QC nhìn box trên CVAT và bấm OK / Trả lỗi /
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
  if (!S.obj.walk || !o) { fl.innerHTML = '<div class="fl-h">Xem tiếp đã tắt.</div><div class="muted">Bật lại ở trang QC (Mọi Object).</div>'; return; }
  const q = queue(objs), done = objs.filter((x) => ['ok', 'returned'].includes(objState(x))).length;
  const tool = S.detail.result.findings.filter((x) => (x.objKey === o.key || x.other === o.key) && x.severity !== 'info');
  fl.innerHTML = `<div class="fl-h">${icon(classIcon(o.label))}<b>${esc(o.label)} #${o.cvatId ?? o.serverId}</b><span class="muted">${frameRange(o.first, o.last)}</span><span class="right muted num">${done}/${objs.length}</span></div>
    <div class="fl-tool">${tool.length ? tool.map((x) => `<span class="pill ${x.severity === 'error' ? 'error' : 'warning'}">${esc(x.title)}</span>`).join('') : '<span class="muted">Tool không báo gì: QC tự xem.</span>'}</div>
    <div class="fl-k"><button class="k ok" data-wk="ok"><kbd>1</kbd> OK</button><button class="k ret" data-wk="returned"><kbd>2</kbd> Trả lỗi</button>
      <button class="k" data-wk="false"><kbd>3</kbd> Báo nhầm</button><button class="k" data-wk="prev"><kbd>K</kbd> Lùi</button><button class="k" data-wk="next"><kbd>J</kbd> Tiếp</button>
      <button class="k" data-wk="reopen">↗ Mở lại CVAT</button></div>
    <div class="fl-msg muted">${q.length} chưa xem · ${drafts().length} lỗi chưa gửi</div>`;
}

window.QC = { S, api, esc, toast, paintWidths, $, icon, classIcon, fmtTime, frameRange, start, setBadge, loadJobs, openJob, PAGE };

(async () => {
  initChrome();
  try { await start(await api('/api/me')); } catch (_) { window.QCLogin.show(); }
})();

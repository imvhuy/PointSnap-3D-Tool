'use strict';
/* Trang QC: danh sách job, quét, tóm tắt, dải frame, luật, danh sách mục với Đúng / Báo nhầm. Guideline ở spec.js. */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEV = { error: 'Lỗi', warning: 'Cảnh báo', info: 'Thông tin' };
// Tool không duyệt job: chỉ xếp thứ tự xem cho QC.
const PRIO = { fail: ['high', 'Ưu tiên cao'], review: ['mid', 'Ưu tiên vừa'], pass: ['low', 'Ít vấn đề'] };

const S = { view: 'jobs', status: null, jobs: [], jobId: null, detail: null, poll: null, open: new Set(), evidence: new Map(),
  filter: { sev: 'real', rule: '', label: '', todo: false, frame: null, text: '' } };

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-PointSnap-QC': '1', ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body });
  return body;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}

/** Đặt chiều rộng thanh sau khi vẽ (CSP không cho style viết trong HTML). */
function paintWidths(root = document) {
  for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
}

// ------------------------------------------------------------------ trạng thái + danh sách job

async function loadStatus() {
  try { S.status = await api('/api/status'); } catch (error) { S.status = { ok: false, error: error.message }; }
  const el = $('#status');
  el.className = `status ${S.status.ok ? '' : 'bad'}`;
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
  $('#job-list').innerHTML = jobs.map((j) => {
    const running = j.run && ['queued', 'running'].includes(j.run.state);
    const dot = running ? 'run' : j.last ? PRIO[j.last.gate][0] : '';
    const cnt = j.last ? j.last.errors + j.last.warnings : '';
    return `<li><button data-job="${j.id}" class="${j.id === S.jobId ? 'active' : ''}" title="${esc(j.last ? PRIO[j.last.gate][1] : 'Chưa quét')}">
      <span class="dot ${dot}"></span><span class="name">${esc(j.taskName)}</span><span class="cnt num">${cnt}</span>
      <span class="sub">#${j.id} · ${j.frames} frame${j.assignee ? ` · ${esc(j.assignee)}` : ''}</span></button></li>`;
  }).join('') || '<li class="muted">Không có job 3D nào.</li>';
}

// ------------------------------------------------------------------ một job

async function openJob(jobId) {
  if (S.jobId !== jobId) S.filter = { sev: 'real', rule: '', label: '', todo: false, frame: null, text: '' };
  S.jobId = jobId;
  S.open.clear();
  renderJobs();
  await refreshJob();
}

async function refreshJob() {
  if (!S.jobId || S.view !== 'jobs') return;
  S.detail = await api(`/api/jobs/${S.jobId}`);
  renderJob();
  const running = S.detail.run && ['queued', 'running'].includes(S.detail.run.state);
  clearTimeout(S.poll);
  if (running) S.poll = setTimeout(refreshJob, 700);
  else if (['done', 'error'].includes(S.detail.run?.state)) loadJobs();
}

const jobInfo = () => S.jobs.find((j) => j.id === S.jobId) || {};

/**
 * Link CVAT tại frame. `only` = { kind, serverId }: CVAT lọc còn đúng object đó. Mục theo cặp mặc định không lọc, vì CVAT
 * chỉ lọc được một object qua URL và sẽ ẩn object kia.
 */
function cvatLink(f, frame = f.frames[0], only = f.other ? null : f) {
  const job = S.detail.result.job, base = `${S.status.cvatUrl}/tasks/${job.taskId}/jobs/${job.id}?frame=${frame}`;
  return only ? `${base}&type=${only.kind}&serverID=${only.serverId}` : base;
}

/** Số object như CVAT hiện trong danh sách object (kết quả quét cũ chưa có thì dùng ID server). */
const num = (cvatId, serverId) => `#${cvatId ?? serverId}`;
const otherRef = (x) => ({ kind: x.other.split(':')[0], serverId: Number(x.other.split(':')[1]) });
// Đứt track: object kia chỉ có từ frame bắt đầu đoạn sau (frame cuối của mục); các luật cặp khác thì cùng frame.
const otherFrame = (x) => (x.rule === 'track.fragment' ? x.frames[x.frames.length - 1] : x.frames[0]);

const frameRange = (fr) => (fr.length === 1 ? `${fr[0]}` : `${fr[0]}–${fr[fr.length - 1]}`);

function headHtml(result, run) {
  const info = jobInfo(), running = run && ['queued', 'running'].includes(run.state);
  const title = result?.job.taskName || info.taskName || `Job ${S.jobId}`;
  const meta = [`#${S.jobId}`, result ? `frame ${result.job.start}–${result.job.stop}` : `${info.frames || '?'} frame`,
    result?.job.assignee || info.assignee, result?.job.stage].filter(Boolean).join(' · ');
  const cvat = info.taskId ? `${S.status.cvatUrl}/tasks/${info.taskId}/jobs/${S.jobId}` : null;
  let html = `<div class="head"><div><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div></div><div class="actions">
    ${running ? '<button class="btn" data-act="cancel">Dừng</button>' : `<button class="btn primary" data-act="scan">${result ? 'Quét lại' : 'Quét job'}</button>`}
    ${cvat ? `<a class="btn" href="${esc(cvat)}" target="_blank" rel="noopener">CVAT ↗</a>` : ''}
    ${result ? `<a class="btn" href="/api/jobs/${S.jobId}/export.csv" title="Mở bằng Excel">CSV</a><a class="btn" href="/api/jobs/${S.jobId}/export.json">JSON</a>` : ''}
    </div></div>`;
  if (running) {
    const p = run.progress || {}, pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    html += `<div class="progress">${esc(p.phase || 'Đang chờ')}${p.total ? ` · ${p.done}/${p.total} frame` : ''}<div class="bar"><i data-w="${pct}"></i></div></div>`;
  }
  if (run?.state === 'error') html += `<div class="banner err">Lần quét vừa rồi lỗi: ${esc(run.error)}</div>`;
  const now = S.detail.specNow, used = result?.spec;
  if (result && now && used && (now.version !== (used.version || 0) || (now.project ?? null) !== (used.project ?? null)) && !running) {
    html += `<div class="banner">Guideline đã đổi sau lần quét này (${esc(used.name || 'Mặc định')} v${used.version || 0} → ${esc(now.name)} v${now.version}).
      <button class="btn sm primary" data-act="scan">Quét lại</button></div>`;
  }
  return html;
}

function summaryHtml(result, reviews) {
  const sum = result.summary, findings = result.findings.filter((f) => f.severity !== 'info');
  const done = findings.filter((f) => reviews[f.key]).length, pct = findings.length ? Math.round((done / findings.length) * 100) : 100;
  const [cls, label] = PRIO[sum.gate.verdict];
  const yes = findings.filter((f) => reviews[f.key]?.verdict === 'confirmed').length;
  return `<div class="summary">
    <div class="tile prio ${cls}" title="Xếp thứ tự xem, không phải kết luận: QC vẫn kiểm cả job">
      <div class="k">Mức ưu tiên</div><div class="v"><span class="dot ${cls}"></span>${label}</div>
      <div class="s">${sum.boxes} box · ${sum.tracks} track · ${result.seconds} s</div></div>
    <div class="tile"><div class="k">Lỗi</div><div class="v err num">${sum.errorGroups}</div><div class="s">${sum.errorBoxesPer100} box / 100</div></div>
    <div class="tile"><div class="k">Cảnh báo</div><div class="v warn num">${sum.warningGroups}</div><div class="s">${sum.warningBoxesPer100} box / 100</div></div>
    <div class="tile"><div class="k">Đã duyệt</div><div class="v num">${done}<span class="muted">/${findings.length}</span></div>
      <div class="bar"><i data-w="${pct}"></i></div><div class="s">${done ? `${yes} đúng · ${done - yes} báo nhầm` : 'chưa duyệt mục nào'}</div></div>
  </div>
  <div class="blind" title="Tool không kiểm những mục này: QC tự xem">Tool không kiểm ${result.coverage.notChecked.map((x) => `<span class="pill">${esc(x)}</span>`).join('')}
    ${result.coverage.disabledRules?.length ? `<span class="pill">tắt ${result.coverage.disabledRules.length} luật</span>` : ''}</div>`;
}

/** Số mục lỗi / cảnh báo ở từng frame → ô màu; bấm để lọc theo frame. */
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
  const cells = [];
  for (let fr = start; fr <= stop; fr += 1) {
    // Đậm nhạt theo số mục so với frame nhiều nhất của job; đỏ nếu có lỗi, vàng nếu chỉ cảnh báo.
    const e = err.get(fr) || 0, w = warn.get(fr) || 0, level = score(fr) ? Math.ceil((4 * score(fr)) / max) : 0;
    const cls = level ? `${e ? 'e' : 'w'}${level}` : '';
    cells.push(`<button class="${cls}${S.filter.frame === fr ? ' sel' : ''}${common.has(fr) ? ' common' : ''}" data-frame="${fr}"
      title="Frame ${fr}: ${e} lỗi, ${w} cảnh báo${common.has(fr) ? ' · nhiều track cùng nhảy' : ''}" aria-label="Frame ${fr}"></button>`);
  }
  return `<div class="card"><div class="card-h"><h2>Frame</h2><span class="hint">bấm để lọc</span>
    ${S.filter.frame !== null ? `<button class="chip-x right" data-act="clear-frame">frame ${S.filter.frame} ✕</button>` : ''}</div>
    <div class="heat">${cells.join('')}</div><div class="heat-axis"><span>${start}</span><span>${stop}</span></div></div>`;
}

function rulesHtml(result, reviews) {
  const rows = result.summary.perRule;
  if (!rows.length) return '<div class="card"><div class="card-h"><h2>Luật</h2></div><div class="muted">Không có vấn đề nào tool tự phát hiện.</div></div>';
  const max = Math.max(...rows.map((r) => r.groups));
  const twice = (t) => rows.filter((r) => r.title === t).length > 1;
  return `<div class="card"><div class="card-h"><h2>Luật</h2><span class="hint">số mục · đã duyệt ✓ / ✕</span></div><div class="rules">
    ${rows.map((r) => {
      const of = result.findings.filter((f) => f.rule === r.rule);
      const yes = of.filter((f) => reviews[f.key]?.verdict === 'confirmed').length, no = of.filter((f) => reviews[f.key]?.verdict === 'false_alarm').length;
      return `<button class="rule ${S.filter.rule === r.rule ? 'sel' : ''}" data-rule="${esc(r.rule)}" title="${esc(r.rule)}">
        <span class="sev-dot ${r.severity}"></span><span class="t">${esc(r.title)}${twice(r.title) ? ` <span class="muted">${esc(r.rule)}</span>` : ''}</span>
        <span class="track"><i class="${r.severity}" data-w="${Math.max(3, Math.round((r.groups / max) * 100))}"></i></span>
        <span class="n">${r.groups}</span><span class="rv">${yes || no ? `✓${yes} ✕${no}` : ''}</span></button>`;
    }).join('')}</div></div>`;
}

function listHtml(result, reviews) {
  const f = S.filter, all = result.findings;
  const bySev = (x) => (f.sev === 'all' || (f.sev === 'real' ? x.severity !== 'info' : x.severity === f.sev));
  const rest = (x) => (!f.rule || x.rule === f.rule) && (!f.label || x.label === f.label) && (!f.todo || !reviews[x.key])
    && (f.frame === null || x.frames.includes(f.frame))
    && (!f.text || `${x.title} ${x.short} ${x.message} ${x.label} ${x.otherLabel || ''} #${x.cvatId} #${x.otherCvatId}`.toLowerCase().includes(f.text.toLowerCase()));
  const shown = all.filter((x) => bySev(x) && rest(x));
  const count = (sev) => all.filter((x) => rest(x) && (sev === 'real' ? x.severity !== 'info' : x.severity === sev)).length;
  const seg = [['real', 'Cần xem'], ['error', 'Lỗi'], ['warning', 'Cảnh báo'], ['info', 'Thông tin']]
    .map(([v, t]) => `<button class="${f.sev === v ? 'on' : ''}" data-sev="${v}">${t} <span class="c">${count(v)}</span></button>`).join('');
  const labels = [...new Set(all.map((x) => x.label))].sort();
  const opt = (v, t) => `<option value="${esc(v)}"${v === f.label ? ' selected' : ''}>${esc(t)}</option>`;
  const ruleChip = f.rule ? `<button class="chip-x" data-act="clear-rule">${esc(all.find((x) => x.rule === f.rule)?.title || f.rule)} ✕</button>` : '';

  const items = shown.slice(0, 400).map((x) => {
    const r = reviews[x.key]?.verdict, open = S.open.has(x.key);
    const me = num(x.cvatId, x.serverId), them = x.other && num(x.otherCvatId, otherRef(x).serverId);
    const other = x.other ? `<span class="pair-with">↔ ${esc(x.otherLabel || '')} <b>${esc(them)}</b></span>` : '';
    // Mục theo cặp: lời ngắn viết theo một phía ("chồng 14% lên car #129"), bỏ vế sau vì cột object đã ghi cả cặp.
    const short = x.other ? x.short.replace(/ (lên|với) \S+ #\S+$/, '') : x.short;
    const openTitle = x.other ? `Mở frame trong CVAT, hiện mọi object: tìm ${me} và ${them} trong danh sách Objects` : `Mở trong CVAT, chỉ hiện ${me}`;
    return `<div class="item ${r ? 'done' : ''}">
      <span class="sev-dot ${x.severity}" title="${SEV[x.severity]}"></span>
      <div class="obj" title="Số như trong danh sách Objects của CVAT">${esc(x.label)} <b>${esc(me)}</b>${other}</div>
      <div class="what" data-toggle="${esc(x.key)}" title="Bấm để xem chi tiết"><b>${esc(x.title)}</b> <span>· ${esc(short)}</span></div>
      <div class="fr"><strong>${frameRange(x.frames)}</strong>${x.frames.length} frame</div>
      <div class="ops">
        <a class="icon-btn" href="${esc(cvatLink(x))}" target="_blank" rel="noopener" title="${esc(openTitle)}" aria-label="${esc(openTitle)}">↗</a>
        <button class="icon-btn yes ${r === 'confirmed' ? 'on' : ''}" data-verdict="confirmed" data-key="${esc(x.key)}" aria-pressed="${r === 'confirmed'}" title="Đúng: lỗi thật, trả về annotator" aria-label="Đúng">✓</button>
        <button class="icon-btn no ${r === 'false_alarm' ? 'on' : ''}" data-verdict="false_alarm" data-key="${esc(x.key)}" aria-pressed="${r === 'false_alarm'}" title="Báo nhầm" aria-label="Báo nhầm">✕</button>
      </div>
      ${open ? `<div class="more">${esc(x.message)}
        ${x.other ? `<div class="solo">Chỉ hiện một object: <a href="${esc(cvatLink(x, x.frames[0], x))}" target="_blank" rel="noopener">${esc(x.label)} ${esc(me)} · frame ${x.frames[0]} ↗</a>
          <a href="${esc(cvatLink(x, otherFrame(x), otherRef(x)))}" target="_blank" rel="noopener">${esc(x.otherLabel || '')} ${esc(them)} · frame ${otherFrame(x)} ↗</a></div>` : ''}
        ${x.rule === 'track.fragment' ? evidenceHtml(x) : ''}
        <div class="frames">${x.frames.slice(0, 120).map((fr) => `<a href="${esc(cvatLink(x, fr))}" target="_blank" rel="noopener">${fr}</a>`).join('')}${x.frames.length > 120 ? ' …' : ''}</div></div>` : ''}
    </div>`;
  }).join('');

  return `<div class="card"><div class="filters"><div class="seg" role="group" aria-label="Mức">${seg}</div>
      <div class="seg"><button class="${f.todo ? 'on' : ''}" data-act="todo">Chưa duyệt</button></div>
      <select data-filter="label" aria-label="Class">${opt('', 'Mọi class')}${labels.map((l) => opt(l, l)).join('')}</select>
      <input type="search" data-filter="text" placeholder="Tìm…" value="${esc(f.text)}" aria-label="Tìm">
      ${ruleChip}<span class="count">${shown.length} mục</span></div>
    <div class="list">${items || '<div class="empty">Không có mục nào.</div>'}</div>
    ${shown.length > 400 ? '<div class="foot">Hiện 400 mục đầu; lọc thêm để xem phần còn lại.</div>' : ''}</div>`;
}

function footHtml(result) {
  const c = result.coverage, parts = [`Quét ${new Date(result.startedAt).toLocaleString('vi-VN')}`,
    `guideline ${result.spec?.name || 'Mặc định'} v${result.spec?.version || 0}`];
  if (c.boxesWithoutGround) parts.push(`${c.boxesWithoutGround} box không đo được mặt đất (xa / thiếu điểm)`);
  if (c.framesWithoutPoints.length) parts.push(`${c.framesWithoutPoints.length} frame không đọc được point cloud`);
  if (c.chunkErrors.length) parts.push(c.chunkErrors[0]);
  if (c.fragmentsRejected) parts.push(`${c.fragmentsRejected} cặp nghi đứt track đã loại vì point cloud cho thấy hai vật`);
  if (c.egoWeakFrames?.length) parts.push(`${c.egoWeakFrames.length} frame khớp point cloud kém (chuyển động xe thu lấy theo frame bên cạnh)`);
  if (c.commonFrames?.length) parts.push(`frame ${c.commonFrames.map((x) => x.frame).join(', ')}: nhiều track cùng nhảy, không báo từng track (lệch thời điểm frame / chuyển động xe thu)`);
  return `<div class="foot">${parts.map((p) => `<span>${esc(p)}</span>`).join('')}</div>`;
}

function renderJob() {
  if (S.view !== 'jobs') return;
  const { run, result, reviews } = S.detail;
  let html = headHtml(result, run);
  if (!result) html += '<div class="empty">Chưa quét. Bấm <b>Quét job</b>.</div>';
  else html += summaryHtml(result, reviews) + heatHtml(result) + rulesHtml(result, reviews) + listHtml(result, reviews) + footHtml(result);
  const keep = document.activeElement?.dataset?.filter === 'text';
  $('#main').innerHTML = html;
  paintWidths();
  if (keep) { const el = $('[data-filter="text"]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

// ------------------------------------------------------------------ hình point cloud chỗ nối

const VERDICT_TEXT = { one: 'Point cloud: một cụm điểm ở chỗ nối, không thấy vật thứ hai.', unknown: 'Point cloud: không đủ điểm để kết luận.' };

/** Nút tải hình, hoặc hình nhìn từ trên (mỗi frame một ô) khi đã tải. */
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

function setView(view) {
  S.view = view;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === view);
  $('#layout').classList.toggle('no-side', view !== 'jobs');
  clearTimeout(S.poll);
  if (view === 'spec') return window.QCSpec.open();
  if (S.jobId) return refreshJob();
  $('#main').innerHTML = '<div class="empty">Chọn một job bên trái.</div>';
  return undefined;
}

// ------------------------------------------------------------------ sự kiện

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-view]');
  if (tab) return setView(tab.dataset.view);
  if (S.view !== 'jobs') return undefined;
  const jobBtn = e.target.closest('[data-job]');
  if (jobBtn) return openJob(Number(jobBtn.dataset.job));
  const act = e.target.closest('[data-act]')?.dataset.act;
  try {
    if (act === 'scan') { await api(`/api/jobs/${S.jobId}/scan`, { method: 'POST' }); return refreshJob(); }
    if (act === 'cancel') { await api(`/api/jobs/${S.jobId}/cancel`, { method: 'POST' }); return refreshJob(); }
    const v = e.target.closest('[data-verdict]');
    if (v) {
      const verdict = S.detail.reviews[v.dataset.key]?.verdict === v.dataset.verdict ? null : v.dataset.verdict;
      S.detail.reviews = await api(`/api/jobs/${S.jobId}/reviews`, { method: 'POST', body: JSON.stringify({ key: v.dataset.key, verdict }) });
      return renderJob();
    }
  } catch (error) {
    return toast(error.message);
  }
  if (act === 'clear-frame') { S.filter.frame = null; return renderJob(); }
  if (act === 'clear-rule') { S.filter.rule = ''; return renderJob(); }
  if (act === 'todo') { S.filter.todo = !S.filter.todo; return renderJob(); }
  const ev = e.target.closest('[data-evidence]');
  if (ev) {
    const key = ev.dataset.evidence;
    S.evidence.set(key, 'loading');
    renderJob();
    try { S.evidence.set(key, await api(`/api/jobs/${S.jobId}/evidence?key=${encodeURIComponent(key)}`)); } catch (error) { S.evidence.set(key, { error: error.message }); }
    return renderJob();
  }
  const sev = e.target.closest('[data-sev]');
  if (sev) { S.filter.sev = sev.dataset.sev; return renderJob(); }
  const frame = e.target.closest('[data-frame]');
  if (frame) { const fr = Number(frame.dataset.frame); S.filter.frame = S.filter.frame === fr ? null : fr; return renderJob(); }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) { const k = toggle.dataset.toggle; if (S.open.has(k)) S.open.delete(k); else S.open.add(k); return renderJob(); }
  const rule = e.target.closest('[data-rule]');
  if (rule) { S.filter.rule = S.filter.rule === rule.dataset.rule ? '' : rule.dataset.rule; return renderJob(); }
  return undefined;
});

document.addEventListener('change', (e) => {
  if (S.view === 'jobs' && e.target.dataset?.filter === 'label') { S.filter.label = e.target.value; renderJob(); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'job-filter') renderJobs();
  if (S.view === 'jobs' && e.target.dataset?.filter === 'text') {
    S.filter.text = e.target.value;
    clearTimeout(S.typing);
    S.typing = setTimeout(renderJob, 220);
  }
});

window.QC = { S, api, esc, toast, paintWidths, $ };

(async () => {
  await loadStatus();
  await loadJobs();
})();

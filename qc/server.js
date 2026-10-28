'use strict';
/*
 * PointSnap QC: dịch vụ quét cả job CVAT bằng bộ luật chung với extension annotator, kèm trang web xem kết quả.
 * Chạy: `node qc/server.js` (cấu hình ở qc/lib/config.js). Không thư viện ngoài; Node ≥ 20.
 * Token CVAT chỉ nằm ở máy chủ này, không gửi xuống trình duyệt.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./lib/config');
const { CvatClient } = require('./lib/cvat');
const { Auth } = require('./lib/auth');
const { Store } = require('./lib/store');
const { scanJob, fingerprint } = require('./lib/scan');
const Tracks = require('./lib/tracks');
const Box = require('../extension/src/annotator/box.js');
const { toCsv } = require('./lib/export');
const G = require('../extension/src/annotator/guideline.js');
const { RULES, FIELDS, QC_FULL_DEFAULTS, resolveSpec } = require('./lib/rules');

const config = loadConfig();
const store = new Store(config.home);
const client = config.cvatToken ? new CvatClient({ url: config.cvatUrl, token: config.cvatToken }) : null;
const PUBLIC = path.join(__dirname, 'public');
const EXTENSION = path.join(__dirname, '..', 'extension');
const ANNOTATOR_SCRIPTS = require('../extension/manifest.json').content_scripts.find((c) => c.world === 'MAIN').js;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const auth = new Auth({ cvatUrl: config.cvatUrl, qcUsers: config.qcUsers, store });

// ------------------------------------------------------------------ hàng đợi quét (một job một lúc)

const runs = new Map(); // jobId → { state: queued | running | done | error, progress, error, controller }
const queue = [];
let busy = false;

/** Guideline đang dùng cho project: của project, không có thì bản chung, không có nữa thì mặc định của extension. */
function guidelineFor(projectId) {
  const spec = store.spec(projectId);
  const { guideline, qc, errors } = resolveSpec(spec?.override || {});
  return { guideline, qc, errors, name: spec?.name || 'Mặc định', version: spec?.v || 0, project: spec?.project ?? null };
}

async function worker() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const jobId = queue.shift(), run = runs.get(jobId);
    if (!run || run.controller.signal.aborted) continue;
    run.state = 'running';
    try {
      const job = await client.job(jobId), task = await client.task(job.task_id);
      const spec = guidelineFor(task.project_id);
      const result = await scanJob({ client, jobId, guideline: spec.guideline, qc: spec.qc, gate: config.gate, signal: run.controller.signal,
        onProgress: (p) => { run.progress = p; } });
      result.spec = { name: spec.name, version: spec.version, project: spec.project, errors: spec.errors };
      store.saveScan(jobId, result);
      run.state = 'done';
    } catch (error) {
      run.state = 'error';
      run.error = error.message;
    }
  }
  busy = false;
}

function startScan(jobId) {
  const current = runs.get(jobId);
  if (current && (current.state === 'queued' || current.state === 'running')) return current;
  const run = { state: 'queued', progress: { done: 0, total: 0, phase: 'Chờ' }, error: null, controller: new AbortController() };
  runs.set(jobId, run);
  queue.push(jobId);
  worker();
  return run;
}

const publicRun = (run) => run && { state: run.state, progress: run.progress, error: run.error };

// ------------------------------------------------------------------ HTTP

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'", ...extra });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2e6) throw Object.assign(new Error('Dữ liệu quá lớn'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {
    throw Object.assign(new Error('JSON không hợp lệ'), { status: 400 });
  }
}

/**
 * Hình nhìn từ trên cho một mục: điểm LiDAR quanh các box liên quan và box đã gán, ở frame của mục (đứt track: frame cuối
 * đoạn trước và frame đầu đoạn sau), kèm box "ma" (chỗ vật kia lẽ ra ở). Đọc thẳng từ CVAT, không lưu lại.
 */
async function evidenceView(cvat, scan, finding) {
  const jobId = scan.job.id;
  const [labels, annotations, meta] = await Promise.all([cvat.labels(jobId), cvat.annotations(jobId), cvat.meta(jobId)]);
  const { frames, cvatIds } = Tracks.expand(annotations, labels, { start: scan.job.start, stop: scan.job.stop });
  const shown = finding.rule === 'track.fragment' ? [finding.frames[0], finding.frames[finding.frames.length - 1]] : [finding.frames[0]];
  const chunkSize = meta.chunk_size || scan.job.stop - scan.job.start + 1, chunks = new Map();
  const corners = (b) => Box.footprint(b).map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]);
  const out = [];
  for (const frame of shown) {
    const c = Math.floor((frame - scan.job.start) / chunkSize);
    if (!chunks.has(c)) chunks.set(c, await cvat.chunk(jobId, c));
    const positions = chunks.get(c)[(frame - scan.job.start) % chunkSize]?.positions;
    const objs = frames.get(frame) || [], main = objs.filter((o) => o.key === finding.objKey || o.key === finding.other);
    const ghosts = (finding.evidence?.ghosts || []).filter((g) => g.frame === frame)
      .map((g) => ({ center: [...g.center, 0], dims: [...g.dims, 1], rotation: [0, 0, g.yaw] }));
    const focus = [...main.map((o) => o.box), ...ghosts];
    if (!positions || !focus.length) { out.push({ frame, points: [], boxes: [], ghosts: [] }); continue; }
    const cx = focus.reduce((s, b) => s + b.center[0], 0) / focus.length, cy = focus.reduce((s, b) => s + b.center[1], 0) / focus.length;
    const R = 12, bottom = Math.min(...main.map((o) => Box.bottomZ(o.box)), Infinity);
    const points = [];
    for (let i = 0; i < positions.length && points.length < 15000; i += 3) {
      const x = positions[i], y = positions[i + 1];
      if (Math.abs(x - cx) > R || Math.abs(y - cy) > R) continue;
      // 1 = cao hơn đáy box 25 cm (thân vật), 0 = mặt đất.
      points.push(+x.toFixed(2), +y.toFixed(2), Number.isFinite(bottom) && positions[i + 2] > bottom + 0.25 ? 1 : 0);
    }
    const boxes = objs.filter((o) => Math.abs(o.box.center[0] - cx) < R + 3 && Math.abs(o.box.center[1] - cy) < R + 3)
      .map((o) => ({ cvatId: cvatIds.get(o.key), label: o.label, role: o.key === finding.objKey ? 'a' : o.key === finding.other ? 'b' : 'other', corners: corners(o.box) }));
    out.push({ frame, center: [cx, cy], range: R, points, boxes, ghosts: ghosts.map(corners) });
  }
  return { frames: out, verdict: finding.evidence?.verdict || null };
}

// Chặn dò mật khẩu: 8 lần sai trong 10 phút theo tên đăng nhập + địa chỉ.
const failures = new Map();
const failKey = (u, req) => `${String(u).toLowerCase()}|${req.socket?.remoteAddress || ''}`;
function loginBlocked(u, req) {
  const f = failures.get(failKey(u, req));
  return !!f && f.n >= 8 && Date.now() - f.at < 10 * 60 * 1000;
}
function loginFailed(u, req) {
  const k = failKey(u, req), f = failures.get(k);
  failures.set(k, f && Date.now() - f.at < 10 * 60 * 1000 ? { n: f.n + 1, at: f.at } : { n: 1, at: Date.now() });
}

const note = (me, text, kind = 'comment') => ({ by: me.username, name: me.name, role: me.role, at: new Date().toISOString(), text: String(text || '').slice(0, 1000), kind });

/** API phiếu: QC tạo / nghiệm thu / trả lại; annotator xem phiếu của mình, trả lời, nộp lại. */
async function ticketRoute(req, p, url, me) {
  // Người nhận phiếu: người dùng token thấy được, cộng người được giao job. Tài khoản không phải admin trên CVAT không dùng tổ
  // chức chỉ thấy chính mình ở /api/users, nên annotator lấy từ người được giao job.
  if (req.method === 'GET' && p === '/api/users') {
    const [users, jobs] = await Promise.all([client.all('/api/users'), client.jobs()]);
    const all = new Map();
    for (const u of [...users.filter((x) => x.is_active !== false), ...jobs.map((j) => j.assignee).filter(Boolean)]) {
      if (!all.has(u.username)) all.set(u.username, { username: u.username, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username, role: auth.roleOf(u) });
    }
    return { body: [...all.values()] };
  }
  if (req.method === 'GET' && p === '/api/tickets') {
    const job = Number(url.searchParams.get('job')) || null;
    const list = store.tickets().filter((t) => (me.role === 'qc' ? !job || t.jobId === job : t.assignee === me.username));
    return { body: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }
  // Gửi một lượt: mọi object QC đã trả lỗi (kèm lỗi ghi lúc duyệt) thành phiếu cho một annotator.
  if (req.method === 'POST' && p === '/api/tickets/batch') {
    const { jobId, assignee, keys = [] } = await readJson(req);
    const scan = store.scan(Number(jobId)), seen = store.objectReviews(Number(jobId));
    if (!scan?.objects) return { status: 400, body: { error: 'Job chưa quét' } };
    if (!assignee || !Array.isArray(keys)) return { status: 400, body: { error: 'Cần người nhận' } };
    const live = new Set(store.tickets().filter((t) => t.jobId === scan.job.id && t.status !== 'accepted').map((t) => t.objKey));
    const made = [];
    for (const key of keys) {
      const obj = scan.objects.find((o) => o.key === key), r = seen[key];
      if (!obj || r?.status !== 'returned' || live.has(key)) continue;
      const is = r.issue || { tags: [], frame: null, text: '' };
      const f = is.finding ? scan.findings.find((x) => x.key === is.finding) : null;
      const t = store.addTicket({ jobId: scan.job.id, taskId: scan.job.taskId, taskName: scan.job.taskName, objKey: key, kind: obj.kind, serverId: obj.serverId,
        cvatId: obj.cvatId, label: obj.label, frames: is.frame != null ? [is.frame, is.frame] : f ? [f.frames[0], f.frames[f.frames.length - 1]] : [obj.first, obj.last],
        rule: f ? f.rule : 'qc.manual', title: is.tags.join(' · ') || f?.title || 'QC trả lỗi', message: is.text || f?.message || '',
        priority: !is.tags.length && f && f.severity !== 'error' ? 'warn' : 'must', assignee: String(assignee), status: 'open', createdBy: me.username,
        fingerprint: obj.fingerprint,
        thread: [...(f ? [{ by: 'tool', name: 'Tool', role: 'bot', at: scan.startedAt, text: f.message, kind: 'tool' }] : []),
          { ...note({ username: r.by, name: r.by, role: 'qc' }, `${is.frame != null ? `Frame ${is.frame}: ` : ''}${is.text || is.tags.join(', ') || 'Xem lại object này'}`, 'assign'), at: r.at }] });
      store.setObjectReviews(scan.job.id, [{ key, fingerprint: r.fingerprint, issue: r.issue, ticket: t.id }], 'returned', r.by);
      made.push(t);
    }
    return { body: made };
  }
  // Phiếu "thiếu vật": QC thấy vật chưa có box, ghi theo frame + vị trí, không gắn object nào. Job không hoàn thành được tới khi
  // nghiệm thu phiếu này.
  if (req.method === 'POST' && p === '/api/tickets/missing') {
    const { jobId, assignee, label = '', frame, where = '', text = '' } = await readJson(req);
    const scan = store.scan(Number(jobId));
    if (!scan) return { status: 400, body: { error: 'Job chưa quét' } };
    if (!assignee) return { status: 400, body: { error: 'Cần người nhận' } };
    if (!Number.isInteger(frame) || frame < scan.job.start || frame > scan.job.stop) return { status: 400, body: { error: `Frame phải trong ${scan.job.start}–${scan.job.stop}` } };
    const lbl = String(label).trim().slice(0, 60) || 'vật', at = String(where).trim().slice(0, 200), msg = String(text).trim().slice(0, 500);
    const t = store.addTicket({ jobId: scan.job.id, taskId: scan.job.taskId, taskName: scan.job.taskName, objKey: null, kind: 'missing', serverId: null,
      cvatId: null, label: lbl, frames: [frame, frame], rule: 'qc.missing', title: 'Thiếu box', where: at, message: [at, msg].filter(Boolean).join(' · '),
      priority: 'must', assignee: String(assignee), status: 'open', createdBy: me.username, fingerprint: null,
      thread: [note(me, `Frame ${frame}: thiếu box ${lbl}${at ? ` ở ${at}` : ''}${msg ? `. ${msg}` : ''}`, 'assign')] });
    return { body: t };
  }
  const m = p.match(/^\/api\/tickets\/(BUG-\d+)\/(comment|submit|accept|return)$/);
  if (req.method === 'POST' && m) {
    const [, id, act] = m, { text = '' } = await readJson(req);
    const t = store.tickets().find((x) => x.id === id);
    if (!t) return { status: 404, body: { error: 'Không có phiếu này' } };
    if (me.role !== 'qc' && t.assignee !== me.username) return { status: 403, body: { error: 'Phiếu này không giao cho bạn' } };
    if ((act === 'accept' || act === 'return') && me.role !== 'qc') return { status: 403, body: { error: 'Chỉ QC nghiệm thu' } };
    const next = { submit: 'submitted', accept: 'accepted', return: 'returned' }[act];
    // Nộp / nghiệm thu: đọc lại object trên CVAT để biết annotator có sửa thật không, và để lần quét sau không bắt duyệt lại.
    const fp = (act === 'submit' || act === 'accept') && t.kind !== 'missing' ? await liveFingerprint(t).catch(() => null) : null;
    const updated = store.updateTicket(id, (x) => {
      if (next) x.status = next;
      if (act === 'submit') x.unchanged = !!fp && !!x.fingerprint && fp === x.fingerprint;
      if (String(text).trim() || act !== 'comment') x.thread.push(note(me, text, act));
    });
    if (act === 'accept') {
      const obj = store.scan(t.jobId)?.objects?.find((o) => o.key === t.objKey);
      if (fp || obj) store.setObjectReviews(t.jobId, [{ key: t.objKey, fingerprint: fp || obj.fingerprint, ticket: t.id }], 'ok', me.name);
    }
    return { body: updated };
  }
  return { status: 404, body: { error: 'Không có' } };
}

/** Dấu vân tay hiện tại của object của phiếu, đọc thẳng từ CVAT ('deleted' nếu object đã bị xoá). */
async function liveFingerprint(t) {
  const ann = await client.annotations(t.jobId);
  const item = ((t.kind === 'track' ? ann.tracks : ann.shapes) || []).find((x) => x.id === t.serverId);
  return item ? fingerprint(item) : 'deleted';
}

/** Lỗi QC ghi khi trả object: nhãn lỗi, frame thấy lỗi, ghi chú, mục tool báo liên quan. */
function cleanIssue(x) {
  return { tags: (Array.isArray(x.tags) ? x.tags : []).map((t) => String(t).slice(0, 40)).filter(Boolean).slice(0, 6),
    frame: Number.isInteger(x.frame) ? x.frame : null, text: String(x.text || '').slice(0, 500), finding: x.finding ? String(x.finding).slice(0, 200) : null };
}

/** Lần quét trước, rút gọn để so trước / sau theo object ở vòng duyệt lại: khoảng frame, số box, dấu vân tay, mục tool báo. */
function prevView(prev) {
  if (!prev?.objects) return null;
  return { startedAt: prev.startedAt,
    objects: Object.fromEntries(prev.objects.map((o) => [o.key, { first: o.first, last: o.last, boxes: o.boxes, fingerprint: o.fingerprint }])),
    findings: prev.findings.filter((f) => f.severity !== 'info').map((f) => ({ key: f.key, objKey: f.objKey, other: f.other || null, title: f.title, short: f.short })) };
}

/** Số object đã duyệt đúng theo nội dung hiện tại. */
function reviewedCount(jobId, scan) {
  const seen = store.objectReviews(jobId);
  return (scan.objects || []).filter((o) => seen[o.key] && seen[o.key].fingerprint === o.fingerprint).length;
}

/** Danh sách job 3D, kèm tên task và tóm tắt lần quét gần nhất. */
async function listJobs() {
  const [jobs, tasks] = await Promise.all([client.jobs(), client.all('/api/tasks?dimension=3d')]);
  const taskName = new Map(tasks.map((t) => [t.id, t]));
  return jobs.map((j) => {
    const scan = store.scan(j.id), t = taskName.get(j.task_id);
    return { id: j.id, taskId: j.task_id, taskName: t?.name || `Task ${j.task_id}`, projectId: t?.project_id ?? null,
      frames: j.stop_frame - j.start_frame + 1, stage: j.stage, state: j.state, assignee: j.assignee?.username || null,
      run: publicRun(runs.get(j.id)),
      last: scan && { startedAt: scan.startedAt, gate: scan.summary.gate.verdict, errors: scan.summary.errorGroups,
        warnings: scan.summary.warningGroups, boxes: scan.summary.boxes, tracks: scan.summary.tracks, objects: (scan.objects || []).length,
        reviewed: reviewedCount(j.id, scan), done: !!store.completion(j.id) && reviewedCount(j.id, scan) === (scan.objects || []).length } };
  }).sort((a, b) => b.id - a.id);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;

  // Trang dùng chung merge / diff guideline với extension.
  if (req.method === 'GET' && p === '/vendor/guideline.js') return send(res, 200, fs.readFileSync(require.resolve('../extension/src/annotator/guideline.js')), TYPES['.js']);
  // Bảng annotator cho plugin trong CVAT: đúng các script MAIN world của extension, theo thứ tự manifest, gộp một file.
  if (req.method === 'GET' && p === '/annotator-panel.js') return send(res, 200, ANNOTATOR_SCRIPTS.map((f) => fs.readFileSync(path.join(EXTENSION, f), 'utf8')).join(';\n'), TYPES['.js']);
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^([\\/])+/, ''));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'Không có' });
    // ảnh / font tĩnh cho cache để ảnh xe của hiệu ứng khởi động nạp trước được (no-store làm trình duyệt tải lại mỗi lần)
    const cache = /^\/(assets|fonts)\//.test(p) ? { 'Cache-Control': 'public, max-age=86400' } : {};
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream', cache);
  }
  // Chống trang khác gửi lệnh tới dịch vụ trên localhost: mọi lệnh ghi cần header riêng (trình duyệt không cho trang
  // khác gửi header này nếu không qua CORS, mà dịch vụ không mở CORS).
  if (req.method !== 'GET' && req.headers['x-pointsnap-qc'] !== '1') return send(res, 403, { error: 'Thiếu header X-PointSnap-QC' });
  if (!client && p !== '/api/status') return send(res, 503, { error: 'Chưa cấu hình CVAT_TOKEN' });

  // Đăng nhập bằng tài khoản CVAT; mọi API khác cần phiên.
  if (req.method === 'POST' && p === '/api/login') {
    const { username = '', password = '', remember = false } = await readJson(req);
    if (loginBlocked(username, req)) return send(res, 429, { error: 'Sai quá nhiều lần, thử lại sau 10 phút' });
    try {
      const user = await auth.verify(String(username).trim(), String(password));
      const { cookie } = auth.open(user, !!remember);
      return send(res, 200, user, undefined, { 'Set-Cookie': cookie });
    } catch (error) {
      if (error.status === 401) loginFailed(username, req);
      return send(res, error.status || 500, { error: error.message });
    }
  }
  if (req.method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': auth.close(req) });
  // Qua nginx của CVAT (plugin trong trang CVAT): người dùng là tài khoản đang đăng nhập CVAT, không lấy phiên web QC.
  // Cookie không phân biệt cổng, nên phiên đăng nhập web ở localhost:8766 cũng tới localhost:8080 và từng làm annotator
  // trong CVAT bị nhận là QC đã đăng nhập web. Header giả mạo không lợi gì: danh tính vẫn do CVAT xác nhận từ sessionid.
  const viaCvat = req.headers['x-forwarded-prefix'] === '/pointsnap-qc';
  const me = viaCvat ? await auth.fromCvatSession(req) : auth.session(req) || await auth.fromCvatSession(req);
  if (req.method === 'GET' && p === '/api/me') return me ? send(res, 200, { username: me.username, name: me.name, role: me.role }) : send(res, 401, { error: 'Chưa đăng nhập' });
  if (p !== '/api/status' && !me) return send(res, 401, { error: 'Chưa đăng nhập' });

  // Token cho extension (QC và annotator đều tạo được cho chính mình). Chỉ tạo / xoá từ trang QC đã đăng nhập, không bằng
  // chính token extension (lộ một token không đẻ được token khác).
  if (p === '/api/ext-tokens' || p.startsWith('/api/ext-tokens/')) {
    if (req.method === 'GET' && p === '/api/ext-tokens') return send(res, 200, auth.tokensOf(me.username));
    if (me.via) return send(res, 403, { error: 'Tạo / xoá token từ trang QC' });
    if (req.method === 'POST' && p === '/api/ext-tokens') { const { label = '' } = await readJson(req); return send(res, 200, auth.issueToken(me, label)); }
    const t = p.match(/^\/api\/ext-tokens\/([0-9a-f]+)$/);
    if (req.method === 'DELETE' && t) return auth.revokeToken(me.username, t[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Không có token này' });
    return send(res, 404, { error: 'Không có' });
  }
  // Annotator chỉ xem / trả lời phiếu của mình và xem guideline; còn lại là việc của QC.
  const annotatorMay = (req.method === 'GET' && (p === '/api/tickets' || p.startsWith('/api/specs/') || p === '/api/status'))
    || (req.method === 'POST' && /^\/api\/tickets\/BUG-\d+\/(comment|submit)$/.test(p));
  if (me && me.role !== 'qc' && !annotatorMay) return send(res, 403, { error: 'Chỉ QC làm được việc này' });

  // Phiếu giao việc sửa lỗi.
  if (p === '/api/tickets' || p.startsWith('/api/tickets/') || p === '/api/users') {
    const r = await ticketRoute(req, p, url, me);
    return send(res, r.status || 200, r.body);
  }

  if (req.method === 'GET' && p === '/api/status') {
    if (!client) return send(res, 200, { ok: false, cvatUrl: config.cvatUrl, error: 'Chưa cấu hình CVAT_TOKEN (xem qc/README.md)' });
    try {
      const [about, self] = await Promise.all([client.about(), client.self()]);
      return send(res, 200, { ok: true, cvatUrl: config.cvatUrl, version: about.version, user: self.username, gate: config.gate });
    } catch (error) {
      return send(res, 200, { ok: false, cvatUrl: config.cvatUrl, error: error.message });
    }
  }
  if (req.method === 'GET' && p === '/api/jobs') return send(res, 200, await listJobs());

  const m = p.match(/^\/api\/jobs\/(\d+)(\/[\w.]+)?$/);
  if (m) {
    const jobId = Number(m[1]), action = m[2] || '';
    if (req.method === 'GET' && action === '') {
      const result = store.scan(jobId), now = result && guidelineFor(result.job.projectId);
      // Guideline đã đổi sau lần quét thì trang nhắc quét lại.
      const specNow = now && { name: now.name, version: now.version, project: now.project };
      return send(res, 200, { run: publicRun(runs.get(jobId)), result, reviews: store.reviews(jobId), specNow,
        objectReviews: store.objectReviews(jobId), completion: store.completion(jobId), prev: prevView(store.prevScan(jobId)),
        missing: store.tickets().filter((t) => t.jobId === jobId && t.kind === 'missing') });
    }
    // Duyệt object: lưu kèm dấu vân tay lúc duyệt, để track bị sửa sau đó tự về "Chưa xem".
    if (req.method === 'POST' && action === '/objects') {
      const { keys, status = null, issue = null } = await readJson(req), by = me.name;
      const result = store.scan(jobId);
      if (!result) return send(res, 404, { error: 'Job chưa quét' });
      if (!Array.isArray(keys) || ![null, 'ok', 'returned'].includes(status)) return send(res, 400, { error: 'keys / status sai' });
      const known = new Map((result.objects || []).map((o) => [o.key, o.fingerprint])), prev = store.objectReviews(jobId);
      // Trả lỗi lại object đã có phiếu thì giữ liên kết phiếu (không tạo phiếu trùng).
      const items = keys.filter((k) => known.has(k)).map((key) => ({ key, fingerprint: known.get(key),
        ...(status === 'returned' && issue && { issue: cleanIssue(issue) }), ...(status === 'returned' && prev[key]?.ticket && { ticket: prev[key].ticket }) }));
      return send(res, 200, store.setObjectReviews(jobId, items, status, by));
    }
    // Hoàn thành duyệt: chỉ khi mọi object đã duyệt theo đúng nội dung hiện tại.
    if (req.method === 'POST' && action === '/complete') {
      await readJson(req);
      const by = me.name;
      const result = store.scan(jobId), seen = store.objectReviews(jobId);
      if (!result) return send(res, 404, { error: 'Job chưa quét' });
      const left = (result.objects || []).filter((o) => !seen[o.key] || seen[o.key].fingerprint !== o.fingerprint);
      if (left.length) return send(res, 409, { error: `Còn ${left.length} object chưa duyệt` });
      const unsent = result.objects.filter((o) => seen[o.key].status === 'returned' && !seen[o.key].ticket).length;
      if (unsent) return send(res, 409, { error: `Còn ${unsent} lỗi chưa gửi annotator` });
      const open = store.tickets().filter((t) => t.jobId === jobId && t.status !== 'accepted'), missing = open.filter((t) => t.kind === 'missing').length;
      if (open.length) return send(res, 409, { error: `Còn ${open.length} phiếu sửa lỗi chưa nghiệm thu${missing ? ` (${missing} phiếu thiếu vật)` : ''}` });
      const done = { at: new Date().toISOString(), by: String(by).slice(0, 60), scanAt: result.startedAt, objects: result.objects.length };
      store.setCompletion(jobId, done);
      return send(res, 200, done);
    }
    if (req.method === 'GET' && action === '/evidence') {
      const scan = store.scan(jobId), finding = scan?.findings.find((f) => f.key === url.searchParams.get('key'));
      if (!finding) return send(res, 404, { error: 'Không có mục này trong lần quét gần nhất' });
      return send(res, 200, await evidenceView(client, scan, finding));
    }
    if (req.method === 'POST' && action === '/scan') return send(res, 202, publicRun(startScan(jobId)));
    if (req.method === 'POST' && action === '/cancel') {
      runs.get(jobId)?.controller.abort();
      return send(res, 200, publicRun(runs.get(jobId)));
    }
    if (req.method === 'POST' && action === '/reviews') {
      const { key, verdict = null, note = '' } = await readJson(req);
      if (typeof key !== 'string' || ![null, 'confirmed', 'false_alarm'].includes(verdict)) return send(res, 400, { error: 'key / verdict sai' });
      return send(res, 200, store.setReview(jobId, key, verdict, note));
    }
    if (req.method === 'GET' && (action === '/export.csv' || action === '/export.json')) {
      const scan = store.scan(jobId);
      if (!scan) return send(res, 404, { error: 'Job chưa quét' });
      const reviews = store.reviews(jobId);
      res.setHeader('Content-Disposition', `attachment; filename="pointsnap-qc-job-${jobId}${action.slice(7)}"`);
      return action.endsWith('.csv')
        ? send(res, 200, toCsv(scan, reviews, config.cvatUrl), 'text/csv; charset=utf-8')
        : send(res, 200, { ...scan, reviews });
    }
  }

  if (req.method === 'GET' && p === '/api/projects') {
    const projects = await client.all('/api/projects');
    return send(res, 200, projects.map((x) => ({ id: x.id, name: x.name })));
  }

  // Guideline theo project: xem (kèm mặc định, danh mục luật / ô ngưỡng, lịch sử), lưu phiên bản mới, khôi phục bản cũ.
  const s = p.match(/^\/api\/specs\/(default|\d+)(\/restore)?$/);
  if (s) {
    const projectId = s[1] === 'default' ? null : Number(s[1]);
    if (req.method === 'GET' && !s[2]) {
      const now = guidelineFor(projectId), own = store.specHistory(projectId).versions;
      return send(res, 200, { ...now, override: store.spec(projectId)?.override || {}, inherited: !own.length && now.version > 0,
        versions: own.map(({ v, name, note, at }) => ({ v, name, note, at })).reverse(),
        defaults: { guideline: G.DEFAULT_GUIDELINE, qc: QC_FULL_DEFAULTS }, rules: RULES, fields: FIELDS });
    }
    if (req.method === 'PUT' && !s[2]) {
      const { name = '', note = '', override } = await readJson(req);
      if (!override || typeof override !== 'object' || Array.isArray(override)) return send(res, 400, { error: 'Thiếu override (object JSON)' });
      const { errors } = resolveSpec(override);
      if (errors.length) return send(res, 400, { error: errors[0], errors });
      return send(res, 200, { ok: true, version: store.addSpecVersion(projectId, { name, note, override }) });
    }
    if (req.method === 'POST' && s[2]) {
      const { v } = await readJson(req);
      const old = store.specHistory(projectId).versions.find((x) => x.v === v);
      if (!old) return send(res, 404, { error: `Không có phiên bản ${v}` });
      return send(res, 200, { ok: true, version: store.addSpecVersion(projectId, { name: old.name, note: `Khôi phục bản ${v}`, override: old.override }) });
    }
  }
  return send(res, 404, { error: 'Không có' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    try {
      send(res, error.status || 500, { error: error.message });
    } catch (_) {}
  });
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log(`PointSnap QC: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}  (CVAT ${config.cvatUrl}${client ? '' : ', CHƯA có CVAT_TOKEN'})`);
  });
}

module.exports = { server, route };

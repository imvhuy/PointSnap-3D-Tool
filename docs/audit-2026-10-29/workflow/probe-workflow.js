'use strict';
// Probe kiểm toán: assertion xác nhận lỗi đang tái hiện, KHÔNG phải test nghiệm thu sản phẩm.
// Chỉ dùng fixture giả + fetch giả; không đọc .env.local, không mở cổng hoặc gọi CVAT thật.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const ROOT = path.resolve(__dirname, '../../..');
const { Store } = require(path.join(ROOT, 'qc/lib/store'));
const { fingerprint } = require(path.join(ROOT, 'qc/lib/scan'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pointsnap-audit-workflow-'));
const store = new Store(home);
const reports = [];
const users = { qcuser: 'QC', ann: 'Annotator', limited: 'QC hạn chế' };
const A = { id: 9, label_id: 1, frame: 0, shapes: [{ id: 1, frame: 0, points: [0, 0, 0, 0, 0, 0, 4, 2, 1.5], outside: false }] };
const B = { ...structuredClone(A), id: 10, shapes: [{ ...structuredClone(A.shapes[0]), id: 2, points: [1, 0, 0, 0, 0, 0, 4, 2, 1.5] }] };
let live = { tags: [], shapes: [], tracks: [structuredClone(A)] };
let annotationCalls = 0;
let holdNext = false, heldReady, readyResolve, release;
const originalFetch = global.fetch;
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
global.fetch = async (url, options = {}) => {
  const u = new URL(url), p = u.pathname;
  assert.equal(u.origin, 'http://cvat-audit.invalid', 'Không được truy cập mạng thật');
  const authorization = options.headers?.Authorization || '';
  if (p === '/api/auth/login') {
    const { username, password } = JSON.parse(options.body);
    return users[username] && password === 'pw' ? json(200, { key: `k-${username}` }) : json(400, { detail: 'bad' });
  }
  if (p === '/api/auth/logout') return json(200, {});
  if (p === '/api/users/self') {
    const username = authorization === 'Bearer svc' ? 'qcuser' : authorization.replace(/^Token k-/, '');
    return users[username] ? json(200, { username, first_name: users[username], groups: [] }) : json(401, {});
  }
  if (p === '/api/jobs/7/annotations') {
    if (authorization === 'Token k-limited') return json(403, { detail: 'Job thuộc project khác' });
    annotationCalls += 1;
    if (holdNext) { holdNext = false; readyResolve(); await new Promise((r) => { release = r; }); }
    return json(200, live);
  }
  if (p === '/api/jobs') return json(200, { results: [{ id: 7, task_id: 3, start_frame: 0, stop_frame: 10, stage: 'validation', state: 'new', assignee: { username: 'ann' } }], next: null });
  if (p === '/api/tasks') return json(200, { results: [{ id: 3, name: 'Fixture', project_id: 1 }], next: null });
  return json(404, {});
};

// Nạp router nguyên bản nhưng tiêm config giả để tuyệt đối không đọc .env.local của người dùng.
const filename = path.join(ROOT, 'qc/server.js');
const baseRequire = createRequire(filename);
function mockRequire(name) {
  if (name === './lib/config') return { loadConfig: () => ({ cvatUrl: 'http://cvat-audit.invalid', cvatToken: 'svc', home,
    qcUsers: ['qcuser', 'limited'], gate: { maxWarningsPer100: 5 } }) };
  return baseRequire(name);
}
mockRequire.resolve = baseRequire.resolve;
const mod = { exports: {} };
const context = vm.createContext({ Buffer, URL, AbortController, AbortSignal, console, setTimeout, clearTimeout, process: { on() {} } });
vm.runInContext(`(function(exports,require,module,__filename,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`, context,
  { filename })(mod.exports, mockRequire, mod, filename, path.dirname(filename));
const { route } = mod.exports;
async function call(method, url, cookie = '', body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { 'x-pointsnap-qc': '1', cookie }, socket: { remoteAddress: 'audit-fixture' } });
  let status, headers, content;
  const res = { writeHead(s, h) { status = s; headers = h; }, end(x) { content = x; }, setHeader() {} };
  await route(req, res);
  return { status, headers, body: typeof content === 'string' ? JSON.parse(content) : content };
}
function seed(tracks = [A], findings = []) {
  store.saveTickets([]);
  store.setObjectReviews(7, Object.keys(store.objectReviews(7)).map((key) => ({ key })), null);
  const objects = tracks.map((x) => ({ key: `track:${x.id}`, kind: 'track', serverId: x.id, cvatId: x.id, label: 'car', first: 0, last: 10, fingerprint: fingerprint(x) }));
  store.saveScan(7, { job: { id: 7, taskId: 3, projectId: 1, taskName: 'Fixture', start: 0, stop: 10 }, startedAt: new Date().toISOString(),
    spec: { name: 'Mặc định', version: 0, project: null }, findings, objects,
    summary: { gate: { verdict: 'ĐẠT' }, errorGroups: 0, warningGroups: 0, boxes: objects.length, tracks: objects.length } });
  live = { tags: [], shapes: [], tracks: structuredClone(tracks) };
}
async function mark(qc, key, status, issue = null) { return call('POST', '/api/jobs/7/objects', qc, { keys: [key], status, issue }); }
async function batch(qc, key) { return (await call('POST', '/api/tickets/batch', qc, { jobId: 7, assignee: 'ann', keys: [key] })).body[0]; }

(async () => {
  const login = async (username, password = 'pw') => call('POST', '/api/login', '', { username, password });
  const cookie = (r) => r.headers['Set-Cookie'].split(';')[0];
  const qc = cookie(await login('qcuser')), ann = cookie(await login('ann')), limited = cookie(await login('limited'));

  seed();
  await mark(qc, 'track:9', 'ok');
  live.tracks[0].shapes[0].points[2] += 2;
  live.tracks.push(structuredClone(B));
  const before = annotationCalls;
  const staleDone = await call('POST', '/api/jobs/7/complete', qc, {});
  assert.equal(staleDone.status, 200);
  assert.equal(annotationCalls, before);
  reports.push({ id: 'WF-01', severity: 'P1', expected: 'Từ chối hoàn thành hoặc yêu cầu quét lại khi nhãn live đổi/thêm object',
    actual: { http: staleDone.status, completedObjects: staleDone.body.objects, liveObjects: live.tracks.length, freshAnnotationReads: annotationCalls - before } });

  const missing = await call('POST', '/api/tickets/missing', qc, { jobId: 7, assignee: 'ann', frame: 0, label: 'car' });
  assert.equal(missing.status, 200);
  const blocked = await call('POST', '/api/jobs/7/complete', qc, {});
  const listing = await call('GET', '/api/jobs', qc);
  assert.equal(blocked.status, 409);
  assert.equal(listing.body[0].last.done, true);
  reports.push({ id: 'WF-02', severity: 'P2', expected: 'Tạo phiếu mới phải vô hiệu trạng thái hoàn thành', actual: { completionApi: blocked.status, listDone: listing.body[0].last.done } });

  seed();
  await mark(qc, 'track:9', 'returned', { tags: ['Lơ lửng'] });
  const oldTicket = await batch(qc, 'track:9');
  assert.equal((await call('POST', `/api/tickets/${oldTicket.id}/recall`, qc, {})).status, 200);
  const scan = store.scan(7); scan.objects.push({ key: 'track:10', kind: 'track', serverId: 10, cvatId: 10, label: 'car', first: 0, last: 10, fingerprint: fingerprint(B) }); store.saveScan(7, scan);
  live.tracks.push(structuredClone(B));
  await mark(qc, 'track:10', 'returned', { tags: ['Sai kích thước'] });
  const newTicket = await batch(qc, 'track:10');
  assert.equal(newTicket.id, oldTicket.id);
  const staleSubmit = await call('POST', `/api/tickets/${oldTicket.id}/submit`, ann, { text: 'Từ tab cũ của vật 9' });
  assert.equal(staleSubmit.body.objKey, 'track:10');
  reports.push({ id: 'WF-03', severity: 'P1', expected: 'ID phiếu không tái sử dụng; tab cũ không được cập nhật phiếu mới',
    actual: { oldId: oldTicket.id, oldObject: oldTicket.objKey, newId: newTicket.id, submittedObject: staleSubmit.body.objKey, status: staleSubmit.body.status } });

  seed();
  await mark(qc, 'track:9', 'returned', { tags: ['Lơ lửng'] });
  const t = await batch(qc, 'track:9');
  await call('POST', `/api/tickets/${t.id}/submit`, ann, {});
  heldReady = new Promise((r) => { readyResolve = r; }); holdNext = true;
  const delayedSubmit = call('POST', `/api/tickets/${t.id}/submit`, ann, { text: 'Nộp chậm' });
  await heldReady;
  assert.equal((await call('POST', `/api/tickets/${t.id}/accept`, qc, {})).body.status, 'accepted');
  release();
  const resurrected = await delayedSubmit;
  assert.equal(resurrected.body.status, 'submitted');
  reports.push({ id: 'WF-04', severity: 'P1', expected: 'Phiếu accepted không được request nộp chạy trước đó mở lại',
    actual: { afterAccept: 'accepted', afterDelayedSubmit: resurrected.body.status, objectReview: store.objectReviews(7)['track:9'].status } });

  seed([A, B], [{ key: 'pair', rule: 'overlap', title: 'Chồng lấn', short: '20%', message: 'Hai vật chồng', frames: [0], severity: 'error', objKey: 'track:9', other: 'track:10' }]);
  await mark(qc, 'track:9', 'returned', { tags: ['Chồng lấn'], findings: ['pair'] });
  const pair = await batch(qc, 'track:9');
  live.tracks[1].shapes[0].points[0] = 10;
  const pairSub = await call('POST', `/api/tickets/${pair.id}/submit`, ann, {});
  assert.equal(pairSub.body.unchanged, true);
  reports.push({ id: 'WF-05', severity: 'P2', expected: 'Theo dõi dấu vân tay mọi vật trong lỗi theo cặp',
    actual: { secondObjectChanged: true, ticketUnchanged: pairSub.body.unchanged } });

  const direct = await global.fetch('http://cvat-audit.invalid/api/jobs/7/annotations', { headers: { Authorization: 'Token k-limited' } });
  const indirect = await call('GET', '/api/jobs/7', limited);
  assert.equal(direct.status, 403); assert.equal(indirect.status, 200); assert.equal(indirect.body.result.job.id, 7);
  reports.push({ id: 'WF-06', severity: 'P1 nếu nhiều project có ACL riêng', expected: 'Phải chốt QC toàn cục hay kế thừa ACL CVAT',
    actual: { cvatUserAccess: direct.status, qcServiceAccess: indirect.status, scanVisible: true }, note: 'QC_USERS hiện cấp quyền QC toàn cục theo thiết kế; cần đổi nếu phải bảo toàn ACL theo project/job.' });

  for (let i = 0; i < 8; i += 1) assert.equal((await login('qcuser', 'bad')).status, 401);
  assert.equal((await login('qcuser', 'bad')).status, 429);
  const trimBypass = await login('qcuser ', 'bad');
  assert.equal(trimBypass.status, 401);
  reports.push({ id: 'WF-07', severity: 'P2', expected: 'Chuẩn hoá username trước khi tính khóa dò mật khẩu',
    actual: { blockedRaw: 429, sameNormalizedUserWithSpace: trimBypass.status } });
  console.log(JSON.stringify({ baseline: 'e845e7d', methodology: 'Router thật, Store thật, CVAT fetch giả, config tiêm không đọc .env.local; assertion xác nhận lỗi hiện tại', reports }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  const prefix = path.resolve(os.tmpdir(), 'pointsnap-audit-workflow-');
  if (!path.resolve(home).startsWith(prefix)) throw new Error('Không xoá ngoài thư mục fixture');
  fs.rmSync(home, { recursive: true, force: true });
});

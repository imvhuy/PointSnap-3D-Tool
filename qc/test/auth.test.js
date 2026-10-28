'use strict';
// Đăng nhập bằng tài khoản CVAT + luồng phiếu QC → annotator → QC, chạy dịch vụ thật với một CVAT giả (không cần mật khẩu thật).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../lib/store');
const { fingerprint } = require('../lib/scan');

const USERS = { qcuser: 'Chị QC', ann: 'An Nguyễn', bob: 'Bob' };
// Nhãn job 7 trên CVAT giả: test đổi `ANN.tracks[0]` để giả annotator đã sửa và Lưu.
const TRACK = { id: 9, label_id: 1, frame: 0, shapes: [{ id: 1, frame: 0, points: [0, 0, 0, 0, 0, 0, 4, 2, 1.5], outside: false }] };
const ANN = { tags: [], shapes: [], tracks: [TRACK] };

function fakeCvat() {
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = (s, v) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const p = req.url.split('?')[0], token = String(req.headers.authorization || '').split(' ')[1];
    if (p === '/api/auth/login') {
      const { username, password } = JSON.parse(body);
      return USERS[username] && password === 'pw' ? json(200, { key: `k-${username}` }) : json(400, { detail: 'bad' });
    }
    if (p === '/api/auth/logout') return json(200, {});
    if (p === '/api/server/about') return json(200, { version: 'test' });
    if (p === '/api/users/self') {
      // Phiên trình duyệt của CVAT: cookie sessionid=s-<user>.
      const sess = String(req.headers.cookie || '').match(/sessionid=s-(\w+)/);
      const u = sess ? sess[1] : token === 'svc' ? 'qcuser' : String(token).replace(/^k-/, '');
      return USERS[u] ? json(200, { username: u, first_name: USERS[u], groups: [] }) : json(401, {});
    }
    if (p === '/api/users') return json(200, { results: Object.keys(USERS).map((u) => ({ username: u, first_name: USERS[u] })), next: null });
    if (p === '/api/jobs/7/annotations') return json(200, ANN);
    // carol không có trong /api/users (token không phải admin chỉ thấy chính mình) nhưng được giao job 7.
    if (p === '/api/jobs') return json(200, { results: [{ id: 7, task_id: 3, assignee: { username: 'carol', first_name: 'Carol' } }], next: null });
    return json(404, {});
  });
}

test('đăng nhập CVAT, vai trò, phiếu giao việc QC → annotator → QC', async (t) => {
  const cvat = fakeCvat();
  await new Promise((r) => cvat.listen(0, '127.0.0.1', r));
  const home = path.join(os.tmpdir(), `pointsnap-qc-auth-${process.pid}`);
  const store = new Store(home);
  const fp0 = fingerprint(TRACK);
  store.saveScan(7, { job: { id: 7, taskId: 3, taskName: 'T', start: 0, stop: 10 }, startedAt: new Date().toISOString(),
    findings: [{ key: 'f1', rule: 'ground.gap', title: 'Lơ lửng', message: 'Box lơ lửng 0.3 m', frames: [2, 3], severity: 'error', objKey: 'track:9' }],
    objects: [{ key: 'track:9', kind: 'track', serverId: 9, cvatId: 5, label: 'car', first: 0, last: 10, fingerprint: fp0 },
      { key: 'track:10', kind: 'track', serverId: 10, cvatId: 6, label: 'car', first: 0, last: 10, fingerprint: 'x10' },
      { key: 'track:11', kind: 'track', serverId: 11, cvatId: 7, label: 'pedestrian', first: 0, last: 10, fingerprint: 'x11' }] });
  const port = 20000 + (process.pid % 20000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: 'ignore',
    env: { ...process.env, CVAT_URL: `http://127.0.0.1:${cvat.address().port}`, CVAT_TOKEN: 'svc', QC_PORT: String(port), QC_HOST: '127.0.0.1', QC_HOME: home, QC_USERS: 'qcuser' } });
  t.after(() => { srv.kill(); cvat.close(); });

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, { cookie = '', body, bearer } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-PointSnap-QC': '1', Cookie: cookie, ...(bearer && { Authorization: `Bearer ${bearer}` }) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${base}/api/status`); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  const login = async (username, password = 'pw') => call('POST', '/api/login', { body: { username, password } });

  assert.equal((await call('GET', '/api/jobs')).status, 401, 'chưa đăng nhập');
  assert.equal((await call('GET', '/api/status')).status, 200, 'trạng thái vẫn mở');
  assert.equal((await login('ann', 'sai')).status, 401);
  const qc = await login('qcuser'), ann = await login('ann'), bob = await login('bob');
  assert.equal(qc.body.role, 'qc');
  assert.equal(ann.body.role, 'annotator');
  assert.match(qc.cookie, /^qc_session=/);
  assert.equal((await call('GET', '/api/me', { cookie: ann.cookie })).body.username, 'ann');
  // Trong trang CVAT (qua nginx, X-Forwarded-Prefix): theo tài khoản đang đăng nhập CVAT, bỏ qua phiên web QC còn sót.
  const viaCvat = async (cookie) => (await fetch(`${base}/api/me`, { headers: { Cookie: cookie, 'X-Forwarded-Prefix': '/pointsnap-qc' } })).json();
  assert.deepEqual(await viaCvat(`${qc.cookie}; sessionid=s-ann`), { username: 'ann', name: 'An Nguyễn', role: 'annotator' });
  assert.equal((await viaCvat(qc.cookie)).username, undefined, 'không có phiên CVAT thì không nhận phiên web QC');
  assert.equal((await call('GET', '/api/jobs', { cookie: ann.cookie })).status, 403, 'annotator không xem kết quả quét');
  const users = (await call('GET', '/api/users', { cookie: qc.cookie })).body;
  assert.equal(users.find((u) => u.username === 'ann').role, 'annotator');
  assert.deepEqual(users.find((u) => u.username === 'carol'), { username: 'carol', name: 'Carol', role: 'annotator' }, 'người được giao job cũng nhận phiếu được');

  // Bảng annotator cho plugin trong CVAT: các script MAIN world của extension gộp một file, parse được, theo thứ tự manifest.
  const bundle = await (await fetch(`${base}/annotator-panel.js`)).text();
  assert.doesNotThrow(() => new Function(bundle));
  assert.ok(bundle.indexOf('root.PointSnapBox = api') < bundle.indexOf('root.PointSnapAnnotator = '), 'box.js trước annotator.js');

  // QC duyệt từng object: trả lỗi hai cái (ghi lỗi, chưa gửi ai), OK một cái.
  const mark = (keys, status, issue) => call('POST', '/api/jobs/7/objects', { cookie: qc.cookie, body: { keys, status, issue } });
  await mark(['track:9'], 'returned', { tags: ['Lơ lửng'], frame: 3, text: 'Hạ đáy box', finding: 'f1' });
  await mark(['track:11'], 'returned', { tags: ['Sai class'] });
  await mark(['track:10'], 'ok');
  assert.match((await call('POST', '/api/jobs/7/complete', { cookie: qc.cookie, body: {} })).body.error, /2 lỗi chưa gửi/);

  // Gửi một lượt: mỗi object một phiếu; gửi lại không tạo trùng.
  assert.equal((await call('POST', '/api/tickets/batch', { cookie: ann.cookie, body: { jobId: 7, assignee: 'ann', keys: ['track:9'] } })).status, 403);
  const sent = await call('POST', '/api/tickets/batch', { cookie: qc.cookie, body: { jobId: 7, assignee: 'ann', keys: ['track:9', 'track:11', 'track:10'] } });
  assert.deepEqual(sent.body.map((x) => [x.objKey, x.title, x.status]), [['track:9', 'Lơ lửng', 'open'], ['track:11', 'Sai class', 'open']]);
  const [t9, t11] = sent.body;
  assert.deepEqual(t9.frames, [3, 3]);
  assert.deepEqual(t9.thread.map((m) => m.role), ['bot', 'qc'], 'kèm lời tool báo và ghi chú của QC');
  assert.match(t9.thread[1].text, /^Frame 3: Hạ đáy box/);
  assert.equal(new Store(home).objectReviews(7)['track:9'].ticket, t9.id);
  assert.equal((await call('POST', '/api/tickets/batch', { cookie: qc.cookie, body: { jobId: 7, assignee: 'ann', keys: ['track:9'] } })).body.length, 0);

  assert.equal((await call('GET', '/api/tickets', { cookie: ann.cookie })).body.length, 2);
  assert.equal((await call('GET', '/api/tickets', { cookie: bob.cookie })).body.length, 0, 'chỉ thấy phiếu của mình');
  assert.equal((await call('POST', `/api/tickets/${t9.id}/submit`, { cookie: bob.cookie, body: {} })).status, 403);
  assert.equal((await call('POST', `/api/tickets/${t9.id}/accept`, { cookie: ann.cookie, body: {} })).status, 403, 'annotator không tự nghiệm thu');

  // Nộp khi chưa sửa / chưa Lưu trên CVAT: phiếu ghi "chưa đổi" để QC thấy.
  assert.equal((await call('POST', `/api/tickets/${t9.id}/submit`, { cookie: ann.cookie, body: { text: 'Xong' } })).body.unchanged, true);
  assert.equal((await call('POST', `/api/tickets/${t9.id}/return`, { cookie: qc.cookie, body: { text: 'Chưa thấy sửa' } })).body.status, 'returned');
  ANN.tracks = [{ ...TRACK, shapes: [{ ...TRACK.shapes[0], points: [0, 0, -0.3, 0, 0, 0, 4, 2, 1.5] }] }];
  const sub = await call('POST', `/api/tickets/${t9.id}/submit`, { cookie: ann.cookie, body: { text: 'Đã hạ đáy' } });
  assert.equal(sub.body.status, 'submitted');
  assert.equal(sub.body.unchanged, false);
  assert.equal(sub.body.thread.at(-1).name, 'An Nguyễn');
  assert.match((await call('POST', '/api/jobs/7/complete', { cookie: qc.cookie, body: {} })).body.error, /2 phiếu sửa lỗi chưa nghiệm thu/);

  // Nghiệm thu: object OK theo bản đã sửa trên CVAT (quét lại không bắt duyệt lần nữa).
  assert.equal((await call('POST', `/api/tickets/${t9.id}/accept`, { cookie: qc.cookie, body: {} })).body.status, 'accepted');
  const r9 = new Store(home).objectReviews(7)['track:9'];
  assert.equal(r9.status, 'ok');
  assert.equal(r9.fingerprint, fingerprint(ANN.tracks[0]));
  await call('POST', `/api/tickets/${t11.id}/accept`, { cookie: qc.cookie, body: {} });
  // track:11 không có trên CVAT giả → coi như đã xoá; vẫn OK để job khoá theo dấu vân tay của lần quét.
  await mark(['track:9', 'track:11'], 'ok');
  assert.equal((await call('POST', '/api/jobs/7/complete', { cookie: qc.cookie, body: {} })).status, 200);

  // Phiếu thiếu vật: theo frame + vị trí, không gắn object; khoá hoàn thành tới khi nghiệm thu; nộp không đọc object trên CVAT.
  const miss = (cookie, body) => call('POST', '/api/tickets/missing', { cookie, body: { jobId: 7, assignee: 'ann', ...body } });
  assert.equal((await miss(ann.cookie, { frame: 4 })).status, 403, 'annotator không tự tạo phiếu');
  assert.match((await miss(qc.cookie, { frame: 99 })).body.error, /Frame phải trong 0–10/);
  const tm = (await miss(qc.cookie, { frame: 4, label: 'pedestrian', where: 'vỉa hè bên phải, ~12 m', text: 'Người đi bộ chưa có box' })).body;
  assert.deepEqual([tm.kind, tm.objKey, tm.frames, tm.title, tm.status], ['missing', null, [4, 4], 'Thiếu box', 'open']);
  assert.match(tm.thread[0].text, /^Frame 4: thiếu box pedestrian ở vỉa hè/);
  assert.equal((await call('GET', '/api/jobs/7', { cookie: qc.cookie })).body.missing.length, 1, 'trang QC thấy phiếu thiếu vật');
  assert.match((await call('POST', '/api/jobs/7/complete', { cookie: qc.cookie, body: {} })).body.error, /1 phiếu thiếu vật/);
  assert.equal((await call('POST', `/api/tickets/${tm.id}/submit`, { cookie: ann.cookie, body: { text: 'Đã thêm box' } })).body.unchanged, false);
  assert.equal((await call('POST', `/api/tickets/${tm.id}/accept`, { cookie: qc.cookie, body: {} })).body.status, 'accepted');
  assert.equal((await call('POST', '/api/jobs/7/complete', { cookie: qc.cookie, body: {} })).status, 200);

  // Quét lại: giữ lần quét trước để vòng duyệt lại so trước / sau theo object.
  const again = new Store(home), old = again.scan(7);
  again.saveScan(7, { ...old, startedAt: new Date().toISOString(), findings: [], objects: old.objects.map((o) => (o.key === 'track:9' ? { ...o, last: 8, fingerprint: 'moi' } : o)) });
  const prev = (await call('GET', '/api/jobs/7', { cookie: qc.cookie })).body.prev;
  assert.deepEqual([prev.objects['track:9'].last, prev.objects['track:9'].fingerprint, prev.findings.map((f) => f.key)], [10, fp0, ['f1']]);

  // Token cho extension: tạo từ trang QC, mang vai trò người tạo, không tự đẻ token, xoá là mất quyền.
  const qt = (await call('POST', '/api/ext-tokens', { cookie: qc.cookie, body: { label: 'Edge' } })).body;
  assert.match(qt.token, /^psq_/);
  assert.equal(qt.hash, undefined, 'không trả hash');
  assert.deepEqual((await call('GET', '/api/me', { bearer: qt.token })).body, { username: 'qcuser', name: 'Chị QC', role: 'qc' });
  assert.equal((await call('GET', '/api/jobs/7', { bearer: qt.token })).status, 200);
  assert.equal((await call('POST', '/api/ext-tokens', { bearer: qt.token, body: {} })).status, 403, 'token không tạo được token');
  assert.deepEqual((await call('GET', '/api/ext-tokens', { cookie: qc.cookie })).body.map((t) => [t.label, t.hash]), [['Edge', undefined]]);
  const at = (await call('POST', '/api/ext-tokens', { cookie: ann.cookie, body: {} })).body;
  assert.equal((await call('GET', '/api/jobs/7', { bearer: at.token })).status, 403, 'token annotator vẫn chỉ có quyền annotator');
  assert.equal((await call('GET', '/api/tickets', { bearer: at.token })).body.length, 3, '2 phiếu object + 1 phiếu thiếu vật');
  assert.equal((await call('GET', '/api/ext-tokens', { cookie: bob.cookie })).body.length, 0, 'không thấy token người khác');
  assert.equal((await call('DELETE', `/api/ext-tokens/${qt.id}`, { cookie: bob.cookie })).status, 404, 'không xoá được token người khác');
  assert.equal((await call('DELETE', `/api/ext-tokens/${qt.id}`, { cookie: qc.cookie })).status, 200);
  assert.equal((await call('GET', '/api/me', { bearer: qt.token })).status, 401, 'token đã xoá');
  assert.equal((await call('GET', '/api/me', { bearer: 'psq_sai' })).status, 401);

  // Plugin trong trang CVAT: không đăng nhập riêng, dịch vụ nhận người dùng từ phiên CVAT (cookie sessionid).
  assert.deepEqual((await call('GET', '/api/me', { cookie: 'sessionid=s-ann; csrftoken=x' })).body, { username: 'ann', name: 'An Nguyễn', role: 'annotator' });
  assert.equal((await call('GET', '/api/me', { cookie: 'sessionid=s-qcuser' })).body.role, 'qc');
  assert.equal((await call('GET', '/api/jobs/7', { cookie: 'sessionid=s-ann' })).status, 403, 'phiên CVAT của annotator vẫn chỉ có quyền annotator');
  assert.equal((await call('GET', '/api/me', { cookie: 'sessionid=s-nobody' })).status, 401, 'phiên CVAT không hợp lệ');
  assert.equal((await call('POST', '/api/ext-tokens', { cookie: 'sessionid=s-qcuser', body: {} })).status, 403);

  await call('POST', '/api/logout', { cookie: ann.cookie });
  assert.equal((await call('GET', '/api/me', { cookie: ann.cookie })).status, 401);
});

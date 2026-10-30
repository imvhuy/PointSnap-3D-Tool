'use strict';
// Probe audit: assertion xác nhận lỗi đang tồn tại tại e845e7d, không phải test nghiệm thu.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'qc/public/plugin.js'), 'utf8');
const stop = source.indexOf("  document.documentElement.dataset.pointsnapPlugin = '1';");
assert.ok(stop > 0, 'Không tìm thấy ranh giới trước bootstrap DOM');
const sandbox = { window: { addEventListener() {} }, document: {}, setTimeout, console };
vm.createContext(sandbox);
vm.runInContext(source.slice(0, stop) + '\n globalThis.audit = { P, goTo };\n}());', sandbox);

(async () => {
  const target = { kind: 'track', serverId: 7, clientID: 202 };
  const state = { annotation: { player: { frame: { number: 0 } }, annotations: { filters: [], states: [
    { objectType: 'shape', serverID: 7, clientID: 101 },
    { objectType: 'track', serverID: 7, clientID: 202 },
  ] } } };
  const actions = [];
  sandbox.audit.P.ctx = { store: { getState: () => state }, dispatch: (a) => actions.push(a), actionCreators: {} };
  // Các callsite hiện tại chỉ truyền serverId, bỏ kind của target.
  const ok = await sandbox.audit.goTo(target.serverId, 0);
  assert.equal(ok, true);
  const selected = actions.find((a) => a.type === 'ACTIVATE_OBJECT').payload.activatedStateID;
  assert.equal(selected, 101);
  assert.notEqual(selected, target.clientID);
  const result = { id: 'INT-01', expected: { kind: 'track', clientID: 202 },
    actual: { success: ok, selectedClientID: selected, selectedKind: 'shape' },
    scope: 'VM dùng hàm goTo nguyên bản; store CVAT giả có shape/track trùng serverID, chưa chạy browser/CVAT thật' };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });

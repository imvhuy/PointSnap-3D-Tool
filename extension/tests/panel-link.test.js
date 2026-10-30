'use strict';

/* Đường đi của bảng PointSnap ở cửa sổ riêng: controller (panel-link.js, MAIN world) ↔ panel-bridge.js (ISOLATED world)
 * ↔ cổng chrome.runtime của cửa sổ bảng. Hai world dùng chung một `window.postMessage` như trong trình duyệt. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ORIGIN = 'http://localhost:8080';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'annotator', f), 'utf8');

/** Một trang: `window` chung, thông điệp giao không đồng bộ như postMessage thật. */
function page() {
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    postMessage: (data) => setImmediate(() => listeners.slice().forEach((fn) => fn({ source: win, origin: ORIGIN, data: structuredClone(data) }))),
  };
  return win;
}

/** chrome.* tối thiểu cho bridge: onConnect, sendMessage. */
function chromeApi() {
  const connects = [], sent = [];
  return {
    sent,
    connect: (port) => connects.forEach((fn) => fn(port)),
    api: { runtime: { id: 'ext', onConnect: { addListener: (fn) => connects.push(fn) }, sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } },
  };
}

/** Hai đầu của một cổng: `remote` là phía cửa sổ bảng. */
function portPair() {
  const make = () => ({ msg: [], disc: [], peer: null, received: [] });
  const a = make(), b = make();
  a.peer = b; b.peer = a;
  const side = (s) => ({
    name: 'pointsnap-panel', sender: { id: 'ext' },
    postMessage: (m) => setImmediate(() => { s.peer.received.push(m); s.peer.msg.forEach((fn) => fn(m)); }),
    onMessage: { addListener: (fn) => s.msg.push(fn) },
    onDisconnect: { addListener: (fn) => s.disc.push(fn) },
    disconnect: () => setImmediate(() => s.peer.disc.forEach((fn) => fn())),
  });
  return { local: side(a), remote: side(b), received: b.received };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const win = page(), chrome = chromeApi();
  const ctx = { window: win, location: { origin: ORIGIN }, document: { documentElement: { dataset: {} } }, chrome: chrome.api, globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('panel-link.js'), ctx);
  vm.runInContext(read('panel-bridge.js'), ctx);
  const actions = [];
  const link = ctx.PointSnapPanelLink.create((name, data) => actions.push([name, data]));
  return { link, chrome, actions };
}

test('bảng ở cửa sổ riêng: chưa có cửa sổ thì không gửi gì; cửa sổ nối thì nhận view-model và gửi thao tác về', async () => {
  const { link, chrome, actions } = setup();
  await tick();
  assert.equal(link.isOpen(), false);
  link.render({ status: 'ready', frame: 1 });

  const port = portPair();
  chrome.connect(port.local);
  await tick();
  assert.equal(link.isOpen(), true);
  assert.ok(actions.some(([n]) => n === 'rerender'), 'cửa sổ vừa nối thì controller vẽ lại ngay');
  link.render({ status: 'ready', frame: 2 });
  link.render({ status: 'ready', frame: 2 });
  await tick();
  assert.deepEqual(port.received.map((m) => m.vm.frame), [2], 'view-model trùng không gửi lại');

  port.remote.postMessage({ type: 'action', name: 'snap-track', data: { a: 1 } });
  await tick();
  assert.deepEqual(actions.filter(([n]) => n !== 'rerender'), [['snap-track', { a: 1 }]]);

  port.remote.disconnect();
  await tick();
  assert.equal(link.isOpen(), false, 'đóng cửa sổ thì controller thôi đo / vẽ');
});

test('bảng ở cửa sổ riêng: cửa sổ nối lại nhận ngay view-model cuối; Alt+Shift+P nhờ service worker mở / đóng', async () => {
  const { link, chrome } = setup();
  const first = portPair();
  chrome.connect(first.local);
  await tick();
  link.render({ status: 'ready', frame: 7 });
  await tick();
  first.remote.disconnect();
  await tick();

  const again = portPair();
  chrome.connect(again.local);
  await tick();
  assert.equal(again.received[0]?.vm?.frame, 7);

  link.toggle();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.sent)), [{ type: 'togglePanel' }]);
});

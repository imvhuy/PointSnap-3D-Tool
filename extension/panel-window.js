'use strict';
/*
 * Cửa sổ bảng PointSnap (popup riêng của extension, không nhúng vào CVAT): nối vào tab CVAT `?tab=` qua
 * chrome.tabs.connect tới panel-bridge.js, hiện view-model trang gửi sang bằng chính panel.js, gửi thao tác bấm về.
 * Trang tải lại / đổi job thì cổng đứt: tự nối lại mỗi giây. Tab đóng thì service worker đóng cửa sổ này.
 */

const Panel = globalThis.PointSnapAnnotatorPanel;
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const RETRY_MS = 1000;
// Phím tắt như trong trang CVAT (Alt+Shift+…); P đóng cửa sổ.
const KEYS = new Set(['KeyF', 'KeyG', 'KeyD']);
let port = null;

const view = Panel.mount(document.getElementById('root'), (name, data) => {
  // Trình sửa spec mở trong trang CVAT: đưa cửa sổ CVAT lên trước để thấy nó.
  if (name === 'open-spec') chrome.tabs.get(tabId).then((tab) => chrome.windows.update(tab.windowId, { focused: true })).catch(() => {});
  if (port) port.postMessage({ type: 'action', name, data });
});

function waiting(message) {
  view.render({ status: 'waiting', message });
}

function connect() {
  try {
    port = chrome.tabs.connect(tabId, { name: 'pointsnap-panel', frameId: 0 });
  } catch (_) {
    port = null;
  }
  if (!port) {
    setTimeout(connect, RETRY_MS);
    return;
  }
  port.onMessage.addListener((m) => {
    if (m?.type === 'vm' && m.vm) view.render(m.vm);
  });
  port.onDisconnect.addListener(() => {
    // Đọc lastError để Chrome không báo "Could not establish connection" khi trang chưa có bridge.
    void chrome.runtime.lastError;
    port = null;
    waiting('Đang chờ trang CVAT (trang đang tải, hoặc PointSnap chưa chạy trên trang này)…');
    setTimeout(connect, RETRY_MS);
  });
}

async function main() {
  if (!Panel || !Number.isInteger(tabId)) {
    waiting('Không rõ tab CVAT nào: mở bảng từ biểu tượng PointSnap trên tab CVAT.');
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    waiting('Tab CVAT đã đóng.');
    return;
  }
  document.title = `PointSnap · ${tab.title || 'CVAT'}`;
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (id === tabId && change.title) document.title = `PointSnap · ${change.title}`;
  });
  waiting('Đang nối với trang CVAT…');
  connect();
}

window.addEventListener('keydown', (event) => {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'KeyP') {
    event.preventDefault();
    window.close();
  } else if (KEYS.has(event.code) && port) {
    event.preventDefault();
    port.postMessage({ type: 'action', name: 'shortcut', data: { code: event.code } });
  }
});

main();

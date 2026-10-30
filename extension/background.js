/*
 * Service worker của extension PointSnap cho CVAT: đăng ký content script cho các địa chỉ CVAT khác mặc định mà người
 * dùng đã bật (nút trong popup) và đã cấp quyền; mở / đóng cửa sổ bảng PointSnap của từng tab CVAT.
 */
'use strict';

importScripts('hosts.js');

const DEFAULTS = { cvatUrls: [] };

/**
 * Đăng ký content script cho các địa chỉ CVAT đã bật (chỉ những địa chỉ đã được cấp quyền). Chạy nối tiếp: lưu
 * danh sách và cấp quyền cùng lúc kích hoạt hai lần đồng bộ, chạy song song thì đăng ký trùng id.
 */
let syncQueue = Promise.resolve();
function syncContentScripts() {
  syncQueue = syncQueue.then(registerForEnabledHosts).catch(() => {});
  return syncQueue;
}

async function registerForEnabledHosts() {
  const { cvatUrls } = await chrome.storage.sync.get(DEFAULTS);
  const matches = [];
  for (const url of cvatUrls || []) {
    try {
      const origin = PointSnapHosts.httpOrigin(url);
      if (PointSnapHosts.isBuiltIn(origin)) continue;
      const pattern = `${origin}/*`;
      if (!matches.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
    } catch (_) {
      // Bỏ qua địa chỉ không hợp lệ.
    }
  }
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ids = registered.map((s) => s.id).filter((id) => id.startsWith('pointsnap-'));
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  if (!matches.length) return;
  // Cùng danh sách script với manifest cho các địa chỉ CVAT thêm ở Tùy chọn, không chép tay hai nơi.
  await chrome.scripting.registerContentScripts(chrome.runtime.getManifest().content_scripts.map((script, index) => ({
    id: `pointsnap-${index}`, matches, js: script.js, runAt: script.run_at, world: script.world || 'ISOLATED',
    persistAcrossSessions: true,
  })));
}

/**
 * Bật PointSnap cho một CVAT (nút trong popup): thêm origin vào danh sách, đăng ký content script, bật cấu hình
 * annotator của origin, tải lại tab. Popup ghi `pendingEnable` trước khi xin quyền: hộp xin quyền có thể làm popup
 * đóng, khi đó việc còn lại chạy ở đây khi quyền được cấp (permissions.onAdded).
 */
async function finishEnable() {
  const { pendingEnable } = await chrome.storage.local.get({ pendingEnable: null });
  if (!pendingEnable) return { ok: false, error: 'Không có yêu cầu bật nào' };
  const { origin, tabId } = pendingEnable;
  if (!PointSnapHosts.isBuiltIn(origin) && !await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
    return { ok: false, error: 'Chưa được cấp quyền cho địa chỉ này' };
  }
  await chrome.storage.local.remove('pendingEnable');
  const { cvatUrls } = await chrome.storage.sync.get(DEFAULTS);
  if (!PointSnapHosts.isBuiltIn(origin) && !(cvatUrls || []).includes(origin)) {
    await chrome.storage.sync.set({ cvatUrls: [...(cvatUrls || []), origin] });
  }
  await PointSnapHosts.saveProfile(origin, { enabled: true });
  await syncContentScripts();
  if (Number.isInteger(tabId)) await chrome.tabs.reload(tabId).catch(() => {});
  return { ok: true };
}

// ------------------------------------------------------------------ cửa sổ bảng PointSnap (một cửa sổ cho một tab CVAT)

const PANEL_SIZE = { width: 380, height: 820 };

/** { tabId: windowId } của cửa sổ bảng đang mở; giữ ở storage.session vì service worker có thể bị dừng bất cứ lúc nào. */
async function panelWindows() {
  return (await chrome.storage.session.get({ panelWindows: {} })).panelWindows;
}

async function panelWindowFor(tabId) {
  const id = (await panelWindows())[tabId];
  return id ? chrome.windows.get(id).then(() => id).catch(() => null) : null;
}

/**
 * Mở cửa sổ bảng cho `tabId` (đã mở thì đưa lên trước; `toggle` thì đóng). Cửa sổ kiểu popup, lần đầu đặt sát mép
 * phải cửa sổ CVAT, các lần sau ở vị trí / cỡ người dùng kéo lần trước.
 */
async function openPanel(tabId, toggle = false) {
  const existing = await panelWindowFor(tabId);
  if (existing) {
    if (toggle) await chrome.windows.remove(existing);
    else await chrome.windows.update(existing, { focused: true });
    return { ok: true };
  }
  const tab = await chrome.tabs.get(tabId);
  const host = await chrome.windows.get(tab.windowId);
  const { panelBounds } = await chrome.storage.local.get({ panelBounds: null });
  const width = panelBounds?.width || PANEL_SIZE.width;
  const height = panelBounds?.height || Math.min(PANEL_SIZE.height, host.height || PANEL_SIZE.height);
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`panel-window.html?tab=${tabId}`), type: 'popup', focused: true, width, height,
    left: panelBounds?.left ?? Math.max(0, (host.left || 0) + (host.width || width) - width - 16),
    top: panelBounds?.top ?? (host.top || 0) + 80,
  });
  await chrome.storage.session.set({ panelWindows: { ...(await panelWindows()), [tabId]: win.id } });
  return { ok: true };
}

async function forgetPanelWindow(windowId) {
  const map = await panelWindows();
  const tabId = Object.keys(map).find((t) => map[t] === windowId);
  if (tabId === undefined) return;
  delete map[tabId];
  await chrome.storage.session.set({ panelWindows: map });
}

chrome.windows.onRemoved.addListener((windowId) => { forgetPanelWindow(windowId); });
chrome.windows.onBoundsChanged.addListener(async (win) => {
  if (Object.values(await panelWindows()).includes(win.id)) {
    await chrome.storage.local.set({ panelBounds: { left: win.left, top: win.top, width: win.width, height: win.height } });
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const id = await panelWindowFor(tabId);
  if (id) chrome.windows.remove(id).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Alt+Shift+P trong trang CVAT (panel-bridge.js): mở / đóng cửa sổ của chính tab đó.
  if (message?.type === 'togglePanel' && Number.isInteger(sender.tab?.id)) {
    openPanel(sender.tab.id, true).catch((error) => ({ ok: false, error: error.message })).then(sendResponse);
    return true;
  }
  if (!(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  if (message?.type === 'openPanel' && Number.isInteger(message.tabId)) {
    openPanel(message.tabId).catch((error) => ({ ok: false, error: error.message })).then(sendResponse);
    return true;
  }
  if (!['enableHost', 'syncScripts'].includes(message?.type)) return false;
  (message.type === 'enableHost' ? finishEnable() : syncContentScripts().then(() => ({ ok: true }))).then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => { syncContentScripts(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.cvatUrls) syncContentScripts();
});
chrome.permissions.onAdded.addListener(() => { finishEnable().finally(syncContentScripts); });
chrome.permissions.onRemoved.addListener(() => { syncContentScripts(); });

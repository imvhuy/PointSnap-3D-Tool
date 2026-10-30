/*
 * Service worker của extension PointSnap cho CVAT: đăng ký content script cho các địa chỉ CVAT khác mặc định mà người
 * dùng đã bật (nút trong side panel) và đã cấp quyền; bấm biểu tượng mở side panel.
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
 * Bật PointSnap cho một CVAT (nút trong side panel): thêm origin vào danh sách, đăng ký content script, bật cấu hình
 * annotator của origin, tải lại tab. Side panel ghi `pendingEnable` trước khi xin quyền: hộp xin quyền có thể làm side panel
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['enableHost', 'syncScripts'].includes(message?.type) || !(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  (message.type === 'enableHost' ? finishEnable() : syncContentScripts().then(() => ({ ok: true }))).then(sendResponse);
  return true;
});

// Bấm biểu tượng PointSnap (hoặc Alt+Shift+P, lệnh _execute_action) mở side panel: bảng luôn mở cạnh CVAT, không tự
// đóng khi bấm vào trang như popup.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => { syncContentScripts(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.cvatUrls) syncContentScripts();
});
chrome.permissions.onAdded.addListener(() => { finishEnable().finally(syncContentScripts); });
chrome.permissions.onRemoved.addListener(() => { syncContentScripts(); });

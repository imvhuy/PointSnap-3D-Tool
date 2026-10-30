'use strict';
/*
 * Side panel của extension (bấm biểu tượng PointSnap hoặc Alt+Shift+P): gắn ở mép phải trình duyệt, ngoài trang CVAT,
 * luôn mở khi thao tác trên CVAT; tự đổi theo tab đang xem.
 * - PointSnap đang chạy trên một job 3D: hiện bảng PointSnap của tab đó (checklist, dải track, sửa cả track…), nối vào
 *   trang qua chrome.tabs.connect tới panel-bridge.js; bảng dựng bằng chính panel.js. Trang tải lại thì tự nối lại.
 * - Còn lại: nhận ra tab có phải CVAT không, bật PointSnap cho địa chỉ đó bằng một nút, cho biết PointSnap đã chạy đúng
 *   chưa (đọc PointSnapAnnotator.health() trong trang).
 */

const Hosts = globalThis.PointSnapHosts;
const TESTED_CVAT = ['2.75.1'];
const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };

function setSite(kind, text, sub = '') {
  $('site').className = `status ${kind}`;
  $('site-text').textContent = text;
  $('site-sub').textContent = sub;
}

/** Hỏi trang đang mở (quyền activeTab khi bấm biểu tượng): phiên bản CVAT và tình trạng PointSnap trong trang. */
async function probe(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const about = await fetch('/api/server/about', { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const ps = window.PointSnapAnnotator;
        // Các file của PointSnap đã nạp vào trang chưa: thiếu hết là trình duyệt chưa chèn script, thiếu một phần là
        // một file lỗi lúc nạp.
        const parts = ['PointSnapBox', 'PointSnapGuideline', 'PointSnapChecks', 'PointSnapCvatAdapter', 'PointSnapAnnotatorPanel', 'PointSnapAnnotator'];
        let health = null, error = null;
        try { health = ps && ps.health ? ps.health() : null; } catch (e) { error = e.message; }
        return {
          cvat: about && /annotation tool/i.test(about.name || '') ? { version: about.version || '' } : null,
          health, error, loaded: parts.filter((k) => k in window), parts,
          loading: document.readyState !== 'complete' || !window.cvatUI,
        };
      },
    });
    return result || null;
  } catch (error) {
    return { probeError: error.message };
  }
}

/** Vì sao PointSnap chưa chạy trong trang: { text, sub, fix } với fix = 'reload' | 'register'. */
async function diagnose(origin, page) {
  // Địa chỉ nằm trong danh sách "không cho phép tiện ích" của trình duyệt: mọi extension bị chặn, kể cả đã cấp quyền.
  if (/blocked/i.test(page?.probeError || '')) {
    return { text: 'Trình duyệt đang chặn mọi tiện ích trên địa chỉ này', fix: 'reload',
      sub: 'Bấm biểu tượng Tiện ích (mảnh ghép) trên thanh địa chỉ, bật cho phép tiện ích trên trang này; hoặc gỡ địa chỉ khỏi danh sách không cho phép ở trang Tiện ích → Quyền truy cập trang web. Rồi tải lại trang.' };
  }
  if (!page || page.probeError) {
    return { text: 'Extension không đọc được trang này', fix: 'reload',
      sub: `${page?.probeError || ''} Kiểm tra quyền truy cập trang của PointSnap trong trang Tiện ích của trình duyệt.`.trim() };
  }
  if (page.error) return { text: 'PointSnap lỗi trong trang', sub: page.error, fix: 'reload' };
  // Trình duyệt chỉ chèn PointSnap sau khi code của CVAT chạy xong. Lần đầu mở, CVAT tải ~10 MB, mạng chậm có thể mất
  // nửa phút: báo đang tải, không bảo tải lại (tải lại là chờ lại từ đầu).
  if (!page.loaded.length && page.loading) {
    return { text: 'CVAT đang tải', sub: 'PointSnap tự chạy khi trang tải xong. Mở lại bảng này sau ít giây.', fix: null };
  }
  if (!page.loaded.length) {
    const scripts = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
    const registered = Hosts.isBuiltIn(origin) || scripts.some((s) => (s.matches || []).includes(`${origin}/*`));
    if (!registered) return { text: 'PointSnap chưa đăng ký cho địa chỉ này', sub: 'Bấm nút dưới để đăng ký lại và tải lại trang.', fix: 'register' };
    return { text: 'Trình duyệt chưa chèn PointSnap vào trang', fix: 'reload',
      sub: 'Tải lại trang. Vẫn vậy thì mở trang Tiện ích, mục PointSnap: Quyền truy cập trang web → cho phép trên địa chỉ này.' };
  }
  const missing = page.parts.filter((k) => !page.loaded.includes(k));
  return { text: 'PointSnap lỗi khi khởi động', fix: 'reload',
    sub: `Chưa nạp được ${missing.join(', ')}. Bấm "Lỗi" ở mục PointSnap trong trang Tiện ích để xem chi tiết.` };
}

function renderChecks(health) {
  const items = [
    [health.store, 'Đã nhận dữ liệu của CVAT', 'Chưa nhận được dữ liệu của CVAT: tải lại trang'],
    [health.job3d, 'Đang mở job 3D', 'Mở một job 3D (point cloud) để dùng bảng PointSnap'],
  ];
  if (health.startError) items.push([false, '', `PointSnap lỗi khi khởi động: ${health.startError}`, 'err']);
  if (health.guidelineErrors) items.push([false, '', `Bộ ngưỡng có ${health.guidelineErrors} lỗi, đang dùng mặc định`, 'warn']);
  $('checks').innerHTML = '';
  for (const [ok, good, bad, badKind = 'err'] of items) {
    const li = document.createElement('li');
    li.className = ok ? 'ok' : badKind;
    li.textContent = ok ? good : bad;
    $('checks').appendChild(li);
  }
  show('checks');
}

async function renderProfile(origin) {
  const { local } = await Hosts.readAll();
  const profile = Hosts.profileFor(local, origin);
  $('guideline-name').textContent = profile.guidelineName || 'Mặc định';
  $('site-enabled').checked = profile.enabled;
  $('site-enabled').onchange = () => Hosts.saveProfile(origin, { enabled: $('site-enabled').checked });
  $('change-guideline').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${encodeURIComponent(origin)}`) });
  };
  show('profile');
}

/** Bật cho `origin`: ghi yêu cầu trước (side panel có thể bị đóng khi Chrome hỏi quyền), xin quyền, để service worker làm nốt. */
async function enable(origin, tabId) {
  await chrome.storage.local.set({ pendingEnable: { origin, tabId } });
  const granted = Hosts.isBuiltIn(origin) || await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    await chrome.storage.local.remove('pendingEnable');
    setSite('err', 'Chưa được cấp quyền', 'PointSnap cần quyền chạy trên địa chỉ này để hiện bảng trong CVAT.');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'enableHost' });
  if (res && res.ok === false && !/Không có yêu cầu/.test(res.error)) {
    setSite('err', 'Chưa bật được', res.error);
    return;
  }
  setSite('ok', 'Đã bật PointSnap', 'Đang tải lại trang…');
}

// Phím tắt như trong trang CVAT, bấm được cả khi đang ở side panel.
const PANEL_KEYS = new Set(['KeyF', 'KeyG', 'KeyD']);
const RETRY_MS = 1000;
let tabId = null, port = null, view = null, refreshTimer = 0, refreshing = false, again = false;

/** Bảng PointSnap của tab đang xem: view-model từ trang, thao tác bấm gửi về trang. */
function showPanel(origin) {
  document.body.classList.add('with-panel');
  show('setup', false);
  show('panel');
  show('panel-foot');
  $('panel-origin').textContent = origin.replace(/^https?:\/\//, '');
  $('panel-setup').textContent = 'Cài đặt trang này';
  view = view || globalThis.PointSnapAnnotatorPanel.mount($('panel'), (name, data) => port?.postMessage({ type: 'action', name, data }));
  if (port) return;
  view.render({ status: 'waiting', message: 'Đang nối với trang CVAT…' });
  const p = chrome.tabs.connect(tabId, { name: 'pointsnap-panel', frameId: 0 });
  port = p;
  p.onMessage.addListener((m) => { if (m?.type === 'vm' && m.vm) view.render(m.vm); });
  p.onDisconnect.addListener(() => {
    // Đọc lastError để Chrome không báo "Could not establish connection" khi trang đang tải lại.
    void chrome.runtime.lastError;
    if (port !== p) return;
    port = null;
    view.render({ status: 'waiting', message: 'Đang chờ trang CVAT (trang đang tải lại?)…' });
    scheduleRefresh(RETRY_MS);
  });
}

function showSetup() {
  document.body.classList.remove('with-panel');
  show('panel', false);
  show('setup');
}

function disconnect() {
  const p = port;
  port = null;
  p?.disconnect();
}

/** Về trạng thái trống trước khi xét lại tab: ẩn mọi nút / mục của lần trước. */
function resetSetup() {
  for (const id of ['enable', 'enable-anyway', 'reload', 'checks', 'profile', 'panel-foot']) show(id, false);
  setSite('', 'Đang xem trang này…');
  $('site-origin').textContent = '';
}

function scheduleRefresh(ms = 300) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

/**
 * Xét lại tab đang xem của cửa sổ này (side panel luôn mở, người dùng đổi tab / trang tải lại / mở job khác):
 * PointSnap chạy trên một job 3D thì hiện bảng, còn lại hiện phần cài đặt.
 */
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== tabId) disconnect();
    tabId = tab?.id ?? null;
    if (port) return;
    resetSetup();
    let origin;
    try {
      origin = Hosts.httpOrigin(tab.url);
    } catch (_) {
      showSetup();
      setSite('', 'Mở một trang CVAT để dùng PointSnap');
      return;
    }
    $('site-origin').textContent = origin.replace(/^https?:\/\//, '');
    const enabled = (await Hosts.enabledOrigins()).includes(origin);
    const page = await probe(tab.id);
    const version = page?.cvat?.version;
    const untested = version && !TESTED_CVAT.includes(version) ? `Đã thử trên CVAT ${TESTED_CVAT.join(', ')}; bản ${version} có thể khác.` : '';

    if (!enabled) {
      showSetup();
      $('enable').onclick = () => enable(origin, tab.id);
      $('enable-anyway').onclick = () => enable(origin, tab.id);
      if (page?.cvat) {
        setSite('', `Trang này là CVAT${version ? ` ${version}` : ''}`, untested || 'PointSnap chưa bật trên địa chỉ này.');
        show('enable');
      } else {
        setSite('', page ? 'Trang này không giống CVAT' : 'Không đọc được trang này', 'Nếu đây là CVAT (ví dụ sau proxy), vẫn bật được.');
        show('enable-anyway');
      }
      return;
    }

    await renderProfile(origin);
    const health = page?.health;
    if (!health) {
      showSetup();
      const why = await diagnose(origin, page);
      setSite(why.fix ? 'err' : '', why.text, why.sub);
      // CVAT đang tải: xét lại sau ít giây thay vì bắt bấm.
      if (!why.fix) { scheduleRefresh(2000); return; }
      $('reload').textContent = why.fix === 'register' ? 'Đăng ký lại và tải lại trang' : 'Tải lại trang';
      $('reload').onclick = async () => {
        if (why.fix === 'register') await chrome.runtime.sendMessage({ type: 'syncScripts' });
        chrome.tabs.reload(tab.id);
      };
      show('reload');
      return;
    }
    renderChecks(health);
    if (health.enabled && health.job3d) {
      showPanel(origin);
      return;
    }
    showSetup();
    if (!health.enabled) setSite('', 'PointSnap đang tắt trên trang này', 'Bật lại bằng ô bên dưới.');
    else {
      setSite('ok', 'PointSnap đang chạy', 'Mở một job 3D để dùng bảng.');
      // Mở job trong CVAT không tải lại trang: xét lại định kỳ tới khi vào job.
      scheduleRefresh(2000);
    }
  } finally {
    refreshing = false;
    if (again) { again = false; scheduleRefresh(); }
  }
}

function main() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('open-options').onclick = () => chrome.runtime.openOptionsPage();
  // Đang ở bảng: xem / sửa cài đặt của trang (bật / tắt, bộ ngưỡng) rồi quay lại.
  $('panel-setup').onclick = () => {
    const toSetup = $('setup').hidden;
    show('setup', toSetup);
    show('panel', !toSetup);
    document.body.classList.toggle('with-panel', !toSetup);
    $('panel-setup').textContent = toSetup ? 'Về bảng PointSnap' : 'Cài đặt trang này';
  };
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || !PANEL_KEYS.has(event.code) || !port) return;
    event.preventDefault();
    port.postMessage({ type: 'action', name: 'shortcut', data: { code: event.code } });
  });
  chrome.windows.getCurrent().then((win) => {
    chrome.tabs.onActivated.addListener((info) => { if (info.windowId === win.id) scheduleRefresh(); });
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (id === tabId && (change.url || change.status === 'complete')) scheduleRefresh(change.url ? 300 : 100);
  });
  chrome.storage.onChanged.addListener(() => { if (!port) scheduleRefresh(); });
  refresh();
}

main();

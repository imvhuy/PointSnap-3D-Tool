'use strict';
/*
 * Popup trên thanh trình duyệt: nhận ra tab đang mở có phải CVAT không, bật PointSnap cho địa chỉ đó bằng một nút,
 * rồi cho biết PointSnap đã chạy đúng chưa (đọc PointSnapAnnotator.health() trong trang).
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
    window.close();
  };
  show('profile');
}

/** Bật cho `origin`: ghi yêu cầu trước (popup có thể bị đóng khi Chrome hỏi quyền), xin quyền, để service worker làm nốt. */
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
  setTimeout(() => window.close(), 900);
}

async function main() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('open-options').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin;
  try {
    origin = Hosts.httpOrigin(tab.url);
  } catch (_) {
    setSite('', 'Mở một trang CVAT để bật PointSnap');
    return;
  }
  $('site-origin').textContent = origin.replace(/^https?:\/\//, '');
  const enabled = (await Hosts.enabledOrigins()).includes(origin);
  const page = await probe(tab.id);
  const version = page?.cvat?.version;
  const untested = version && !TESTED_CVAT.includes(version) ? `Đã thử trên CVAT ${TESTED_CVAT.join(', ')}; bản ${version} có thể khác.` : '';

  if (!enabled) {
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
    const why = await diagnose(origin, page);
    setSite(why.fix ? 'err' : '', why.text, why.sub);
    if (!why.fix) return;
    $('reload').textContent = why.fix === 'register' ? 'Đăng ký lại và tải lại trang' : 'Tải lại trang';
    $('reload').onclick = async () => {
      if (why.fix === 'register') await chrome.runtime.sendMessage({ type: 'syncScripts' });
      chrome.tabs.reload(tab.id);
      window.close();
    };
    show('reload');
    return;
  }
  if (!health.enabled) setSite('', 'Bảng annotator đang tắt trên trang này', 'Bật lại bằng ô bên dưới.');
  else if (health.job3d) setSite('ok', 'PointSnap đang chạy trên job này', untested);
  else setSite('ok', 'PointSnap đang chạy', 'Mở một job 3D để dùng bảng.');
  if (health.enabled) {
    // Bảng không nhúng vào CVAT: mở ở cửa sổ riêng của tab này (service worker nhớ cửa sổ, mở lại thì đưa lên trước).
    $('open-panel').onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'openPanel', tabId: tab.id });
      window.close();
    };
    show('open-panel');
  }
  renderChecks(health);
}

main();

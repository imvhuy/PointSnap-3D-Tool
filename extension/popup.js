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
        return {
          cvat: about && /annotation tool/i.test(about.name || '') ? { version: about.version || '' } : null,
          health: ps && ps.health ? ps.health() : null,
        };
      },
    });
    return result || null;
  } catch (_) {
    return null;
  }
}

function renderChecks(health) {
  const items = [
    [health.store, 'Đã nhận dữ liệu của CVAT', 'Chưa nhận được dữ liệu của CVAT: tải lại trang'],
    [health.job3d, 'Đang mở job 3D', 'Mở một job 3D (point cloud) để dùng bảng PointSnap'],
  ];
  if (health.job3d) {
    items.push([health.saveStates, 'Ctrl+Z của CVAT hoàn tác thao tác của PointSnap', 'Hoàn tác thao tác nhiều keyframe bằng nút ↶ của PointSnap', 'warn']);
  }
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
    setSite('err', 'Đã bật nhưng PointSnap chưa chạy trong trang', 'Tải lại trang để nạp extension.');
    $('reload').onclick = () => { chrome.tabs.reload(tab.id); window.close(); };
    show('reload');
    return;
  }
  if (!health.enabled) setSite('', 'Bảng annotator đang tắt trên trang này', 'Bật lại bằng ô bên dưới.');
  else if (health.job3d) setSite('ok', 'PointSnap đang chạy trên job này', untested);
  else setSite('ok', 'PointSnap đang chạy', 'Mở một job 3D để dùng bảng.');
  renderChecks(health);
}

main();

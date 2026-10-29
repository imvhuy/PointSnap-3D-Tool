'use strict';
/*
 * Trang Tùy chọn: các địa chỉ CVAT đã bật PointSnap, bộ ngưỡng riêng của từng địa chỉ (nhập / xuất file JSON, kiểm ngay
 * bằng PointSnapGuideline.resolve).
 */

const Hosts = globalThis.PointSnapHosts, G = globalThis.PointSnapGuideline;
const $ = (id) => document.getElementById(id);

function hostStatus(text, kind = '') {
  $('hosts-status').textContent = text;
  $('hosts-status').className = `line-status ${kind}`;
}

/** Lỗi của một bộ ngưỡng JSON (cú pháp, kiểu, giá trị); [] khi dùng được. */
function guidelineErrors(text) {
  if (!text.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [`Không phải JSON hợp lệ: ${error.message}`];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ['Bộ ngưỡng phải là một object JSON { … }'];
  return G.resolve(parsed).errors;
}

async function saveGuideline(origin, name, text) {
  const errors = guidelineErrors(text);
  if (errors.length) {
    hostStatus(`${origin}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} lỗi khác)` : ''}`, 'err');
    return false;
  }
  await Hosts.saveProfile(origin, { guidelineName: text.trim() ? name : '', guidelineJson: text.trim() });
  hostStatus(`${origin}: đã lưu bộ ngưỡng. Bảng trong CVAT cập nhật ngay.`, 'ok');
  render();
  return true;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function removeHost(origin) {
  const { sync, local } = await Hosts.readAll();
  await chrome.storage.sync.set({ cvatUrls: (sync.cvatUrls || []).filter((o) => o !== origin) });
  const profiles = { ...local.annotatorProfiles };
  delete profiles[origin];
  await chrome.storage.local.set({ annotatorProfiles: profiles });
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {});
  hostStatus(`Đã gỡ ${origin}.`, 'ok');
  render();
}

async function removeProject(key) {
  const { local } = await Hosts.readAll();
  const profiles = { ...local.annotatorProfiles };
  delete profiles[key];
  await chrome.storage.local.set({ annotatorProfiles: profiles });
  hostStatus('Đã gỡ bộ ngưỡng của project; project dùng lại bộ ngưỡng của địa chỉ CVAT.', 'ok');
  render();
}

let fileTarget = null;
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (file && fileTarget) await saveGuideline(fileTarget, file.name.replace(/\.json$/i, ''), await file.text());
});

async function render() {
  const { local } = await Hosts.readAll();
  const enabled = await Hosts.enabledOrigins();
  const focus = decodeURIComponent(location.hash.slice(1));
  const sites = focus && !enabled.includes(focus) ? [...enabled, focus] : enabled;
  // Bộ ngưỡng riêng của từng project (lưu từ trình sửa spec trong CVAT) nằm ngay dưới địa chỉ CVAT của nó.
  const projects = Object.keys(local.annotatorProfiles || {}).filter((k) => k.includes('#project-'));
  const origins = sites.flatMap((site) => [site, ...projects.filter((k) => k.startsWith(`${site}#`))]);
  $('hosts').innerHTML = '';
  for (const origin of origins) {
    const p = Hosts.profileFor(local, origin);
    const row = $('host-row').content.firstElementChild.cloneNode(true);
    const q = (sel) => row.querySelector(sel);
    const isProject = origin.includes('#');
    q('.origin').textContent = isProject ? `↳ project ${origin.split('#project-')[1]}` : origin.replace(/^https?:\/\//, '');
    q('.badge').textContent = isProject ? '' : Hosts.isBuiltIn(origin) ? 'mặc định' : enabled.includes(origin) ? '' : 'chưa bật';
    q('.enabled').checked = p.enabled;
    q('.enabled').onchange = () => Hosts.saveProfile(origin, { enabled: q('.enabled').checked });
    q('.switch').hidden = isProject;
    if (isProject) row.classList.add('project');
    q('.g-name').textContent = p.guidelineName || 'Mặc định';
    const errors = guidelineErrors(p.guidelineJson);
    q('.g-errors').textContent = errors.length ? `Bộ ngưỡng đang lưu có lỗi, CVAT dùng mặc định: ${errors[0]}` : '';
    q('.import').onclick = () => { fileTarget = origin; $('file').click(); };
    // Xuất bộ ngưỡng đầy đủ (mặc định + phần ghi đè): trưởng nhóm có đủ khóa để sửa, nhập lại vẫn hợp lệ.
    q('.export').onclick = () => {
      const g = G.resolve(errors.length || !p.guidelineJson ? {} : JSON.parse(p.guidelineJson)).guideline;
      download(`pointsnap-${(p.guidelineName || 'mac-dinh').replace(/[^\w.-]+/g, '-')}.json`, JSON.stringify(g, null, 2));
    };
    q('.reset').onclick = () => saveGuideline(origin, '', '');
    q('.edit').onclick = () => { q('.editor').hidden = !q('.editor').hidden; };
    q('textarea').value = p.guidelineJson ? JSON.stringify(JSON.parse(p.guidelineJson), null, 2) : '';
    q('.apply').onclick = () => saveGuideline(origin, p.guidelineName || 'Sửa tay', q('textarea').value);
    q('.remove').hidden = Hosts.isBuiltIn(origin);
    q('.remove').onclick = () => (isProject ? removeProject(origin) : removeHost(origin));
    if (origin === focus) {
      row.classList.add('focus');
      q('.editor').hidden = false;
    }
    $('hosts').appendChild(row);
  }
}

$('add-host').addEventListener('submit', async (event) => {
  event.preventDefault();
  let origin;
  try {
    origin = Hosts.httpOrigin($('add-url').value.trim());
  } catch (_) {
    hostStatus('Nhập địa chỉ CVAT dạng https://cvat.congty.vn', 'err');
    return;
  }
  // Xin quyền ngay trong lần bấm (Chrome chỉ cho xin quyền khi người dùng vừa thao tác).
  await chrome.storage.local.set({ pendingEnable: { origin, tabId: null } });
  const granted = Hosts.isBuiltIn(origin) || await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    await chrome.storage.local.remove('pendingEnable');
    hostStatus('Chưa được cấp quyền cho địa chỉ này.', 'err');
    return;
  }
  await chrome.runtime.sendMessage({ type: 'enableHost' });
  $('add-url').value = '';
  hostStatus(`Đã bật ${origin}. Tải lại tab CVAT đang mở để thấy bảng.`, 'ok');
  render();
});

chrome.storage.onChanged.addListener(() => render());
render();

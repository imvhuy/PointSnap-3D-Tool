'use strict';
/*
 * Trình sửa guideline theo project: bật / tắt luật, ngưỡng, khoảng kích thước theo class, thuộc tính bắt buộc, cặp được
 * chồng, nhập / xuất JSON. Mỗi lần lưu là một phiên bản (có ghi chú, khôi phục được). Chỉ lưu phần khác mặc định
 * (G.diff), để mặc định được hiệu chỉnh sau này thì project vẫn hưởng phần mình không sửa.
 */
(function () {
  const { api, esc, toast, $ } = window.QC;
  const G = window.PointSnapGuideline;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const get = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
  const set = (o, path, value) => { const keys = path.split('.'), last = keys.pop(); keys.reduce((v, k) => v[k], o)[last] = value; };
  const DIMS = [['length', 'Dài'], ['width', 'Rộng'], ['height', 'Cao']];

  const T = { project: 'default', projects: [], data: null, draft: null, errors: [], showJson: false };

  // Bản nháp: { g: guideline chung, qc: ngưỡng QC + luật tắt }. Đường dẫn 'qc.x.y' trỏ vào nhánh qc.
  const at = (path) => (path.startsWith('qc.') ? [T.draft.qc, path.slice(3)] : [T.draft.g, path]);
  const value = (path) => { const [o, p] = at(path); return get(o, p); };
  const base = (path) => (path.startsWith('qc.') ? get(T.data.qc, path.slice(3)) : get(T.data.guideline, path));

  function override() {
    const shared = G.diff(T.data.defaults.guideline, T.draft.g) || {};
    const qc = G.diff(T.data.defaults.qc, T.draft.qc);
    return qc ? { ...shared, qc } : shared;
  }
  /** Số chỗ khác so với phiên bản đang dùng. */
  function changes() {
    const count = (d) => (d && typeof d === 'object' && !Array.isArray(d) ? Object.values(d).reduce((s, v) => s + count(v), 0) : d === undefined ? 0 : 1);
    return count(G.diff(T.data.guideline, T.draft.g)) + count(G.diff(T.data.qc, T.draft.qc));
  }

  async function open() {
    if (!T.projects.length) {
      try { T.projects = await api('/api/projects'); } catch (_) { T.projects = []; }
    }
    await load();
  }

  async function load() {
    T.data = await api(`/api/specs/${T.project}`);
    T.draft = { g: clone(T.data.guideline), qc: clone(T.data.qc) };
    T.errors = [];
    render();
  }

  // ---------------------------------------------------------------- vẽ

  function rulesCard() {
    const groups = [...new Set(T.data.rules.map((r) => r.group))];
    const off = new Set(T.draft.qc.disabledRules);
    return `<div class="card"><div class="card-h"><h2>Luật</h2><span class="hint">tắt luật không còn trong guideline</span></div><div class="groups">
      ${groups.map((gname) => `<div class="group"><h3>${esc(gname)}</h3>${T.data.rules.filter((r) => r.group === gname).map((r) => `
        <label class="switch" title="${esc(r.id)}"><input type="checkbox" data-rule-on="${esc(r.id)}" ${off.has(r.id) ? '' : 'checked'}>${esc(r.title)}</label>`).join('')}</div>`).join('')}
    </div></div>`;
  }

  function fieldHtml(f) {
    const v = value(f.path), b = base(f.path);
    const shown = v === null || v === undefined ? '' : f.pct ? +(v * 100).toFixed(2) : v;
    return `<div class="field ${JSON.stringify(v) !== JSON.stringify(b) ? 'changed' : ''}">
      <label for="f-${esc(f.path)}">${esc(f.label)}</label>
      <div class="unit"><input id="f-${esc(f.path)}" type="number" step="any" data-field="${esc(f.path)}" value="${esc(shown)}" ${f.nullable ? 'placeholder="tắt"' : ''}><span>${esc(f.unit)}</span></div>
      <button class="reset" data-reset="${esc(f.path)}" title="Về giá trị đang dùng" aria-label="Hoàn tác">↺</button></div>`;
  }

  function fieldsCard() {
    const groups = [...new Set(T.data.fields.map((f) => f.group))];
    return `<div class="card"><div class="card-h"><h2>Ngưỡng</h2></div><div class="groups">
      ${groups.map((gname) => `<div class="group"><h3>${esc(gname)}</h3>${T.data.fields.filter((f) => f.group === gname).map(fieldHtml).join('')}</div>`).join('')}
    </div></div>`;
  }

  function sizesCard() {
    const ranges = T.draft.g.size.ranges, now = T.data.guideline.size.ranges;
    const rows = Object.keys(ranges).sort().map((key) => `<tr><td>${esc(key)}</td>${DIMS.map(([d]) => `<td><span class="range">
      ${[0, 1].map((i) => `<input class="cell ${now[key]?.[d]?.[i] !== ranges[key][d][i] ? 'changed' : ''}" type="number" step="0.01" data-size="${esc(key)}|${d}|${i}" value="${ranges[key][d][i]}" aria-label="${esc(key)} ${d} ${i ? 'max' : 'min'}">`).join('–')}</span></td>`).join('')}
      <td><button class="reset" data-del-size="${esc(key)}" title="Bỏ class" aria-label="Bỏ ${esc(key)}">✕</button></td></tr>`).join('');
    return `<div class="card"><div class="card-h"><h2>Kích thước theo class</h2><span class="hint">m · min–max · Class/thuộc tính phân loại</span></div>
      <div class="table-scroll"><table class="sizes"><thead><tr><th>Class</th>${DIMS.map(([, t]) => `<th>${t}</th>`).join('')}<th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="adder"><input id="new-size" placeholder="Class mới, vd Vehicle/van" aria-label="Class mới"><button class="btn sm" data-act="add-size">Thêm</button></div></div>`;
  }

  function attrsCard() {
    const req = T.draft.g.attributes.required;
    return `<div class="card"><div class="card-h"><h2>Thuộc tính bắt buộc</h2><span class="hint">cách nhau bằng dấu phẩy</span></div>
      ${Object.keys(req).sort().map((label) => `<div class="field"><label>${esc(label)}</label>
        <input class="text-in" data-attrs="${esc(label)}" value="${esc(req[label].join(', '))}" aria-label="Thuộc tính của ${esc(label)}">
        <button class="reset" data-del-attrs="${esc(label)}" aria-label="Bỏ">✕</button></div>`).join('')}
      <div class="adder"><input id="new-attr-class" placeholder="Class" aria-label="Class"><input id="new-attr-names" placeholder="thuộc tính, …" aria-label="Thuộc tính"><button class="btn sm" data-act="add-attrs">Thêm</button></div></div>`;
  }

  function pairsCard() {
    const pairs = T.draft.g.overlap.allowedPairs;
    return `<div class="card"><div class="card-h"><h2>Cặp được phép chồng</h2><span class="hint">hiện ở mức Thông tin</span></div>
      <div class="pairs">${pairs.map(([a, b], i) => `<span class="pair">${esc(a)} ↔ ${esc(b)}<button data-del-pair="${i}" aria-label="Bỏ cặp">✕</button></span>`).join('')}</div>
      <div class="adder"><input id="pair-a" placeholder="Class A" aria-label="Class A"><input id="pair-b" placeholder="Class B" aria-label="Class B"><button class="btn sm" data-act="add-pair">Thêm</button></div></div>`;
  }

  function sideHtml() {
    const versions = T.data.versions;
    return `<div class="card"><div class="card-h"><h2>Lịch sử</h2></div><div class="history">
      ${versions.length ? versions.map((v, i) => `<div class="ver"><span class="pill ${i ? '' : 'accent'}">v${v.v}</span>
        <span class="when">${v.at ? new Date(v.at).toLocaleString('vi-VN') : ''}</span>
        ${i ? `<button class="btn sm ghost" data-restore="${v.v}">Khôi phục</button>` : '<span class="muted">đang dùng</span>'}
        ${v.note ? `<div class="note">${esc(v.note)}</div>` : ''}</div>`).join('')
        : `<div class="muted">${T.data.inherited ? `Đang dùng guideline chung (v${T.data.version}). Lưu để tạo bản riêng cho project.` : 'Đang dùng mặc định của extension.'}</div>`}
    </div></div>
    <div class="card"><div class="card-h"><h2>JSON</h2></div>
      <div class="actions"><button class="btn sm" data-act="export">Xuất</button><button class="btn sm" data-act="toggle-json">Nhập</button></div>
      ${T.showJson ? `<textarea class="json" id="json-in" placeholder="Dán file Export của trình sửa spec (extension) hoặc file Xuất ở đây"></textarea>
        <div class="actions"><button class="btn sm primary" data-act="import">Áp dụng vào bản nháp</button></div>` : ''}
    </div>`;
  }

  function render() {
    if (window.QC.S.view !== 'spec') return;
    const n = changes(), name = T.data.name || 'Mặc định';
    const opts = [['default', 'Chung (mọi project)'], ...T.projects.map((p) => [String(p.id), p.name])];
    $('#main').innerHTML = `<div class="spec-head"><h1>Guideline</h1>
        <select id="spec-project" aria-label="Project">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === T.project ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <span class="pill accent">${esc(name)} v${T.data.version}</span>
        ${T.data.errors?.length ? `<span class="pill error" title="${esc(T.data.errors.join('\n'))}">bản lưu lỗi, đang dùng mặc định</span>` : ''}</div>
      <div class="spec-grid"><div>${rulesCard()}${fieldsCard()}${sizesCard()}${attrsCard()}${pairsCard()}</div><div>${sideHtml()}</div></div>
      ${n ? `<div class="savebar"><b>${n} thay đổi</b><input id="spec-note" placeholder="Ghi chú phiên bản (vd: spec 1.3 nới khoảng xe máy)" aria-label="Ghi chú">
        <button class="btn ghost" data-act="discard">Bỏ</button><button class="btn primary" data-act="save">Lưu v${(T.data.versions[0]?.v || 0) + 1}</button></div>` : ''}
      ${T.errors.length ? `<div class="errors">${T.errors.map(esc).join('<br>')}</div>` : ''}`;
  }

  // ---------------------------------------------------------------- sửa

  function redraw() {
    const y = window.scrollY, focus = document.activeElement?.id;
    render();
    window.scrollTo(0, y);
    if (focus) document.getElementById(focus)?.focus();
  }

  document.addEventListener('change', (e) => {
    if (window.QC.S.view !== 'spec') return;
    const t = e.target;
    if (t.id === 'spec-project') { T.project = t.value; load(); return; }
    if (t.dataset.ruleOn) {
      const off = new Set(T.draft.qc.disabledRules);
      if (t.checked) off.delete(t.dataset.ruleOn); else off.add(t.dataset.ruleOn);
      T.draft.qc.disabledRules = [...off].sort();
      return redraw();
    }
    if (t.dataset.field) {
      const f = T.data.fields.find((x) => x.path === t.dataset.field);
      const raw = t.value.trim();
      const v = raw === '' ? (f.nullable ? null : base(f.path)) : Number(raw) / (f.pct ? 100 : 1);
      const [o, p] = at(f.path);
      set(o, p, Number.isFinite(v) || v === null ? v : base(f.path));
      return redraw();
    }
    if (t.dataset.size) {
      const [key, d, i] = t.dataset.size.split('|');
      const v = Number(t.value);
      if (Number.isFinite(v)) T.draft.g.size.ranges[key][d][Number(i)] = v;
      return redraw();
    }
    if (t.dataset.attrs) {
      T.draft.g.attributes.required[t.dataset.attrs] = t.value.split(',').map((s) => s.trim()).filter(Boolean);
      return redraw();
    }
    return undefined;
  });

  document.addEventListener('click', async (e) => {
    if (window.QC.S.view !== 'spec') return;
    const t = e.target.closest('button');
    if (!t) return;
    const act = t.dataset.act;
    if (t.dataset.reset) { const [o, p] = at(t.dataset.reset); set(o, p, clone(base(t.dataset.reset))); redraw(); return; }
    if (t.dataset.delSize) { delete T.draft.g.size.ranges[t.dataset.delSize]; redraw(); return; }
    if (t.dataset.delAttrs) { delete T.draft.g.attributes.required[t.dataset.delAttrs]; redraw(); return; }
    if (t.dataset.delPair) { T.draft.g.overlap.allowedPairs.splice(Number(t.dataset.delPair), 1); redraw(); return; }
    if (act === 'add-size') {
      const key = $('#new-size').value.trim();
      if (key && !T.draft.g.size.ranges[key]) T.draft.g.size.ranges[key] = { length: [0, 1], width: [0, 1], height: [0, 1] };
      redraw(); return;
    }
    if (act === 'add-attrs') {
      const label = $('#new-attr-class').value.trim();
      if (label) T.draft.g.attributes.required[label] = $('#new-attr-names').value.split(',').map((s) => s.trim()).filter(Boolean);
      redraw(); return;
    }
    if (act === 'add-pair') {
      const a = $('#pair-a').value.trim(), b = $('#pair-b').value.trim();
      if (a && b) T.draft.g.overlap.allowedPairs.push([a, b]);
      redraw(); return;
    }
    if (act === 'discard') { T.draft = { g: clone(T.data.guideline), qc: clone(T.data.qc) }; T.errors = []; redraw(); return; }
    if (act === 'toggle-json') { T.showJson = !T.showJson; redraw(); return; }
    if (act === 'export') {
      const blob = new Blob([JSON.stringify(override(), null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `guideline-${T.project}.json` });
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    if (act === 'import') {
      try {
        const o = JSON.parse($('#json-in').value);
        const { qc = {}, ...shared } = o.override || o; // nhận cả file Export của extension ({ override }) lẫn file Xuất ở đây
        T.draft = { g: G.merge(T.data.defaults.guideline, shared), qc: G.merge(T.data.defaults.qc, qc) };
        T.showJson = false;
        T.errors = [];
        toast('Đã áp dụng vào bản nháp');
      } catch (error) {
        T.errors = [`JSON không đọc được: ${error.message}`];
      }
      redraw(); return;
    }
    try {
      if (act === 'save') {
        const r = await api(`/api/specs/${T.project}`, { method: 'PUT', body: JSON.stringify({ name: T.data.name === 'Mặc định' ? 'Spec' : T.data.name, note: $('#spec-note').value, override: override() }) });
        toast(`Đã lưu v${r.version}`);
        await load();
      }
      if (t.dataset.restore) {
        const r = await api(`/api/specs/${T.project}/restore`, { method: 'POST', body: JSON.stringify({ v: Number(t.dataset.restore) }) });
        toast(`Đã khôi phục thành v${r.version}`);
        await load();
      }
    } catch (error) {
      T.errors = error.body?.errors || [error.message];
      redraw();
    }
  });

  window.QCSpec = { open };
}());

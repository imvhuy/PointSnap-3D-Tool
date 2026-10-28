/*
 * Trình sửa spec của project, mở ngay trong trang CVAT (shadow DOM), cho người không làm kỹ thuật.
 * Danh sách class và thuộc tính lấy từ chính job đang mở, nên tên luôn khớp CVAT. Mỗi class: ngưỡng kích thước, chia theo
 * một thuộc tính dạng chọn / checkbox (mỗi giá trị một dòng, ghi vào khóa `Class/giá trị` mà bộ luật đã dùng), gợi ý
 * khoảng từ box đã gán trong job, công tắc mặt đất / chồng lấn / vật cứng, thuộc tính bắt buộc, ghi chú spec. Thêm ba
 * mục chung: cặp được chồng, luật spec, ngưỡng.
 * Chỉ sửa một bản nháp; Save gửi phần khác mặc định (PointSnapGuideline.diff) cho `onSave`. Không tự đọc / ghi CVAT.
 */
(function (root) {
  'use strict';

  const G = root.PointSnapGuideline;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const DIMS = ['length', 'width', 'height'], DIM_VI = { length: 'Dài', width: 'Rộng', height: 'Cao' };
  const SPLITTABLE = ['select', 'radio', 'checkbox'];
  // Thuộc tính do bộ quét QC cũ thêm vào label để gắn cờ / đánh dấu đã duyệt: không phải spec của dự án.
  const INTERNAL = new Set(['pointsnap_error', 'reviewed']);
  const GENERAL = [['@overlap', 'Chồng lấn'], ['@spec', 'Luật spec'], ['@limits', 'Ngưỡng']];

  const CSS = `
    :host { all: initial; }
    .back { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
    .dlg { width: min(780px, 96vw); max-height: 88vh; display: flex; flex-direction: column; background: #111827; color: #e5e7eb;
      border: 1px solid #374151; border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.5); font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #1f2937; }
    .head b { font-size: 13.5px; } .muted { color: #9ca3af; } .warn { color: #fbbf24; } .bad { color: #f87171; } .good { color: #86efac; }
    .head .tools { margin-left: auto; display: flex; gap: 6px; align-items: center; }
    button { font: inherit; font-weight: 600; border: 1px solid #374151; background: #1f2937; color: #e5e7eb; border-radius: 5px; padding: 3px 9px; cursor: pointer; }
    button:hover:not(:disabled) { border-color: #3b82f6; background: #273449; } button:disabled { opacity: .45; cursor: default; }
    button.primary { background: #2563eb; border-color: #2563eb; color: #fff; } button.x { border: 0; background: none; font-size: 15px; padding: 0 4px; }
    .main { display: grid; grid-template-columns: 150px minmax(0, 1fr); min-height: 0; flex: 1; }
    .nav { border-right: 1px solid #1f2937; padding: 6px; overflow-y: auto; }
    .nav button { display: block; width: 100%; text-align: left; border: 0; background: none; font-weight: 500; padding: 5px 8px; }
    .nav button.on { background: #1e3a8a; color: #dbeafe; } .nav hr { border: 0; border-top: 1px solid #1f2937; margin: 6px 0; }
    .pane { padding: 10px 14px; overflow-y: auto; display: grid; gap: 10px; align-content: start; }
    .row { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    td { padding: 3px 6px 3px 0; vertical-align: middle; } th { text-align: left; font-weight: 500; color: #9ca3af; padding: 0 6px 2px 0; }
    input, select, textarea { font: inherit; color: #e5e7eb; background: #0b1220; border: 1px solid #374151; border-radius: 5px; padding: 3px 6px; box-sizing: border-box; }
    input.range { width: 100%; } input.num { width: 64px; } input.invalid { border-color: #ef4444; } input.off { border-color: #f59e0b; }
    textarea { width: 100%; min-height: 44px; resize: vertical; }
    label.chk { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
    .sep { border-top: 1px solid #1f2937; padding-top: 10px; }
    .foot { display: flex; gap: 8px; align-items: center; padding: 7px 12px; border-top: 1px solid #1f2937; min-height: 18px; }
    .pairs td:last-child { width: 28px; }
    /* Màn hình hẹp: danh sách class thành một hàng cuộn ngang, cột Job ẩn (xem qua tooltip tên dòng), tiêu đề xuống dòng. */
    @media (max-width: 600px) {
      .head { flex-wrap: wrap; } .head .tools { margin-left: 0; width: 100%; } .head .tools .x { margin-left: auto; }
      .main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .nav { display: flex; gap: 4px; overflow-x: auto; border-right: 0; border-bottom: 1px solid #1f2937; scrollbar-width: thin; scrollbar-color: #374151 transparent; }
      .nav button { width: auto; white-space: nowrap; } .nav hr { display: none; }
      .job { display: none; } th.label, td.label { width: 92px !important; } .pane { padding: 8px 10px; }
    }
  `;

  const fmt = (pair) => (pair ? `${pair[0].toFixed(2)}–${pair[1].toFixed(2)}` : '');
  /** "1.2–2.8", "1.2 - 2.8", "1,2 – 2,8" → [1.2, 2.8]; "" → null (không có khoảng); sai → undefined. */
  function parseRange(text) {
    const t = String(text).trim();
    if (!t) return null;
    const m = t.replace(/,/g, '.').match(/^(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)$/);
    if (!m) return undefined;
    const lo = Number(m[1]), hi = Number(m[2]);
    return lo > 0 && lo <= hi ? [lo, hi] : undefined;
  }

  /**
   * `opts`: { labels: [{ name, attributes: [{ name, inputType, values }] }], guideline (đang dùng), projectName,
   *   selectedLabel, boxes(): Promise<[{ label, attributes: {tên: giá trị}, dims }]>, preview(draft) → { ok, text } | null,
   *   onSave(overrideJson, name) → Promise, restored: `guideline` là bản chưa Save được lần trước }.
   */
  function open(opts) {
    document.getElementById('pointsnap-spec-editor')?.remove();
    const host = document.createElement('div');
    host.id = 'pointsnap-spec-editor';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><div class="back"><div class="dlg" role="dialog" aria-label="Spec của project"></div></div>`;
    const dlg = shadow.querySelector('.dlg');
    document.documentElement.appendChild(host);

    const labels = opts.labels.filter((l) => l.name).map((l) => ({ ...l, attributes: l.attributes.filter((a) => !INTERNAL.has(a.name)) }));
    let draft = clone(opts.guideline), name = opts.guidelineName || '';
    let selected = labels.some((l) => l.name === opts.selectedLabel) ? opts.selectedLabel : labels[0]?.name || '@limits';
    let dirty = !!opts.restored, closeArmed = false, jobBoxes = null;
    let status = opts.restored ? 'Đã mở lại bản chưa Save lần trước; xem lại rồi Save' : '', statusKind = opts.restored ? 'warn' : '';
    const invalid = new Set();

    const labelOf = (n) => labels.find((l) => l.name === n);
    const splitAttrOf = (l) => {
      const a = draft.size.keyAttributes[l.name];
      return l.attributes.find((x) => x.name === a && SPLITTABLE.includes(x.inputType)) || null;
    };
    const valuesOf = (a) => (a.inputType === 'checkbox' ? ['true', 'false'] : a.values.filter((v) => v !== ''));
    const show = (v, a) => (a.inputType === 'checkbox' ? (v === 'true' ? 'on' : 'off') : v);
    // Khóa class / class-giá-trị dùng trong các cặp: label và các giá trị của thuộc tính chia ngưỡng.
    const pairOptions = () => labels.flatMap((l) => {
      const a = splitAttrOf(l);
      return [l.name, ...(a ? valuesOf(a).map((v) => `${l.name}/${v}`) : [])];
    });
    /** Chữ hiện cho một khóa: checkbox ghi on / off thay cho true / false của CVAT. */
    const keyText = (key) => {
      const [labelName, value] = key.split('/');
      const a = value !== undefined && labelOf(labelName) && splitAttrOf(labelOf(labelName));
      return a && a.inputType === 'checkbox' ? `${labelName} · ${a.name} ${show(value, a)}` : key;
    };
    const setDirty = () => { dirty = true; closeArmed = false; };
    const toggleIn = (list, item, on) => (on ? [...new Set([...list, item])] : list.filter((x) => x !== item));

    function stats(labelName, attr, value) {
      if (!jobBoxes) return null;
      const list = jobBoxes.filter((b) => b.label === labelName && (!attr || String(b.attributes[attr.name]) === value));
      if (!list.length) return { n: 0 };
      return { n: list.length, min: DIMS.map((_, i) => Math.min(...list.map((b) => b.dims[i]))), max: DIMS.map((_, i) => Math.max(...list.map((b) => b.dims[i]))) };
    }

    /** Ô "Job" của một dòng: chiều lệch khoảng nhiều nhất (có tính lề Cảnh báo như luật), không thì chiều cao. */
    function jobCell(st, range) {
      if (!st) return '<span class="muted">…</span>';
      if (!st.n) return '<span class="muted">0 box</span>';
      const m = draft.size.warningMargin;
      const out = range ? DIMS.findIndex((d, i) => st.min[i] < range[d][0] * (1 - m) || st.max[i] > range[d][1] * (1 + m)) : -1;
      const i = out >= 0 ? out : 2;
      const tip = DIMS.map((d, k) => `${DIM_VI[d]} ${st.min[k].toFixed(2)}–${st.max[k].toFixed(2)}`).join(', ') + ` (${st.n} box)`;
      return `<span class="${out >= 0 ? 'warn' : 'muted'}" title="${esc(tip)}">${DIM_VI[DIMS[i]].toLowerCase()} ${st.min[i].toFixed(2)}–${st.max[i].toFixed(2)}</span>`;
    }

    function classPane(l) {
      const attr = splitAttrOf(l);
      const keys = attr ? valuesOf(attr).map((v) => ({ key: `${l.name}/${v}`, label: show(v, attr), value: v })) : [{ key: l.name, label: '', value: null }];
      const splitOptions = l.attributes.filter((a) => SPLITTABLE.includes(a.inputType))
        .map((a) => `<option value="${esc(a.name)}" ${attr?.name === a.name ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
      const rows = keys.map(({ key, label, value }) => {
        const range = draft.size.ranges[key];
        const cells = DIMS.map((d) => `<td><input class="range${invalid.has(`${key}|${d}`) ? ' invalid' : ''}" data-range="${esc(key)}" data-dim="${d}" value="${esc(fmt(range?.[d]))}" placeholder="min–max" aria-label="${DIM_VI[d]} ${esc(key)}"></td>`).join('');
        const st = stats(l.name, attr, value), cell = jobCell(st, range);
        const tip = st?.n ? DIMS.map((d, k) => `${DIM_VI[d]} ${st.min[k].toFixed(2)}–${st.max[k].toFixed(2)}`).join(', ') + ` (${st.n} box trong job)` : '';
        return `<tr><td class="label" title="${esc(tip)}"><b>${esc(label || '—')}</b></td>${cells}<td class="job">${cell}</td></tr>`;
      }).join('');
      const required = l.attributes.filter((a) => !['checkbox'].includes(a.inputType));
      const req = draft.attributes.required[l.name] || [];
      return `
        <div class="row"><span class="muted">Chia theo</span>
          <select data-split="${esc(l.name)}"><option value="">—</option>${splitOptions}</select></div>
        <table><tr><th class="label" style="width:90px"></th>${DIMS.map((d) => `<th>${DIM_VI[d]} (m)</th>`).join('')}<th class="job" style="width:118px">Job</th></tr>${rows}</table>
        <div class="row sep">
          <button data-act="suggest" title="Khoảng thực tế của box đã gán trong job; xem lại trước khi Save">Gợi ý từ job</button>
          <label class="chk"><input type="checkbox" data-toggle="ground" ${['*', l.name].some((n) => draft.ground.classes.includes(n)) ? 'checked' : ''}> Mặt đất</label>
          <label class="chk"><input type="checkbox" data-toggle="overlap" ${['*', l.name].some((n) => draft.overlap.classes.includes(n)) ? 'checked' : ''}> Chồng lấn</label>
          <label class="chk" title="Kiểm scale theo track, đồng bộ cỡ, mượt yaw"><input type="checkbox" data-toggle="rigid" ${draft.size.nonRigidClasses.includes(l.name) ? '' : 'checked'}> Vật cứng</label>
        </div>
        ${required.length ? `<div class="row"><span class="muted">Bắt buộc</span>${required.map((a) => `<label class="chk"><input type="checkbox" data-required="${esc(a.name)}" ${req.includes(a.name) ? 'checked' : ''}> ${esc(a.name)}</label>`).join('')}</div>` : ''}
        <textarea data-notes placeholder="Ghi chú">${esc((draft.specNotes[l.name] || []).join('\n'))}</textarea>`;
    }

    function pairsTable(path, heads, options) {
      const pairs = path.split('.').reduce((v, k) => v[k], draft);
      const opt = (sel) => options.map((o) => `<option value="${esc(o)}" ${o === sel ? 'selected' : ''}>${esc(keyText(o))}</option>`).join('');
      const rows = pairs.map((p, i) => `<tr><td><select data-pair="${path}" data-i="${i}" data-j="0">${opt(p[0])}${options.includes(p[0]) ? '' : `<option selected>${esc(p[0])}</option>`}</select></td>`
        + `<td><select data-pair="${path}" data-i="${i}" data-j="1">${opt(p[1])}${options.includes(p[1]) ? '' : `<option selected>${esc(p[1])}</option>`}</select></td>`
        + `<td><button class="x" data-delpair="${path}" data-i="${i}" aria-label="Bỏ cặp">✕</button></td></tr>`).join('');
      return `<table class="pairs"><tr><th>${heads[0]}</th><th>${heads[1]}</th><th></th></tr>${rows}</table><div><button data-addpair="${path}">+ Thêm cặp</button></div>`;
    }

    const num = (path, value, unit, scale = 1, title = '') => `<label class="chk" title="${esc(title)}"><input class="num" data-num="${path}" data-scale="${scale}" value="${value === null || value === undefined ? '' : Math.round(value * scale * 100) / 100}"> ${unit}</label>`;

    function generalPane(which) {
      const options = pairOptions();
      if (which === '@overlap') {
        return `<div class="row"><span class="muted">Chồng lấn</span>Cảnh báo > ${num('overlap.warning', draft.overlap.warning, '%', 100)} Lỗi > ${num('overlap.error', draft.overlap.error, '%', 100)}</div>
          <div class="muted">Cặp được chồng</div>${pairsTable('overlap.allowedPairs', ['Class', 'Class'], options)}`;
      }
      if (which === '@spec') {
        return `<div class="muted">Người lái có box riêng</div>${pairsTable('spec.riderDouble', ['Xe có người lái', 'Người'], options)}
          <div class="muted sep">Người nằm trong xe</div>${pairsTable('spec.insideForbidden', ['Người', 'Xe'], options)}
          <div class="row"><span class="muted">Cho phép khi đáy người cao hơn đáy xe</span>${num('spec.insideMinLiftM', draft.spec.insideMinLiftM, 'm', 1, 'Người đứng trên nóc / thùng xe')}</div>`;
      }
      return `<div class="row"><span class="muted">Mặt đất</span>Sát đất ≤ ${num('ground.okM', draft.ground.okM, 'cm', 100)} Cảnh báo > ${num('ground.warningM', draft.ground.warningM, 'cm', 100)} Lỗi > ${num('ground.errorM', draft.ground.errorM, 'cm', 100)} Đo tới ${num('ground.maxRangeM', draft.ground.maxRangeM, 'm')}</div>
        <div class="row"><span class="muted">Phạm vi gán nhãn</span>${num('maxDistanceM', draft.maxDistanceM, 'm', 1, 'Để trống: không kiểm')}</div>
        <div class="row"><span class="muted">LiDAR cao</span>${num('sensorOrigin.2', draft.sensorOrigin[2], 'm', 1, 'Độ cao LiDAR trong hệ toạ độ point cloud (0 khi gốc toạ độ đặt tại LiDAR)')}</div>
        <div class="row"><span class="muted">Kích thước</span>Cảnh báo ngoài khoảng ${num('size.warningMargin', draft.size.warningMargin, '%', 100)} Lỗi ${num('size.errorMargin', draft.size.errorMargin, '%', 100)}</div>`;
    }

    function render() {
      const errors = G.validate(draft);
      const canSave = dirty && !invalid.size && !errors.length;
      const nav = labels.map((l) => `<button class="${selected === l.name ? 'on' : ''}" data-nav="${esc(l.name)}">${esc(l.name)}</button>`).join('')
        + '<hr>' + GENERAL.map(([k, t]) => `<button class="${selected === k ? 'on' : ''}" data-nav="${k}">${t}</button>`).join('');
      const l = labelOf(selected);
      const preview = l && opts.preview ? opts.preview(G.resolve(G.diff(G.DEFAULT_GUIDELINE, draft) || {}).guideline) : null;
      const message = status || (invalid.size ? `${invalid.size} ô chưa đúng dạng min–max` : errors[0] || '');
      dlg.innerHTML = `
        <div class="head"><b>Spec</b><span class="muted">${esc(opts.projectName || '')}</span>
          <span class="tools"><button data-act="import">Import</button><button data-act="export">Export</button>
          <button class="primary" data-act="save" ${canSave ? '' : 'disabled'}>Save</button>
          <button class="x" data-act="close" aria-label="Đóng">✕</button></span></div>
        <div class="main"><div class="nav">${nav}</div><div class="pane">${l ? classPane(l) : generalPane(selected)}</div></div>
        <div class="foot"><span class="${statusKind || (message ? 'warn' : '')}">${esc(closeArmed ? 'Chưa Save: bấm ✕ lần nữa để bỏ thay đổi' : message)}</span>
          ${preview ? `<span style="margin-left:auto" class="${preview.ok ? 'good' : 'warn'}">${esc(preview.text)}</span>` : ''}</div>`;
    }

    function setRange(key, dim, text) {
      const parsed = parseRange(text), id = `${key}|${dim}`;
      if (parsed === undefined) { invalid.add(id); return; }
      invalid.delete(id);
      const ranges = draft.size.ranges, current = ranges[key] ? clone(ranges[key]) : {};
      if (parsed) current[dim] = parsed; else delete current[dim];
      // Một dòng chỉ có hiệu lực khi đủ cả ba chiều; xóa hết thì bỏ khoảng của khóa đó (không kiểm kích thước).
      if (DIMS.every((d) => current[d])) ranges[key] = current;
      else if (!DIMS.some((d) => current[d])) delete ranges[key];
      else { ranges[key] = { ...ranges[key], ...current }; if (!DIMS.every((d) => ranges[key][d])) invalid.add(id); }
      setDirty();
    }

    async function suggest() {
      const l = labelOf(selected), attr = splitAttrOf(l);
      const keys = attr ? valuesOf(attr).map((v) => [`${l.name}/${v}`, v]) : [[l.name, null]];
      let used = 0;
      for (const [key, value] of keys) {
        const st = stats(l.name, attr, value);
        if (!st || st.n < 3) continue;
        // Làm tròn ra ngoài 5 cm: khoảng phủ hết box đã gán, lề Cảnh báo / Lỗi của luật vẫn áp thêm.
        draft.size.ranges[key] = Object.fromEntries(DIMS.map((d, i) => [d, [Math.floor(st.min[i] * 20) / 20, Math.ceil(st.max[i] * 20) / 20]]));
        DIMS.forEach((d) => invalid.delete(`${key}|${d}`));
        used += 1;
      }
      status = used ? `Đã điền khoảng của ${used} dòng từ job; xem lại rồi Save` : 'Cần ít nhất 3 box mỗi dòng để gợi ý';
      statusKind = used ? 'good' : 'warn';
      if (used) setDirty();
    }

    function download(fileName, text) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function importFile() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        let parsed;
        try { parsed = JSON.parse(await file.text()); } catch (error) { status = `File không phải JSON: ${error.message}`; statusKind = 'bad'; render(); return; }
        const { guideline, errors } = G.resolve(parsed);
        if (errors.length) { status = `${file.name}: ${errors[0]}`; statusKind = 'bad'; render(); return; }
        draft = clone(guideline);
        name = file.name.replace(/\.json$/i, '');
        invalid.clear();
        status = `Đã đọc ${file.name}; Save để dùng cho project`; statusKind = 'good';
        setDirty();
        render();
      };
      input.click();
    }

    async function save() {
      const override = G.diff(G.DEFAULT_GUIDELINE, draft) || {};
      try {
        await opts.onSave(JSON.stringify(override), name || opts.projectName || 'Spec project');
        dirty = false;
        status = 'Đã lưu, đang áp dụng'; statusKind = 'good';
      } catch (error) {
        status = `Chưa lưu được: ${error.message}`; statusKind = 'bad';
      }
      render();
    }

    function close() {
      if (dirty && !closeArmed) { closeArmed = true; render(); return; }
      window.removeEventListener('keydown', onKey, true);
      host.remove();
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    // Phím gõ trong trình sửa không lọt xuống phím tắt của CVAT (CVAT nghe ở window).
    dlg.addEventListener('keydown', (event) => event.stopPropagation());

    dlg.addEventListener('click', (event) => {
      const t = event.target.closest('button');
      if (!t) return;
      status = ''; statusKind = '';
      if (t.dataset.nav) { selected = t.dataset.nav; }
      else if (t.dataset.act === 'close') { close(); return; }
      else if (t.dataset.act === 'save') { save(); return; }
      else if (t.dataset.act === 'import') { importFile(); return; }
      else if (t.dataset.act === 'export') { download(`pointsnap-spec-${(name || opts.projectName || 'project').replace(/[^\w.-]+/g, '-')}.json`, JSON.stringify(draft, null, 2)); return; }
      else if (t.dataset.act === 'suggest') { suggest(); }
      else if (t.dataset.addpair) {
        const list = t.dataset.addpair.split('.').reduce((v, k) => v[k], draft), o = pairOptions();
        list.push([o[0] || '', o[0] || '']); setDirty();
      } else if (t.dataset.delpair) {
        t.dataset.delpair.split('.').reduce((v, k) => v[k], draft).splice(Number(t.dataset.i), 1); setDirty();
      }
      render();
    });

    dlg.addEventListener('change', (event) => {
      const t = event.target, l = labelOf(selected);
      status = ''; statusKind = '';
      if (t.dataset.range) setRange(t.dataset.range, t.dataset.dim, t.value);
      else if (t.dataset.split !== undefined) {
        if (t.value) draft.size.keyAttributes[t.dataset.split] = t.value; else delete draft.size.keyAttributes[t.dataset.split];
        setDirty();
      } else if (t.dataset.toggle && l) {
        if (t.dataset.toggle === 'ground' || t.dataset.toggle === 'overlap') {
          // '*' = mọi class: bỏ tick một class thì đổi '*' thành danh sách các class còn lại của project.
          const cfg = draft[t.dataset.toggle], list = cfg.classes.includes('*') ? labels.map((x) => x.name) : cfg.classes;
          cfg.classes = toggleIn(list, l.name, t.checked);
        }
        if (t.dataset.toggle === 'rigid') draft.size.nonRigidClasses = toggleIn(draft.size.nonRigidClasses, l.name, !t.checked);
        setDirty();
      } else if (t.dataset.required && l) {
        draft.attributes.required[l.name] = toggleIn(draft.attributes.required[l.name] || [], t.dataset.required, t.checked);
        setDirty();
      } else if (t.dataset.notes !== undefined && l) {
        const lines = t.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (lines.length) draft.specNotes[l.name] = lines; else delete draft.specNotes[l.name];
        setDirty();
      } else if (t.dataset.pair) {
        t.dataset.pair.split('.').reduce((v, k) => v[k], draft)[Number(t.dataset.i)][Number(t.dataset.j)] = t.value;
        setDirty();
      } else if (t.dataset.num) {
        const path = t.dataset.num.split('.'), scale = Number(t.dataset.scale) || 1;
        const raw = t.value.trim().replace(',', '.'), value = raw === '' ? null : Number(raw) / scale;
        const parent = path.slice(0, -1).reduce((v, k) => v[k], draft), leaf = path[path.length - 1];
        const ok = value === null ? t.dataset.num === 'maxDistanceM' : Number.isFinite(value) && (t.dataset.num.startsWith('sensorOrigin') || value >= 0);
        if (ok) { parent[leaf] = value; invalid.delete(t.dataset.num); } else invalid.add(t.dataset.num);
        setDirty();
      }
      render();
    });
    // Ô khoảng: tô đỏ ngay khi gõ sai, chưa đổi bản nháp cho tới khi rời ô.
    dlg.addEventListener('input', (event) => {
      if (event.target.dataset.range) event.target.classList.toggle('invalid', parseRange(event.target.value) === undefined);
    });

    render();
    Promise.resolve(opts.boxes?.()).then((list) => { jobBoxes = list || []; render(); }).catch(() => { jobBoxes = []; render(); });
    return { close };
  }

  root.PointSnapSpecEditor = { open, parseRange };
})(globalThis);

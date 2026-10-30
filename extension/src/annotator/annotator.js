/*
 * Bộ điều khiển extension cho annotator (MAIN world): nối CVAT → số đo → kiểm tra → overlay / panel, và thao tác
 * sửa track có xem trước. Không gửi dữ liệu ra ngoài trang CVAT; ghi vào bộ nhớ CVAT, người dùng tự Save.
 */
(function (root) {
  'use strict';

  const A = root.PointSnapCvatAdapter, B = root.PointSnapBox, Grid = root.PointSnapGrid, Terrain = root.PointSnapTerrain;
  const Checks = root.PointSnapChecks, Ops = root.PointSnapTrackOps, G = root.PointSnapGuideline;
  const ObjectPoints = root.PointSnapObjectPoints, Colors = root.PointSnapCloudColors;
  const Overlay = root.PointSnapAnnotatorOverlay, Panel = root.PointSnapAnnotatorPanel, Dom = root.PointSnapCvat;
  const SpecEditor = root.PointSnapSpecEditor, Measure = root.PointSnapMeasure;
  if (root.PointSnapAnnotator || !A || !Panel || !Measure) return;

  const SETTINGS_MESSAGE = 'POINTSNAP_ANNOTATOR_SETTINGS';
  const DONE_KEY = 'pointsnap.annotator.done.';
  const DISMISS_KEY = 'pointsnap.annotator.dismissed.';
  const PANEL_INTERVAL_MS = 120;
  const TRACK_RELOAD_DELAY_MS = 400;
  const JOB_LOAD_SLOW_MS = 15000;
  const MAX_DRAWN_POINTS = 600;
  const DEG = 180 / Math.PI;

  const S = {
    enabled: true,
    guideline: G.DEFAULT_GUIDELINE,
    guidelineErrors: [],
    guidelineName: '',
    settingsVersion: 0,
    jobId: null,
    frameCache: null,
    // Khoá box: đổi frame thì camera dời theo box đang chọn (box đứng yên trên màn hình). Bật sẵn theo
    // guideline.trackOps.followCamera; nút ◎ / Alt+Shift+F tắt bật. `lockAnchor`: box đang khoá ở frame trước.
    lock: true,
    lockAnchor: null,
    focusOnArrive: null,
    lastActive: null,
    dismissCache: null,
    track: null,
    trackDirtyAt: 0,
    trackToken: 0,
    // Vé của thao tác ghi / bản xem trước: đổi job thì tăng, kết quả về muộn của job cũ bị bỏ (clientID trùng giữa job).
    opToken: 0,
    groundCache: null,
    attrDraft: null,
    plan: null,
    notice: null,
    busy: false,
    measureKey: '',
    measure: null,
    lastStates: null,
    lastFrame: null,
    lastPanelAt: 0,
    lastUndo: null,
    specOpen: false,
    // Bảng đủ chỗ: phần sửa cả track mở sẵn.
    trackOpen: true,
    waitingSince: 0,
  };
  let panel = null;

  const NOTICE_MS = { ok: 8000, info: 8000, error: 15000 };
  function notify({ kind, text }) {
    S.notice = { kind, text, until: performance.now() + NOTICE_MS[kind] };
    S.lastPanelAt = 0;
  }

  // ------------------------------------------------------------------ cấu hình từ trang Tùy chọn

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== SETTINGS_MESSAGE) return;
    const { enabled, guidelineJson, guidelineName } = event.data.detail || {};
    S.enabled = enabled !== false;
    S.guidelineName = guidelineName || '';
    let override = {};
    let parseError = null;
    try {
      override = guidelineJson ? JSON.parse(guidelineJson) : {};
    } catch (_) {
      parseError = 'JSON không hợp lệ';
    }
    const { guideline, errors } = G.resolve(override);
    S.guideline = guideline;
    // Khoá box bật / tắt sẵn theo spec ở lần nạp đầu; sau đó theo nút ◎ của annotator.
    if (S.settingsVersion === 0) S.lock = guideline.trackOps.followCamera !== false;
    S.guidelineErrors = parseError ? [parseError] : errors;
    S.settingsVersion += 1;
    S.frameCache = null;
  });

  // ------------------------------------------------------------------ dữ liệu của frame

  /**
   * Chỉ mục điểm + bản đồ địa hình của frame đang mở. Chỉ mục điểm dựng lại khi đổi frame / CVAT nạp point cloud khác;
   * bản đồ địa hình còn dựng lại khi các box của frame đổi (thêm, xoá, dời, đổi cỡ, outside), vì nó bỏ điểm nằm trong
   * box khỏi mặt đất: số đo tiếp đất và nút Hạ đáy luôn khớp với một lần dựng mới (như QC).
   */
  function frameData(ctx) {
    const positions = A.pointCloud(ctx);
    if (!positions) return null;
    const key = `${ctx.job.id}:${ctx.frame}:${S.settingsVersion}`;
    const boxes = A.frameStates().filter((s) => !s.outside).map((s) => B.fromCvatPoints(s.points)).filter(Boolean);
    const boxesKey = JSON.stringify(boxes.map((b) => [...b.center, ...b.rotation, ...b.dims].map((v) => Math.round(v * 1000))));
    const same = S.frameCache?.key === key && S.frameCache.positions === positions;
    if (same && S.frameCache.boxesKey === boxesKey) return S.frameCache;
    if (same) {
      S.frameCache = { ...S.frameCache, boxesKey, terrain: Terrain.build(S.frameCache.grid, boxes, { origin: S.guideline.sensorOrigin }) };
      return S.frameCache;
    }
    const frameChanged = S.frameCache?.frame !== ctx.frame;
    S.frameCache = { key, boxesKey, frame: ctx.frame, ...Measure.buildFrame(positions, boxes, S.guideline) };
    if (frameChanged) onFrameChanged(ctx);
    return S.frameCache;
  }

  /**
   * Mở job khác trong cùng tab (CVAT là SPA): clientID đánh lại từ đầu theo job, nên track / camera theo / bản xem trước
   * của job cũ có thể trùng ID với một object khác của job mới. Bỏ hết trạng thái gắn với job cũ.
   */
  function onJobChanged(jobId, projectId) {
    S.jobId = jobId;
    // Bộ ngưỡng theo project của job (cấu hình riêng của project, không có thì của địa chỉ CVAT).
    window.postMessage({ type: `${SETTINGS_MESSAGE}_REQUEST`, detail: { projectId } }, location.origin);
    S.lockAnchor = null;
    S.focusOnArrive = null;
    S.lastActive = null;
    S.dismissCache = null;
    S.track = null;
    S.trackToken += 1;
    S.opToken += 1;
    S.plan = null;
    S.measureKey = '';
    S.measure = null;
    S.lastStates = null;
  }

  /**
   * Đổi frame: box đang khoá vẫn được chọn và camera dời đúng quãng box đã đi, nên box không trôi khỏi màn hình và
   * annotator không chọn / sửa nhầm box khác. Tắt khoá mà vừa nhảy từ dải track thì đưa camera tới box một lần.
   */
  function onFrameChanged(ctx) {
    const anchor = S.lockAnchor, arrive = S.focusOnArrive;
    S.focusOnArrive = null;
    const id = S.lock ? anchor?.clientID : arrive;
    if (id === undefined || id === null) return;
    const state = A.frameStates().find((s) => s.clientID === id && !s.outside), box = state && B.fromCvatPoints(state.points);
    if (!box) {
      notify({ kind: 'info', text: 'Box đang khoá không có mặt ở frame này.' });
      return;
    }
    if (!S.lock) { A.select(ctx, id, true); return; }
    if (A.activeClientId() !== id) A.select(ctx, id);
    A.shiftCamera(ctx, box.center.map((v, i) => v - anchor.center[i]));
    S.lockAnchor = { clientID: id, center: box.center };
  }

  // ------------------------------------------------------------------ số đo của box đang chọn

  function activeObject() {
    const id = A.activeClientId();
    return A.frameStates().find((s) => s.clientID === id && !s.outside) || null;
  }

  /** Lấy đều tối đa `limit` điểm để vẽ, giữ lúc kéo box vẫn mượt. */
  function sample(points, limit) {
    if (points.length <= limit) return points;
    const step = points.length / limit;
    return Array.from({ length: limit }, (_, i) => points[Math.floor(i * step)]);
  }

  function measureActive(ctx, cache) {
    const objectState = activeObject();
    const box = objectState && A.liveBox(ctx, objectState);
    if (!box) return null;
    const others = A.frameStates()
      .filter((s) => s.clientID !== objectState.clientID && !s.outside)
      .map((s) => ({ box: B.fromCvatPoints(s.points), label: s.label?.name || '', attributes: A.attributesOf(s), clientId: s.clientID, state: s }))
      .filter((o) => o.box);
    const trackReady = S.track?.clientID === objectState.clientID && !S.track.loading;
    const label = objectState.label?.name || '';
    const trackDims = trackReady
      ? S.track.keyframes.filter((k) => !k.outside && k.frame !== ctx.frame).map((k) => k.box.dims) : null;
    // Khoá theo mọi dữ liệu bộ luật đọc: class, occluded, thuộc tính, box và nhãn / thuộc tính của box khác, bản đồ địa
    // hình, và nội dung kích thước các keyframe (không phải số keyframe: sửa keyframe khác giữ nguyên số lượng).
    const key = JSON.stringify([cache.key, cache.boxesKey, objectState.clientID, label, !!objectState.occluded, box,
      others.map((o) => [o.clientId, o.box, o.label, o.attributes]), trackDims, objectState.attributes]);
    if (key === S.measureKey) return S.measure;
    const { input, issues, contact, classKey, points } = Measure.measureBox(cache,
      { box, label, attributes: A.attributesOf(objectState), occluded: objectState.occluded, clientId: objectState.clientID },
      others, trackDims, S.guideline);
    const byId = new Map(others.map((o) => [o.clientId, o]));
    S.measureKey = key;
    S.measure = {
      objectState, box, label, classKey, contact, issues, input,
      insideIdx: points.inside.map((q) => q[3]),
      outsideIdx: points.outside.map((q) => q[3]),
      insidePoints: sample(points.inside, MAX_DRAWN_POINTS),
      outsidePoints: sample(points.outside, MAX_DRAWN_POINTS),
      insideCount: points.inside.length,
      outsideCount: points.outside.length,
      faces: points.faces,
      // Cặp vi phạm spec (người lái / người trong xe) vẽ khung đỏ như chồng lấn cần xem.
      overlaps: issues.filter((i) => (i.rule.startsWith('overlap') || i.rule.startsWith('spec.')) && byId.has(i.otherClientId))
        .map((i) => ({ box: byId.get(i.otherClientId).box, ratio: i.ratio ?? B.overlapRatio(box, byId.get(i.otherClientId).box),
          allowed: i.rule === 'overlap.allowed' })),
    };
    return S.measure;
  }

  // ------------------------------------------------------------------ track của box đang chọn

  async function loadTrack(ctx, objectState) {
    const token = ++S.trackToken, clientID = objectState.clientID;
    const previous = S.track?.clientID === clientID ? S.track.keyframes : [];
    S.track = { clientID, loading: !previous.length, keyframes: previous };
    try {
      const keyframes = await A.trackKeyframes(ctx.job, objectState);
      if (token === S.trackToken) S.track = { clientID, loading: false, keyframes };
    } catch (error) {
      if (token === S.trackToken) {
        S.track = { clientID, loading: false, keyframes: [] };
        notify({ kind: 'error', text: `Không đọc được keyframe của track: ${error.message}` });
      }
    }
  }

  function syncTrack(ctx, objectState) {
    if (!objectState || objectState.objectType !== 'track') {
      if (S.track) { S.track = null; S.trackToken += 1; }
      return;
    }
    const changedTrack = S.track?.clientID !== objectState.clientID;
    const dirty = S.trackDirtyAt && performance.now() - S.trackDirtyAt > TRACK_RELOAD_DELAY_MS;
    if (changedTrack || dirty) {
      S.trackDirtyAt = 0;
      loadTrack(ctx, objectState);
    }
  }

  /**
   * Dải track: một ô cho mỗi keyframe nhìn thấy, vàng khi keyframe đó lệch. Kích thước của vật cứng theo đúng ngưỡng
   * của luật `size.in_track` (dải và checklist cùng một kết luận); vật không cứng dùng trung vị / MAD; yaw theo
   * `angleOutliers` (đoán từ keyframe lân cận, xe rẽ thật không bị đánh dấu).
   */
  function trackCells(keyframes, rigid, dismissed = new Set()) {
    const shown = keyframes.filter((k) => !k.outside);
    const dimFlags = (i) => (rigid ? Checks.inTrackOutliers(shown.map((k) => k.box.dims[i]), S.guideline)
      : Checks.madOutliers(shown.map((k) => k.box.dims[i]), 0.05));
    const dims = [0, 1, 2].map(dimFlags);
    const yaw = Checks.angleOutliers(shown.map((k) => k.box.rotation[2]),
      S.guideline.trackOps.yawJumpDeg[rigid ? 'rigid' : 'nonRigid'], shown.map((k) => k.frame));
    return shown.map((k, i) => {
      // Đã bỏ qua dòng Kích thước / Hướng cho track này thì dải cũng thôi tô vàng vì lý do đó.
      const sizeOn = !dismissed.has('size'), yawOn = !dismissed.has('heading');
      const reasons = [...(sizeOn ? ['dài', 'rộng', 'cao'].filter((_, d) => dims[d][i]).map((d) => `${d} lệch track`) : []),
        ...(yawOn && yaw[i] ? ['hướng nhảy'] : [])];
      return { frame: k.frame, level: reasons.length ? 'warning' : 'ok', reasons, yawJump: yaw[i] };
    });
  }

  const RANK = { error: 0, warning: 1, na: 2, ok: 3, muted: 3 };

  /**
   * Thuộc tính chọn được của track: giá trị ở frame này, giá trị đang chọn sẵn (chưa ghi) và `mixed` khi các keyframe
   * nhìn thấy đang mang nhiều giá trị khác nhau.
   */
  function trackAttrs(objectState, keyframes) {
    const draft = S.attrDraft?.clientID === objectState.clientID ? S.attrDraft.values : {};
    const shown = keyframes.filter((k) => !k.outside);
    return A.attributeSpecs(objectState).map((a) => ({
      ...a, current: String(objectState.attributes?.[a.id] ?? ''), draft: draft[a.id] || '',
      mixed: new Set(shown.map((k) => String(k.attributes?.[a.id] ?? ''))).size > 1,
    }));
  }

  /**
   * Checklist chỉ đo được frame đang đứng (cần point cloud của frame đó), nên lỗi của checklist (lơ lửng, lòi điểm…) được
   * tô lên ô keyframe của frame này; frame nội suy không có ô thì dòng tóm tắt vẫn báo. Dòng Hướng lấy từ chính dải nên
   * không cộng lại.
   */
  function markCurrentFrame(track, rows, frame) {
    const problems = rows.filter((r) => (r.level === 'warning' || r.level === 'error') && r.key !== 'heading');
    const level = problems.some((r) => r.level === 'error') ? 'error' : problems.length ? 'warning' : 'ok';
    track.current = { level, count: problems.length };
    const cell = track.cells.find((c) => c.frame === frame);
    if (cell && problems.length) {
      cell.reasons = [...cell.reasons, ...problems.map((r) => `${r.name}: ${r.text}`)];
      if (RANK[level] < RANK[cell.level]) cell.level = level;
    }
    track.flagged = track.cells.filter((c) => c.level !== 'ok').length;
  }

  /**
   * Checklist của box đang chọn: mỗi khía cạnh một dòng { name, level: ok | warning | error | na, text, tip, fix }.
   * `fix` là thao tác sửa đúng vấn đề của dòng đó (chỉ khi có vấn đề, box không khóa và thao tác áp dụng được).
   */
  function checklist(m, g, track, measured, frame) {
    const pick = (test) => m.issues.filter((i) => test(i.rule));
    const editable = !m.objectState.lock, isTrack = m.objectState.objectType === 'track';
    const rigid = !g.size.nonRigidClasses.includes(m.label);
    const row = (key, name, issues, okText, fix) => {
      const real = issues.filter((i) => i.severity !== 'info'), info = issues.filter((i) => i.severity === 'info');
      const level = real.some((i) => i.severity === 'error') ? 'error' : real.length ? 'warning' : info.length && !okText ? 'na' : 'ok';
      return { key, name, level, text: (real[0] || info[0])?.short || okText, tip: issues.map((i) => i.message).join('\n'),
        fix: level === 'warning' || level === 'error' ? fix : null };
    };

    const gap = measured?.gapM ?? 0;
    const groundText = measured && (Math.abs(gap) <= g.ground.okM ? 'sát đất' : `${gap > 0 ? 'cao' : 'thấp'} ${cm(Math.abs(gap))}`);
    const snap = measured && editable ? { action: 'snap-ground', label: 'Hạ đáy', key: 'G' } : null;
    const ground = row('ground', 'Mặt đất', pick((r) => r.startsWith('ground.') || r === 'z.range'), groundText, snap);
    // Lệch nhỏ (dưới ngưỡng Cảnh báo) vẫn cho hạ đáy một chạm, không tô vàng.
    if (ground.level === 'ok' && measured && Math.abs(gap) > g.ground.okM) ground.fix = snap;

    const sizeIssues = pick((r) => r.startsWith('size.'));
    const syncable = editable && isTrack && rigid && sizeIssues.some((i) => i.rule === 'size.in_track');
    const size = row('size', 'Kích thước', sizeIssues, m.box.dims.map((d) => d.toFixed(2)).join(' × ') + ' m',
      syncable ? { action: 'plan-sync-size', source: 'median', label: 'Cỡ trung vị' } : null);
    // Class chưa có khoảng trong spec (label đặt tên khác, vd "vehicles"): luật kích thước không chạy, đừng hiện ✓.
    if (size.level === 'ok' && !g.size.ranges[m.classKey] && !g.size.ranges[m.label]) {
      Object.assign(size, { level: 'na', text: `${size.text} · chưa có khoảng`,
        tip: `Spec chưa có khoảng kích thước cho class "${m.label}" nên chưa kiểm. Bấm Spec → Gợi ý từ job → Save.`,
        fix: { action: 'open-spec', label: 'Spec' } });
    }

    // Ôm vật: Cảnh báo khi mặt LiDAR thấy có vật lòi ra > 10 cm, hoặc ≥ 20 điểm đỏ chiếm ≥ 15% điểm của vật. Đo 25/10/2026
    // (nuScenes scene-1077, 1100, AV2): nhãn chuẩn bị báo 0–5%, box co 15% bắt được 38–78% (chỉ dùng mặt: 32–78%).
    // Box dư chỉ ghi số, không tô vàng: nhãn chuẩn nuScenes dư p90 tới 33 cm.
    const faces = m.faces.map((f) => ({ ...f, text: `${f.name} ${f.gapM >= 0 ? 'dư' : 'lòi'} ${cm(Math.abs(f.gapM))}` }));
    const protruding = faces.filter((f) => f.gapM < -0.1);
    const redShare = m.outsideCount / Math.max(1, m.insideCount + m.outsideCount);
    const manyRed = m.outsideCount >= 20 && redShare >= 0.15;
    const counts = `${m.insideCount} điểm${m.outsideCount ? ` · ${m.outsideCount} lòi ra` : ''}`;
    const fit = row('fit', 'Ôm vật', pick((r) => r.startsWith('fit.')), [counts, ...faces.slice(0, 1).map((f) => f.text)].join(' · '), null);
    if (fit.level === 'ok' && (protruding.length || manyRed)) {
      Object.assign(fit, { level: 'warning', text: protruding.length ? protruding.map((f) => f.text).join(', ') : `${m.outsideCount} điểm đỏ lòi ra ngoài box`,
        tip: 'Điểm đỏ là điểm nối liền với vật nằm ngoài box. Dưới tán cây / sát tường có thể là điểm của vật bên cạnh.' });
    }

    const currentCell = track?.cells?.find((c) => c.frame === frame);
    const heading = row('heading', 'Hướng', [], `${Math.round(m.box.rotation[2] * DEG)}°`, null);
    if (currentCell?.yawJump) {
      Object.assign(heading, { level: 'warning', text: 'nhảy so với keyframe kề',
        fix: editable && rigid ? { action: 'plan-smooth-yaw', label: 'Mượt yaw' } : null });
    }

    const overlap = row('overlap', 'Chồng lấn', pick((r) => r.startsWith('overlap') || r.startsWith('spec.')), 'không', null);
    if (overlap.level === 'na') overlap.level = 'ok';
    const required = g.attributes.required[m.label] || [];
    const attrs = row('attrs', 'Thuộc tính', pick((r) => r.startsWith('attr.')), required.length ? 'đủ' : 'không bắt buộc', null);
    const rows = [ground, size, fit, heading, overlap, attrs];
    const far = pick((r) => r === 'range.too_far');
    if (far.length) rows.push(row('range', 'Phạm vi', far, '', null));
    return rows;
  }

  // ------------------------------------------------------------------ track đã xong (chỉ lưu ID, trong trình duyệt)

  const trackId = (s) => (s.serverID ? `s${s.serverID}` : `c${s.clientID}`);

  function doneSet(jobId) {
    try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY + jobId)) || []); } catch (_) { return new Set(); }
  }

  function toggleDone(ctx, objectState) {
    const done = doneSet(ctx.job.id), id = trackId(objectState);
    if (done.has(id)) done.delete(id); else done.add(id);
    try {
      localStorage.setItem(DONE_KEY + ctx.job.id, JSON.stringify([...done]));
    } catch (_) {
      notify({ kind: 'error', text: 'Trình duyệt chặn bộ nhớ trang: không lưu được trạng thái track.' });
    }
    if (!objectState.serverID) notify({ kind: 'info', text: 'Track mới chưa Save: dấu "đã xong" chỉ giữ tới khi tải lại trang.' });
  }

  // ------------------------------------------------------------------ cảnh báo đã bỏ qua (theo job, trong trình duyệt)

  /** { [object]: [dòng checklist] } của job; đọc một lần rồi giữ trong S.dismissCache. */
  function dismissedMap(jobId) {
    if (S.dismissCache?.jobId === jobId) return S.dismissCache.map;
    let map = {};
    try { map = JSON.parse(localStorage.getItem(DISMISS_KEY + jobId)) || {}; } catch (_) { map = {}; }
    S.dismissCache = { jobId, map };
    return map;
  }

  const dismissedFor = (jobId, state) => new Set(dismissedMap(jobId)[trackId(state)] || []);

  function setDismissed(ctx, state, row, on) {
    const map = { ...dismissedMap(ctx.job.id) }, key = trackId(state);
    const rows = new Set(map[key] || []);
    if (on) rows.add(row); else rows.delete(row);
    if (rows.size) map[key] = [...rows]; else delete map[key];
    S.dismissCache = { jobId: ctx.job.id, map };
    try {
      localStorage.setItem(DISMISS_KEY + ctx.job.id, JSON.stringify(map));
    } catch (_) {
      notify({ kind: 'error', text: 'Trình duyệt chặn bộ nhớ trang: không nhớ được mục đã bỏ qua.' });
    }
  }

  function frameTracks() {
    return A.frameStates().filter((s) => s.objectType === 'track' && !s.outside);
  }

  // ------------------------------------------------------------------ thao tác sửa có xem trước

  const cm = (m) => `${Math.round(m * 100)} cm`;

  function planFor(kind, params, keyframes) {
    const g = S.guideline;
    if (kind === 'sync-size') {
      const { edits, summary } = Ops.planSizeSync(keyframes, params.dims, g.sensorOrigin);
      return { edits, title: 'Đồng bộ kích thước cả track', emptyText: 'Mọi keyframe đã cùng kích thước.', lines: [
        `Kích thước đích ${params.dims.map((d) => d.toFixed(2)).join(' × ')} m (${params.source === 'median' ? 'trung vị track' : 'frame hiện tại'}).`,
        `${summary.changed} keyframe đổi; mặt LiDAR nhìn thấy giữ cố định, đáy box giữ nguyên.`,
        `Tâm box dời nhiều nhất ${cm(summary.maxShiftM)}.`,
      ] };
    }
    if (kind === 'smooth-yaw') {
      const { edits, summary } = Ops.planYawSmoothing(keyframes, g.trackOps.yawSmoothing);
      return { edits, title: 'Làm mượt yaw', emptyText: 'Hướng box đã mượt, không keyframe nào cần đổi.', lines: [
        `${summary.changed} keyframe đổi hướng (lệch > ${g.trackOps.yawSmoothing.minChangeDeg}°).`,
        summary.flips ? `${summary.flips} keyframe bị lật đầu ≈ 180° được xoay lại.` : 'Không có keyframe lật đầu.',
      ] };
    }
    const { edits, summary } = Ops.planThinning(keyframes, g.trackOps.thinning);
    return { edits, title: 'Tỉa keyframe thừa',
      emptyText: `Không bỏ được keyframe nào: nội suy lệch quá dung sai (tâm ${cm(g.trackOps.thinning.centerM)}, yaw ${g.trackOps.thinning.yawDeg}°).`, lines: [
      `Giữ ${summary.kept}/${summary.total} keyframe, bỏ ${summary.changed}; CVAT tự nội suy phần bỏ.`,
      `Sai lệch tâm lớn nhất sau tỉa ${cm(summary.maxCenterErrorM)} (dung sai ${cm(g.trackOps.thinning.centerM)}).`,
      'Nên đồng bộ kích thước và làm mượt yaw trước khi tỉa.',
    ] };
  }

  const signature = (edits) => JSON.stringify(edits.map((e) => [e.frame, e.keyframe,
    e.box && [...e.box.center, ...e.box.rotation, ...e.box.dims].map((v) => Math.round(v * 1000))]));

  async function preparePlan(ctx, kind, params) {
    const objectState = activeObject();
    if (!objectState || objectState.objectType !== 'track') return;
    const token = S.opToken;
    S.busy = true;
    try {
      const keyframes = await A.trackKeyframes(ctx.job, objectState);
      // Đổi job trong lúc chờ: clientID có thể trùng object của job mới, không tạo lại bản xem trước.
      if (token !== S.opToken) return;
      const plan = planFor(kind, params, keyframes);
      if (!plan.edits.length) {
        S.plan = null;
        notify({ kind: 'ok', text: `${plan.title}: ${plan.emptyText}` });
        return;
      }
      S.plan = { ...plan, kind, params, jobId: ctx.job.id, token, clientID: objectState.clientID, signature: signature(plan.edits), canApply: true };
      S.notice = null;
    } finally {
      S.busy = false;
    }
  }

  /** Lập lại kế hoạch trên keyframe mới nhất; khác bản xem trước (track vừa bị sửa) thì không ghi. */
  async function applyPlan(ctx) {
    const plan = S.plan, objectState = activeObject();
    const sameTarget = () => plan.token === S.opToken && plan.jobId === A.context()?.job.id && activeObject()?.clientID === plan.clientID;
    if (!plan || plan.jobId !== ctx.job.id || !sameTarget()) {
      S.plan = null;
      notify({ kind: 'error', text: 'Box hoặc job đang mở đã đổi; lập lại bản xem trước.' });
      return;
    }
    S.busy = true;
    try {
      const keyframes = await A.trackKeyframes(ctx.job, objectState);
      if (!sameTarget()) {
        if (S.plan === plan) S.plan = null;
        notify({ kind: 'error', text: 'Box hoặc job đang mở đã đổi trong lúc đọc track; chưa ghi gì, lập lại bản xem trước.' });
        return;
      }
      const fresh = planFor(plan.kind, plan.params, keyframes);
      if (!fresh.edits.length) {
        S.plan = null;
        notify({ kind: 'ok', text: `${plan.title}: track vừa thay đổi, ${fresh.emptyText.charAt(0).toLowerCase()}${fresh.emptyText.slice(1)}` });
        return;
      }
      if (signature(fresh.edits) !== plan.signature) {
        S.plan = { ...plan, ...fresh, signature: signature(fresh.edits) };
        notify({ kind: 'info', text: 'Track vừa thay đổi: đã cập nhật bản xem trước, kiểm tra rồi bấm Áp dụng lại.' });
        return;
      }
      await commit(ctx.job, new Map(keyframes.map((k) => [k.frame, k])), fresh.edits, plan.title);
      S.plan = null;
    } finally {
      S.busy = false;
    }
  }

  const undoHint = (kind) => (kind === 'cvat' ? 'Ctrl+Z một lần để hoàn tác'
    : 'hoàn tác bằng nút "Hoàn tác" của PointSnap (Ctrl+Z của CVAT bản này không gộp được thao tác nhiều keyframe)');

  // Nút Hoàn tác chỉ hiện khi đang chọn đúng track vừa sửa, để không tưởng nhầm là hoàn tác track khác.
  function rememberUndo(job, kind, record, title) {
    S.lastUndo = kind === 'pointsnap' && record.length ? { jobId: job.id, clientID: record[0].clientID, title, record } : null;
  }

  /** Ghi lỗi giữa batch mà còn keyframe chưa trả lại được: giữ Hoàn tác cho phần đó (lỗi vẫn được báo như thường). */
  function keepUndoOnError(job, error, title) {
    if (error?.record?.length) {
      rememberUndo(job, 'pointsnap', error.record, `${title} (ghi dở)`);
      markTrackChanged();
    }
    return error;
  }

  async function commit(job, byFrame, edits, title) {
    let result;
    try {
      result = await A.applyEdits(job, byFrame, edits);
    } catch (error) {
      throw keepUndoOnError(job, error, title);
    }
    rememberUndo(job, result.undo, result.record, title);
    const locked = result.locked ? ` ${result.locked} keyframe bị khóa (lock) nên bỏ qua.` : '';
    notify({ kind: 'ok', text: `${title}: đã ghi ${result.saved} keyframe vào CVAT, chưa Save; ${undoHint(result.undo)}.${locked}` });
    markTrackChanged();
  }

  /**
   * Mức đáy box cần chạm ở frame `f`, đo như nút Hạ đáy nhưng trên point cloud của chính frame đó (frame khác frame
   * đang mở thì đọc gói frame từ CVAT): đáy đã nằm trên mặt đất đo được thì giữ nguyên, không thì đặt giữa mặt đất dưới
   * các góc đáy. Hạ / nâng không đổi chân box, nên nhớ theo frame + tâm XY / góc / kích thước: lượt kiểm tra lại sau khi
   * ghi không phải đọc lại point cloud. null: không đo được đủ tin cậy.
   */
  async function snapTargetAt(ctx, f) {
    const g = S.guideline, b = f.box;
    if (S.groundCache?.jobId !== ctx.job.id || S.groundCache.version !== S.settingsVersion) {
      S.groundCache = { jobId: ctx.job.id, version: S.settingsVersion, byKey: new Map() };
    }
    const key = `${f.frame}:${[b.center[0], b.center[1], ...b.rotation, ...b.dims].map((v) => v.toFixed(3)).join(',')}`;
    if (!S.groundCache.byKey.has(key)) {
      const frame = Measure.buildFrame(await A.frameCloud(ctx, f.frame), await A.frameBoxes(ctx.job, f.frame), g);
      const contact = Checks.usableContact(Terrain.measureContact(frame.terrain, frame.grid, b), b, g);
      const bottom = B.bottomZ(b);
      S.groundCache.byKey.set(key, !contact ? null : Math.abs(contact.gapM) < SNAP_EPS_M ? bottom : bottom + contact.snapDzM);
    }
    return S.groundCache.byKey.get(key);
  }

  /** Gộp bản ghi Hoàn tác của nhiều lần ghi: mỗi frame giữ trạng thái trước lần ghi đầu và sau lần ghi cuối. */
  function mergeRecords(into, record) {
    for (const entry of record) {
      const key = `${entry.clientID}:${entry.frame}`, old = into.get(key);
      into.set(key, old ? { ...old, after: entry.after } : entry);
    }
  }

  const SNAP_PASSES = 3;
  // Đáy lệch mặt đất đo được dưới mức này coi như đã chạm đất (nút Hạ đáy một frame và Hạ đáy mọi frame cùng ngưỡng).
  const SNAP_EPS_M = 0.005;

  /**
   * Hạ đáy mọi frame track xuất hiện bằng một nút, không xem trước: như bấm Hạ đáy ở từng frame (cả frame nội suy).
   * Keyframe thì dời; frame nội suy mà nội suy chưa đưa đáy về đúng mặt đất thì thêm keyframe (chỉ ở frame cần, frame
   * nội suy đã khớp thì để CVAT tự nội suy). Ghi luôn vào CVAT (chưa Save, Hoàn tác được), đọc lại từng frame đúng như
   * CVAT nội suy và lặp tối đa SNAP_PASSES lượt cho tới khi mọi frame đo được đều chạm đất.
   */
  async function snapTrack(ctx, objectState) {
    const title = 'Hạ đáy mọi frame', merged = new Map(), failed = new Set(), token = S.opToken;
    let frames = [], first = null, ground = new Map(), locked = 0, readError = '', writeError = null, aborted = false;
    S.busy = true;
    try {
      for (let pass = 0; ; pass += 1) {
        if (token !== S.opToken) { aborted = true; break; }
        frames = await A.trackFrames(ctx.job, objectState);
        if (!first) first = new Map(frames.map((f) => [f.frame, B.bottomZ(f.box)]));
        ground = new Map();
        for (const [i, f] of frames.entries()) {
          if (!pass && i % 5 === 0) notify({ kind: 'info', text: `${title}: đang đo mặt đất ${i + 1}/${frames.length} frame (frame ${f.frame})…` });
          let z = null;
          try {
            z = await snapTargetAt(ctx, f);
          } catch (error) {
            failed.add(f.frame);
            readError = readError || error.message;
          }
          ground.set(f.frame, z);
        }
        // Đổi job trong lúc đo: không ghi kế hoạch của job cũ.
        if (token !== S.opToken) { aborted = true; break; }
        const { edits } = Ops.planGroundSnap(frames, ground, SNAP_EPS_M);
        if (!edits.length || pass === SNAP_PASSES) break;
        let result;
        try {
          result = await A.applyEdits(ctx.job, new Map(frames.map((f) => [f.frame, f])), edits);
        } catch (error) {
          mergeRecords(merged, error.record || []);
          writeError = error;
          break;
        }
        mergeRecords(merged, result.record);
        locked = Math.max(locked, result.locked);
        if (!result.saved) break;
      }
    } finally {
      S.busy = false;
    }
    // Hoàn tác của PointSnap phủ cả lượt ghi một frame (CVAT tự hoàn tác được) để một nút trả lại hết; giữ cả khi lỗi
    // giữa chừng hoặc dừng vì đổi job (phần các lượt trước đã ghi).
    const record = [...merged.values()];
    if (record.length) {
      rememberUndo(ctx.job, 'pointsnap', record, title);
      markTrackChanged();
    }
    if (writeError || aborted) {
      const done = record.length ? ` ${record.length} keyframe đã ghi ở các lượt trước, bấm "Hoàn tác" để trả lại.` : ' Chưa ghi gì.';
      notify({ kind: 'error', text: `${title}: ${writeError ? `ghi lỗi: ${writeError.message}` : 'đã dừng vì job đang mở đã đổi'}.${done}` });
      return;
    }
    if (!frames.length) {
      notify({ kind: 'error', text: `${title}: không đọc được frame nào của track trong job này.` });
      return;
    }
    const measured = frames.filter((f) => Number.isFinite(ground.get(f.frame)));
    const why = failed.size ? `; ${failed.size} frame không đọc được point cloud: ${readError}` : '';
    if (!measured.length) {
      notify({ kind: 'error', text: `${title}: không đo được mặt đất ở frame nào trong ${frames.length} frame (ít điểm đất, quá xa${why}). Chưa ghi gì.` });
      return;
    }
    const unmeasured = frames.length - measured.length;
    const skipped = unmeasured ? ` ${unmeasured} frame không đo được mặt đất (ít điểm đất, quá xa${why}) nên giữ theo nội suy, căn bằng mắt.` : '';
    if (!record.length) {
      notify({ kind: 'ok', text: `${title}: ${measured.length}/${frames.length} frame đo được, đáy đều đã nằm trên mặt đất.${skipped}` });
      return;
    }
    const moved = frames.filter((f) => first.has(f.frame) && Math.abs(B.bottomZ(f.box) - first.get(f.frame)) > 0.001);
    const maxShiftM = Math.max(0, ...moved.map((f) => Math.abs(B.bottomZ(f.box) - first.get(f.frame))));
    const off = measured.filter((f) => Math.abs(ground.get(f.frame) - B.bottomZ(f.box)) > SNAP_EPS_M).length;
    const added = record.filter((e) => !e.before.keyframe).length;
    const still = off ? ` ${off} frame vẫn lệch (xem dải track).` : '';
    const lock = locked ? ` ${locked} keyframe bị khóa (lock) nên bỏ qua.` : '';
    notify({ kind: off ? 'info' : 'ok', text: `${title}: hạ / nâng đáy ${moved.length}/${frames.length} frame xuất hiện, dời nhiều nhất ${cm(maxShiftM)} `
      + `(sửa ${record.length - added} keyframe, thêm ${added} keyframe ở frame nội suy); ${measured.length - off} frame đã chạm đất.${still}${skipped}`
      + ` Chưa Save; ${undoHint('pointsnap')}.${lock}` });
  }

  /**
   * Gán nhiều thuộc tính (`values`: { id: giá trị }) cho mọi frame track xuất hiện, ghi luôn vào CVAT; ghi xong đọc lại
   * từng frame để báo đúng số frame đã có giá trị mới.
   */
  async function setTrackAttributes(ctx, objectState, values) {
    const specs = A.attributeSpecs(objectState).filter((a) => a.id in values);
    const immutable = new Set(specs.filter((a) => !a.mutable).map((a) => a.id));
    const title = `Gán ${specs.map((a) => `${a.name} = ${values[a.id]}`).join(', ')}`, token = S.opToken;
    S.busy = true;
    try {
      const frames = await A.trackFrames(ctx.job, objectState);
      if (token !== S.opToken) {
        notify({ kind: 'error', text: `${title}: job đang mở đã đổi trong lúc đọc track; chưa ghi gì.` });
        return false;
      }
      const { edits } = Ops.planAttributes(frames, values, immutable);
      if (!edits.length) {
        notify({ kind: 'ok', text: `${title}: cả ${frames.length} frame track xuất hiện đã đúng giá trị.` });
        return true;
      }
      let result;
      try {
        result = await A.applyEdits(ctx.job, new Map(frames.map((f) => [f.frame, f])), edits);
      } catch (error) {
        throw keepUndoOnError(ctx.job, error, title);
      }
      rememberUndo(ctx.job, result.undo, result.record, title);
      const after = await A.trackFrames(ctx.job, objectState);
      const wrong = Ops.planAttributes(after, values, immutable).summary.wrongFrames;
      const added = result.record.filter((e) => !e.before.keyframe).length;
      const lock = result.locked ? ` ${result.locked} keyframe bị khóa (lock) nên bỏ qua.` : '';
      notify({ kind: wrong ? 'error' : 'ok', text: `${title}: ghi ${result.saved} keyframe${added ? ` (${added} keyframe mới ở đầu job)` : ''}; `
        + `${after.length - wrong}/${after.length} frame track xuất hiện có giá trị mới. Chưa Save; ${undoHint(result.undo)}.${lock}` });
      markTrackChanged();
      return !wrong;
    } finally {
      S.busy = false;
    }
  }

  function markTrackChanged() {
    S.trackDirtyAt = performance.now() - TRACK_RELOAD_DELAY_MS;
    S.measureKey = '';
  }

  async function undoLast(ctx) {
    const last = S.lastUndo;
    if (!last || last.jobId !== ctx.job.id || last.clientID !== activeObject()?.clientID) return;
    const { restored, skipped } = await A.undoEdits(ctx.job, last.record);
    S.lastUndo = null;
    const kept = skipped ? ` ${skipped} keyframe đã bị sửa tiếp nên giữ nguyên.` : '';
    notify({ kind: 'ok', text: `Đã hoàn tác "${last.title}": phục hồi ${restored} keyframe, chưa Save.${kept}` });
    markTrackChanged();
  }

  async function snapGround(ctx) {
    const m = S.measure, contact = m && Checks.usableContact(m.contact, m.box, S.guideline);
    if (!contact) {
      notify({ kind: 'error', text: 'Chưa đo được mặt đất đủ tin cậy quanh box này (ít điểm đất hoặc quá xa); căn bằng mắt ở view Side / Front.' });
      return;
    }
    if (Math.abs(contact.gapM) < SNAP_EPS_M) {
      notify({ kind: 'ok', text: 'Đáy box đã nằm trên mặt đất đo được.' });
      return;
    }
    // Đặt các góc đáy cân giữa mặt đất dưới chúng (box phẳng: đáy giữa mặt đất thấp nhất và cao nhất dưới 4 góc). Đo 25/10/2026 trên box
    // chuẩn ở dốc / bờ vỉa (nuScenes scene-1077, 1100, AV2) nâng hoặc hạ 30 cm rồi hạ đáy: đặt giữa lệch nhãn chuẩn p50
    // 3–7 cm, p90 9–18 cm; hạ tới mặt cao nhất (bản cũ, "dời ít nhất") lệch p50 tới 16 cm, p90 tới 36 cm.
    const box = B.fromCvatPoints(m.objectState.points);
    const edits = [{ frame: ctx.frame, box: Ops.snapToGround(box, B.bottomZ(box) + contact.snapDzM) }];
    await commit(ctx.job, new Map([[ctx.frame, { state: m.objectState }]]), edits, 'Hạ đáy box');
  }

  // ------------------------------------------------------------------ hành động từ panel / phím tắt

  // Thao tác ghi vào CVAT: không chạy khi box đang khóa (CVAT không cho người dùng sửa box khóa, PointSnap cũng vậy).
  const WRITE_ACTIONS = new Set(['snap-ground', 'snap-track', 'set-attrs', 'plan-sync-size', 'plan-smooth-yaw', 'plan-thin', 'apply-plan']);

  async function onAction(name, data = {}) {
    const ctx = A.context();
    if (name === 'rerender') { S.lastPanelAt = 0; return; }
    if (name === 'toggle-panel') { panel?.toggle(); S.lastPanelAt = 0; return; }
    if (!ctx || S.busy) return;
    if (A.isSaving()) { notify({ kind: 'info', text: 'CVAT đang Save; thử lại sau khi Save xong.' }); return; }
    const objectState = activeObject();
    if (WRITE_ACTIONS.has(name) && objectState?.lock) {
      notify({ kind: 'info', text: 'Box đang khóa (lock) trong CVAT: mở khóa trước khi sửa.' });
      S.lastPanelAt = 0;
      return;
    }
    try {
      switch (name) {
        case 'toggle-follow':
          S.lock = !S.lock;
          // Bật khoá khi box đã trôi khỏi màn hình: đưa camera về box trước đã.
          if (S.lock && objectState) A.select(ctx, objectState.clientID, true);
          notify({ kind: 'info', text: S.lock ? 'Khoá box: đổi frame thì camera đi theo box đang chọn.' : 'Đã tắt khoá box: camera đứng yên khi đổi frame.' });
          break;
        case 'dismiss-row':
        case 'restore-row':
          if (objectState) {
            setDismissed(ctx, objectState, data.row, name === 'dismiss-row');
            if (name === 'dismiss-row') {
              notify({ kind: 'ok', text: `Đã bỏ qua "${data.name}" cho ${objectState.label?.name || 'box'} #${objectState.clientID}`
                + `${objectState.objectType === 'track' ? ' ở mọi frame của track' : ''}; bấm ↺ trên dòng đó để hiện lại.` });
            }
          }
          break;
        case 'prev-undone':
        case 'next-undone': {
          const done = doneSet(ctx.job.id), tracks = frameTracks().filter((s) => !done.has(trackId(s)));
          const start = tracks.findIndex((s) => s.clientID === objectState?.clientID), n = tracks.length;
          // Chưa chọn track nào trong danh sách: ⏭ lấy track đầu, ⏮ lấy track cuối.
          const at = name === 'next-undone' ? start + 1 : start < 0 ? n - 1 : start - 1;
          const next = tracks[(at + n) % n];
          if (!next) notify({ kind: 'ok', text: 'Mọi track trong frame này đã đánh dấu xong.' });
          else if (next.clientID === objectState?.clientID) notify({ kind: 'info', text: 'Chỉ còn track đang chọn chưa xong trong frame này.' });
          else A.select(ctx, next.clientID, true);
          break;
        }
        case 'toggle-done':
          if (objectState?.objectType === 'track') toggleDone(ctx, objectState);
          break;
        case 'goto-frame': {
          // Nhảy từ dải track: giữ đúng box này khi tới frame mới (khoá thì camera đi theo, tắt khoá thì đưa camera tới box).
          S.focusOnArrive = objectState?.clientID ?? null;
          if (objectState && S.lockAnchor?.clientID !== objectState.clientID) {
            S.lockAnchor = { clientID: objectState.clientID, center: B.fromCvatPoints(objectState.points)?.center || [0, 0, 0] };
          }
          const res = await Dom.goToFrame(Number(data.frame));
          if (!res.ok) notify({ kind: 'error', text: res.reason });
          break;
        }
        case 'snap-ground':
          await snapGround(ctx);
          break;
        case 'plan-sync-size': {
          const box = objectState && B.fromCvatPoints(objectState.points);
          const dims = data.source === 'median' ? Ops.medianDims(S.track?.keyframes || []) : box?.dims;
          if (dims) await preparePlan(ctx, 'sync-size', { dims: [...dims], source: data.source });
          else notify({ kind: 'info', text: 'Chưa đọc xong keyframe của track; thử lại sau giây lát.' });
          break;
        }
        case 'snap-track':
          if (objectState?.objectType === 'track') { S.plan = null; await snapTrack(ctx, objectState); }
          break;
        case 'draft-attr':
          // Giá trị chọn sẵn cho từng thuộc tính, chưa ghi; nút "Gán cho mọi frame" ghi cả lượt. Rỗng: giữ nguyên.
          if (objectState) {
            const values = S.attrDraft?.clientID === objectState.clientID ? { ...S.attrDraft.values } : {};
            if (data.value) values[data.attr] = data.value;
            else delete values[data.attr];
            S.attrDraft = { clientID: objectState.clientID, values };
          }
          break;
        case 'set-attrs': {
          if (objectState?.objectType !== 'track' || S.attrDraft?.clientID !== objectState.clientID) break;
          const specs = A.attributeSpecs(objectState);
          const values = Object.fromEntries(Object.entries(S.attrDraft.values)
            .filter(([id, v]) => specs.some((a) => a.id === id && a.values.includes(v))));
          if (!Object.keys(values).length) break;
          S.plan = null;
          if (await setTrackAttributes(ctx, objectState, values)) S.attrDraft = null;
          break;
        }
        case 'plan-smooth-yaw':
          await preparePlan(ctx, 'smooth-yaw', {});
          break;
        case 'plan-thin':
          await preparePlan(ctx, 'thin', {});
          break;
        case 'apply-plan':
          await applyPlan(ctx);
          break;
        case 'cancel-plan':
          S.plan = null;
          break;
        case 'undo-last':
          await undoLast(ctx);
          break;
        case 'open-spec':
          await openSpecEditor(ctx);
          break;
        case 'toggle-spec':
          S.specOpen = !S.specOpen;
          break;
        case 'toggle-track':
          S.trackOpen = !S.trackOpen;
          break;
        default:
          break;
      }
    } catch (error) {
      notify({ kind: 'error', text: `Không thực hiện được: ${error.message}` });
    }
    S.lastPanelAt = 0;
  }

  const SHORTCUTS = { KeyF: 'toggle-follow', KeyG: 'snap-ground', KeyD: 'toggle-done', KeyP: 'toggle-panel' };
  window.addEventListener('keydown', (event) => {
    if (!S.enabled || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
    const action = SHORTCUTS[event.code];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    onAction(action);
  }, true);

  // ------------------------------------------------------------------ vòng vẽ

  function viewModel(ctx, m) {
    const g = S.guideline;
    if (S.notice && performance.now() > S.notice.until) S.notice = null;
    const base = { notice: S.notice, guidelineErrors: S.guidelineErrors, follow: S.lock, plan: S.plan };
    if (!ctx) {
      // Đang ở trang job mà chưa có point cloud: CVAT đang tải job (logo chờ). Quá lâu thì nhiều khả năng không phải job 3D.
      S.waitingSince = S.waitingSince || performance.now();
      const slow = performance.now() - S.waitingSince > JOB_LOAD_SLOW_MS;
      return { ...base, status: 'waiting', loading: !slow,
        message: slow ? 'Chưa thấy point cloud: PointSnap chỉ chạy trên job 3D (point cloud). Job 3D đang tải chậm thì chờ thêm.' : 'Đang tải job…' };
    }
    S.waitingSince = 0;
    const done = doneSet(ctx.job.id), tracks = frameTracks();
    const vm = { ...base, status: 'ready', frame: ctx.frame, job: ctx.job.id, busy: S.busy,
      undo: S.lastUndo?.jobId === ctx.job.id && S.lastUndo.clientID === m?.objectState.clientID
        ? { title: S.lastUndo.title, count: S.lastUndo.record.length } : null,
      progress: tracks.length ? { done: tracks.filter((s) => done.has(trackId(s))).length, total: tracks.length } : null };
    if (!m) return vm;
    const measured = Checks.usableContact(m.contact, m.box, g);
    const isTrack = m.objectState.objectType === 'track', rigid = !g.size.nonRigidClasses.includes(m.label);
    if (isTrack) {
      const t = S.track?.clientID === m.objectState.clientID ? S.track : null;
      const cells = t && !t.loading ? trackCells(t.keyframes, rigid, dismissedFor(ctx.job.id, m.objectState)) : null;
      vm.track = !cells ? { loading: true } : {
        loading: false, cells, flagged: cells.filter((c) => c.level !== 'ok').length,
        done: done.has(trackId(m.objectState)), rigid, locked: !!m.objectState.lock,
        attrs: trackAttrs(m.objectState, t.keyframes),
      };
    }
    const rows = checklist(m, g, vm.track, measured, ctx.frame);
    // Dòng người dùng đã bỏ qua cho object này: không tô màu, không tính vào số mục cần xem, có nút hiện lại.
    const dismissed = dismissedFor(ctx.job.id, m.objectState);
    for (const r of rows) {
      const flagged = r.level === 'warning' || r.level === 'error';
      if (flagged && dismissed.has(r.key)) Object.assign(r, { level: 'muted', dismissed: true, fix: null, text: `đã bỏ qua · ${r.text}` });
      else r.canDismiss = flagged;
    }
    if (vm.track && !vm.track.loading) markCurrentFrame(vm.track, rows, ctx.frame);
    vm.box = {
      label: m.label, classKey: m.classKey, clientId: m.objectState.clientID, isTrack, locked: !!m.objectState.lock,
      rangeM: B.rangeXY(m.box, g.sensorOrigin), rows, canSnap: !!measured && !m.objectState.lock,
      done: isTrack && done.has(trackId(m.objectState)),
      level: rows.reduce((w, r) => (RANK[r.level] < RANK[w] ? r.level : w), 'ok'),
      problems: rows.filter((r) => r.level === 'warning' || r.level === 'error').length,
    };
    vm.spec = S.specOpen ? specCard(m, g) : null;
    vm.specOpen = S.specOpen;
    vm.trackOpen = S.trackOpen;
    return vm;
  }

  // ------------------------------------------------------------------ trình sửa spec của project

  /** Box của cả job (REST của chính CVAT, phiên đăng nhập của người dùng) cho "Gợi ý từ job": { label, attributes, dims }. */
  async function jobBoxes(job) {
    const res = await fetch(`/api/jobs/${job.id}/annotations`, { credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = await res.json();
    const labels = new Map(job.labels.map((l) => [l.id, l]));
    const names = (label, list) => Object.fromEntries((list || []).map((a) => [label.attributes.find((s) => s.id === a.spec_id)?.name, a.value]));
    const out = [];
    const push = (labelId, points, attrs) => {
      const label = labels.get(labelId), box = B.fromCvatPoints(points);
      if (label && box) out.push({ label: label.name, attributes: attrs, dims: box.dims });
    };
    for (const s of data.shapes || []) if (s.type === 'cuboid') push(s.label_id, s.points, names(labels.get(s.label_id) || { attributes: [] }, s.attributes));
    for (const t of data.tracks || []) {
      const label = labels.get(t.label_id) || { attributes: [] };
      const fixed = names(label, t.attributes);
      for (const s of t.shapes || []) if (!s.outside && s.type === 'cuboid') push(t.label_id, s.points, { ...fixed, ...names(label, s.attributes) });
    }
    return out;
  }

  /** Lưu qua settings-bridge (ISOLATED world có chrome.storage); chờ xác nhận. */
  /** Lỗi lưu do phần extension trong tab đã cũ (extension vừa tải lại / cập nhật): chỉ tải lại trang mới lưu được. */
  const staleError = (message) => Object.assign(new Error(message), { stale: true });

  function saveSpec(guidelineJson, guidelineName) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onSaved); reject(staleError('không nhận được phản hồi khi lưu')); }, 4000);
      function onSaved(event) {
        if (event.source !== window || event.data?.type !== 'POINTSNAP_SPEC_SAVED') return;
        clearTimeout(timer);
        window.removeEventListener('message', onSaved);
        const d = event.data.detail || {};
        if (d.ok) resolve();
        else reject(d.stale || /context invalidated/i.test(d.error || '') ? staleError(d.error) : new Error(d.error || 'không rõ lỗi'));
      }
      window.addEventListener('message', onSaved);
      window.postMessage({ type: 'POINTSNAP_SPEC_SAVE', detail: { guidelineJson, guidelineName } }, location.origin);
    });
  }

  async function openSpecEditor(ctx) {
    const job = ctx.job, projectId = job.projectId;
    // Bản chưa Save được (extension vừa tải lại) giữ trong sessionStorage của tab: tải lại trang, mở lại là còn.
    const draftKey = `pointsnap.specDraft.${projectId ? `p${projectId}` : `t${job.taskId}`}`;
    let kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(draftKey)); } catch (_) { kept = null; }
    const keptGuideline = kept && G.resolve(JSON.parse(kept.json)).guideline;
    let projectName = projectId ? `Project ${projectId}` : `Task ${job.taskId}`;
    try {
      if (projectId) projectName = (await (await fetch(`/api/projects/${projectId}`, { credentials: 'same-origin' })).json()).name || projectName;
    } catch (_) { /* giữ tên mặc định */ }
    SpecEditor.open({
      labels: job.labels.map((l) => ({ name: l.name, attributes: (l.attributes || []).map((a) => ({ name: a.name, inputType: a.inputType, values: a.values || [] })) })),
      guideline: keptGuideline || S.guideline,
      guidelineName: keptGuideline ? kept.name : S.guidelineName,
      restored: !!keptGuideline,
      projectName,
      selectedLabel: S.measure?.label,
      boxes: () => jobBoxes(job),
      // Box đang chọn với bộ ngưỡng nháp: cùng số đo, chỉ đổi ngưỡng / khóa class.
      preview: (draft) => {
        const m = S.measure;
        if (!m) return null;
        const issues = Checks.checkBox({ ...m.input, classKey: G.classKey(draft, m.label, m.input.attributes),
          others: m.input.others.map((o) => ({ ...o, classKey: G.classKey(draft, o.label, o.attributes) })) }, draft)
          .filter((i) => i.severity !== 'info');
        return issues.length ? { ok: false, text: `#${m.objectState.clientID}: ${issues[0].short}${issues.length > 1 ? ` (+${issues.length - 1})` : ''}` }
          : { ok: true, text: `✓ #${m.objectState.clientID} đạt` };
      },
      onSave: async (json, name) => {
        try {
          await saveSpec(json, name);
          try { sessionStorage.removeItem(draftKey); } catch (_) { /* không có bộ nhớ trang */ }
        } catch (error) {
          if (!error.stale) throw error;
          try { sessionStorage.setItem(draftKey, JSON.stringify({ json, name })); } catch (_) { /* không giữ được bản nháp */ }
          throw new Error('PointSnap vừa được tải lại nên trang này chưa lưu được. Bản sửa đã giữ: tải lại trang (F5), mở ⚙ rồi Save.');
        }
      },
    });
  }

  /** Thẻ spec (A8) của class box đang chọn: khoảng kích thước, thuộc tính bắt buộc, cặp được chồng, quy tắc. */
  function specCard(m, g) {
    const range = g.size.ranges[m.classKey] || g.size.ranges[m.label] || null;
    const attributes = A.attributesOf(m.objectState);
    const pairs = g.overlap.allowedPairs.filter((pair) => pair.includes(m.label) || pair.includes(m.classKey))
      .map(([a, b]) => ([m.label, m.classKey].includes(a) ? b : a));
    return {
      key: range ? (g.size.ranges[m.classKey] ? m.classKey : m.label) : m.classKey,
      dims: range && ['length', 'width', 'height'].map((d, i) => ({ name: { length: 'Dài', width: 'Rộng', height: 'Cao' }[d],
        lo: range[d][0], hi: range[d][1], value: m.box.dims[i] })),
      required: (g.attributes.required[m.label] || []).map((name) => ({ name, value: attributes[name] || '' })),
      overlapWith: [...new Set(pairs)],
      notes: [...(g.specNotes[m.label] || []), ...(g.specNotes['*'] || [])],
    };
  }

  /** Nhãn đổi trong cùng một frame (người dùng vừa sửa / Undo / Save) thì đọc lại keyframe của track. */
  function onStoreChange() {
    const states = A.rawStates(), frame = A.currentFrame();
    if (S.lastStates && states !== S.lastStates && frame === S.lastFrame) S.trackDirtyAt = S.trackDirtyAt || performance.now();
    S.lastStates = states;
    S.lastFrame = frame;
  }

  function tick() {
    try {
      const ctx = S.enabled ? A.context() : null;
      if (ctx && ctx.job.id !== S.jobId) onJobChanged(ctx.job.id, ctx.job.projectId);
      // Plugin QC: tab Hỗ trợ không chọn thì không đo, không vẽ gì lên canvas. Extension: bảng nổi luôn có mặt, luôn đo.
      const shown = !panel || panel.isOpen();
      const cache = shown && ctx && frameData(ctx);
      const m = cache && measureActive(ctx, cache);
      if (ctx) syncTrack(ctx, m?.objectState || null);
      // Người dùng bỏ chọn box (Esc / bấm chỗ trống) ngay trong frame này thì thôi khoá, đổi frame không chọn lại box cũ.
      if (cache && !m && S.lastActive?.frame === ctx.frame && S.lastActive.id !== null) S.lockAnchor = null;
      if (cache) S.lastActive = { frame: ctx.frame, id: m?.objectState.clientID ?? null };
      if (m) {
        // Tô màu chính các điểm của CVAT; cloud không có thuộc tính màu thì vẽ chấm trên lớp phủ thay thế.
        const painted = Colors.highlight(A.cloudObject(ctx), m.insideIdx, m.outsideIdx);
        // Bản xem trước đang mở mà đổi box ở frame này: vẽ box mới bằng nét đứt chồng lên box hiện tại.
        const ghost = S.plan?.clientID === m.objectState.clientID ? S.plan.edits.find((e) => e.frame === ctx.frame && e.box)?.box : null;
        // Box đang khoá: nhớ vị trí ở frame này để đổi frame thì dời camera đúng quãng box đi.
        S.lockAnchor = { clientID: m.objectState.clientID, center: m.box.center };
        const overlaps = dismissedFor(ctx.job.id, m.objectState).has('overlap') ? [] : m.overlaps;
        Overlay.render({ ctx, box: m.box, contact: Checks.usableContact(m.contact, m.box, S.guideline),
          okM: S.guideline.ground.okM, insidePoints: painted ? [] : m.insidePoints, outsidePoints: painted ? [] : m.outsidePoints,
          faces: m.faces, overlaps, ghost: ghost || null });
      } else {
        Colors.clear();
        Overlay.clear();
      }
      updatePanel(ctx, m);
    } catch (error) {
      Colors.clear();
      Overlay.clear();
      notify({ kind: 'error', text: `Lỗi PointSnap (CVAT vẫn dùng bình thường): ${error.message}` });
    }
    requestAnimationFrame(tick);
  }

  /**
   * Extension: bảng nổi trên trang CVAT (kéo đi được, thu thành nút tròn, không mất khi thao tác CVAT). Plugin QC: tab
   * "Hỗ trợ" trong thanh bên CVAT cạnh tab PointSnap QC.
   */
  function createPanel() {
    return document.documentElement.dataset.pointsnapPlugin ? Panel.create(onAction) : Panel.createFloating(onAction);
  }

  function updatePanel(ctx, m) {
    const onJobPage = /\/jobs\/\d+/.test(location.pathname);
    if (!S.enabled || !onJobPage) {
      panel?.destroy();
      panel = null;
      return;
    }
    const now = performance.now();
    if (now - S.lastPanelAt < PANEL_INTERVAL_MS) return;
    S.lastPanelAt = now;
    panel = panel || createPanel();
    panel.render(viewModel(ctx, m));
  }

  /**
   * Đọc bởi popup (chrome.scripting, MAIN world) để báo extension đã chạy đúng trên CVAT này chưa. Gắn trước khi nối
   * CVAT: lỗi lúc khởi động thì popup vẫn đọc được và hiện lỗi đó, thay vì chỉ thấy "chưa chạy".
   */
  const health = () => ({ ...A.health(), enabled: S.enabled, guidelineErrors: S.guidelineErrors.length, startError: S.startError || null });
  root.PointSnapAnnotator = { state: S, health };
  window.postMessage({ type: `${SETTINGS_MESSAGE}_REQUEST` }, location.origin);
  const start = () => {
    try {
      A.subscribe(onStoreChange);
      requestAnimationFrame(tick);
    } catch (error) {
      S.startError = error.message;
    }
  };
  try {
    A.connect(start);
  } catch (error) {
    S.startError = error.message;
  }
})(globalThis);

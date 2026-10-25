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
  if (root.PointSnapAnnotator || !A || !Panel) return;

  const SETTINGS_MESSAGE = 'POINTSNAP_ANNOTATOR_SETTINGS';
  const DONE_KEY = 'pointsnap.annotator.done.';
  const PANEL_INTERVAL_MS = 120;
  const TRACK_RELOAD_DELAY_MS = 400;
  const MAX_DRAWN_POINTS = 600;
  const DEG = 180 / Math.PI;

  const S = {
    enabled: true,
    guideline: G.DEFAULT_GUIDELINE,
    guidelineErrors: [],
    settingsVersion: 0,
    jobId: null,
    frameCache: null,
    followClientId: null,
    track: null,
    trackDirtyAt: 0,
    trackToken: 0,
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
    trackOpen: false,
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
    const { enabled, guidelineJson } = event.data.detail || {};
    S.enabled = enabled !== false;
    let override = {};
    let parseError = null;
    try {
      override = guidelineJson ? JSON.parse(guidelineJson) : {};
    } catch (_) {
      parseError = 'JSON không hợp lệ';
    }
    const { guideline, errors } = G.resolve(override);
    S.guideline = guideline;
    S.guidelineErrors = parseError ? [parseError] : errors;
    S.settingsVersion += 1;
    S.frameCache = null;
  });

  // ------------------------------------------------------------------ dữ liệu của frame

  /** Chỉ mục điểm + bản đồ địa hình của frame đang mở; dựng lại khi đổi frame hoặc CVAT nạp point cloud khác. */
  function frameData(ctx) {
    const positions = A.pointCloud(ctx);
    if (!positions) return null;
    const key = `${ctx.job.id}:${ctx.frame}:${S.settingsVersion}`;
    if (S.frameCache?.key === key && S.frameCache.positions === positions) return S.frameCache;
    const boxes = A.frameStates().filter((s) => !s.outside).map((s) => B.fromCvatPoints(s.points)).filter(Boolean);
    const grid = Grid.build(positions, 1);
    const terrain = Terrain.build(grid, boxes, { origin: S.guideline.sensorOrigin });
    const frameChanged = S.frameCache?.frame !== ctx.frame;
    S.frameCache = { key, positions, grid, terrain, frame: ctx.frame };
    if (frameChanged) onFrameChanged(ctx);
    return S.frameCache;
  }

  /**
   * Mở job khác trong cùng tab (CVAT là SPA): clientID đánh lại từ đầu theo job, nên track / camera theo / bản xem trước
   * của job cũ có thể trùng ID với một object khác của job mới. Bỏ hết trạng thái gắn với job cũ.
   */
  function onJobChanged(jobId) {
    S.jobId = jobId;
    S.followClientId = null;
    S.track = null;
    S.trackToken += 1;
    S.plan = null;
    S.measureKey = '';
    S.measure = null;
    S.lastStates = null;
  }

  function onFrameChanged(ctx) {
    if (S.followClientId === null) return;
    const followed = A.frameStates().find((s) => s.clientID === S.followClientId);
    if (!followed || followed.outside) {
      notify({ kind: 'info', text: 'Track đang theo không có mặt ở frame này.' });
    } else if (A.activeClientId() !== S.followClientId) {
      A.select(ctx, S.followClientId);
    }
  }

  // ------------------------------------------------------------------ số đo của box đang chọn

  function activeObject() {
    const id = A.activeClientId();
    return A.frameStates().find((s) => s.clientID === id && !s.outside) || null;
  }

  /** Điểm của vật quanh box (A4): điểm trong box, điểm lòi ra, khoảng hở từng mặt nhìn thấy. */
  function objectPoints(cache, box, others, fallbackGroundZ) {
    const p = cache.positions;
    // Phần tử thứ 4 là chỉ số điểm trong point cloud của CVAT, để tô màu đúng điểm đó.
    const near = Grid.pointsNearBox(cache.grid, box, ObjectPoints.DEFAULTS.marginM).map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2], i]);
    const sensor = S.guideline.sensorOrigin, half = box.dims.map((d) => d / 2 + 0.3);
    // Mặt bị vật khác che (điểm chắn trên tia LiDAR → tâm mặt, trừ điểm của chính vật quanh box) thì không đo khoảng hở.
    const ownPoint = (i) => B.toLocal(box, [p[3 * i], p[3 * i + 1], p[3 * i + 2]]).every((v, k) => Math.abs(v) <= half[k]);
    return ObjectPoints.measure(near, box, others.map((o) => o.box), localGround(cache, box, fallbackGroundZ), sensor, {
      faceOccluded: (faceCenter) => Grid.segmentBlocked(cache.grid, sensor, faceCenter, { ignore: ownPoint }),
    });
  }

  /**
   * Mặt đất ngay dưới (x, y) trên bản đồ địa hình, nhớ theo ô để không tra lại cho từng điểm. Chỉ dùng ô đất trong ±1 m
   * quanh đáy box (như đo tiếp đất) để mái hiên / nóc vật bên cạnh không thành "mặt đất"; không đo được thì dùng `fallback`.
   */
  function localGround(cache, box, fallback) {
    const bottom = B.bottomZ(box), band = { minZ: bottom - 1, maxZ: bottom + 1 }, cell = cache.terrain.cellM || 0.4;
    const memo = new Map();
    return (x, y) => {
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      if (!memo.has(key)) memo.set(key, cache.terrain.heightAt(x, y, band)?.z ?? fallback);
      return memo.get(key);
    };
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
      .map((s) => ({ box: B.fromCvatPoints(s.points), label: s.label?.name || '', clientId: s.clientID, state: s }))
      .filter((o) => o.box);
    const trackReady = S.track?.clientID === objectState.clientID && !S.track.loading;
    const key = JSON.stringify([cache.key, objectState.clientID, box, others.map((o) => o.box),
      trackReady && S.track.keyframes.length, JSON.stringify(objectState.attributes)]);
    if (key === S.measureKey) return S.measure;

    const g = S.guideline, label = objectState.label?.name || '';
    const attributes = A.attributesOf(objectState);
    const classKey = G.classKey(g, label, attributes);
    const contact = Terrain.measureContact(cache.terrain, cache.grid, box);
    const points = objectPoints(cache, box, others, contact ? contact.topContactZ : B.bottomZ(box));
    const trackDims = trackReady
      ? S.track.keyframes.filter((k) => !k.outside && k.frame !== ctx.frame).map((k) => k.box.dims) : null;
    const issues = Checks.checkBox({
      box, label, classKey, attributes, occluded: !!objectState.occluded, trackDims, contact,
      coarseGroundZ: cache.terrain.coarseHeightAt(box.center[0], box.center[1]),
      others: others.map((o) => ({ ...o, classKey: G.classKey(g, o.label, A.attributesOf(o.state)) })),
      pointsInside: points.insideAboveFloor,
    }, g);
    const byId = new Map(others.map((o) => [o.clientId, o]));
    S.measureKey = key;
    S.measure = {
      objectState, box, label, classKey, contact, issues,
      insideIdx: points.inside.map((q) => q[3]),
      outsideIdx: points.outside.map((q) => q[3]),
      insidePoints: sample(points.inside, MAX_DRAWN_POINTS),
      outsidePoints: sample(points.outside, MAX_DRAWN_POINTS),
      insideCount: points.inside.length,
      outsideCount: points.outside.length,
      faces: points.faces,
      overlaps: issues.filter((i) => i.rule.startsWith('overlap') && byId.has(i.otherClientId))
        .map((i) => ({ box: byId.get(i.otherClientId).box, ratio: i.ratio, allowed: i.rule === 'overlap.allowed' })),
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
   * Dải tổng quan track. Kích thước của vật cứng đánh dấu theo đúng ngưỡng của luật `size.in_track`, để dải và
   * thẻ kiểm tra cùng một kết luận; vật không cứng dùng trung vị / MAD; yaw so với keyframe lân cận để xe rẽ thật
   * không bị đánh dấu.
   */
  function trackSeries(keyframes, rigid) {
    const shown = keyframes.filter((k) => !k.outside);
    let previous = null;
    const yaw = shown.map((k) => {
      previous = previous === null ? k.box.rotation[2] : previous + B.angleDiff(previous, k.box.rotation[2]);
      return previous * DEG;
    });
    const dimFlags = (values) => (rigid ? Checks.inTrackOutliers(values, S.guideline) : Checks.madOutliers(values, 0.05));
    const series = [
      ['Dài', shown.map((k) => k.box.dims[0]), dimFlags],
      ['Rộng', shown.map((k) => k.box.dims[1]), dimFlags],
      ['Cao', shown.map((k) => k.box.dims[2]), dimFlags],
      ['Yaw', yaw, () => Checks.angleOutliers(shown.map((k) => k.box.rotation[2]),
        S.guideline.trackOps.yawJumpDeg[rigid ? 'rigid' : 'nonRigid'], shown.map((k) => k.frame))],
    ];
    return series.map(([name, values, flagsOf]) => {
      const flags = flagsOf(values);
      return { name, points: shown.map((k, i) => ({ frame: k.frame, value: values[i], outlier: flags[i] })) };
    });
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
    S.busy = true;
    try {
      const keyframes = await A.trackKeyframes(ctx.job, objectState);
      const plan = planFor(kind, params, keyframes);
      if (!plan.edits.length) {
        S.plan = null;
        notify({ kind: 'ok', text: `${plan.title}: ${plan.emptyText}` });
        return;
      }
      S.plan = { ...plan, kind, params, clientID: objectState.clientID, signature: signature(plan.edits), canApply: true };
      S.notice = null;
    } finally {
      S.busy = false;
    }
  }

  /** Lập lại kế hoạch trên keyframe mới nhất; khác bản xem trước (track vừa bị sửa) thì không ghi. */
  async function applyPlan(ctx) {
    const plan = S.plan, objectState = activeObject();
    if (!plan || objectState?.clientID !== plan.clientID) {
      S.plan = null;
      notify({ kind: 'error', text: 'Box đang chọn đã đổi; lập lại bản xem trước.' });
      return;
    }
    S.busy = true;
    try {
      const keyframes = await A.trackKeyframes(ctx.job, objectState);
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

  async function commit(job, byFrame, edits, title) {
    const result = await A.applyEdits(job, byFrame, edits);
    S.lastUndo = result.undo === 'pointsnap' && result.saved ? { jobId: job.id, title, record: result.record } : null;
    const undo = result.undo === 'cvat' ? 'Ctrl+Z một lần để hoàn tác' : 'hoàn tác bằng nút "Hoàn tác" của PointSnap (Ctrl+Z của CVAT bản này không gộp được thao tác nhiều keyframe)';
    const locked = result.locked ? ` ${result.locked} keyframe bị khóa (lock) nên bỏ qua.` : '';
    notify({ kind: 'ok', text: `${title}: đã ghi ${result.saved} keyframe vào CVAT, chưa Save; ${undo}.${locked}` });
    markTrackChanged();
  }

  function markTrackChanged() {
    S.trackDirtyAt = performance.now() - TRACK_RELOAD_DELAY_MS;
    S.measureKey = '';
  }

  async function undoLast(ctx) {
    const last = S.lastUndo;
    if (!last || last.jobId !== ctx.job.id) return;
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
    if (Math.abs(contact.gapM) < 0.005) {
      notify({ kind: 'ok', text: 'Đáy box đã nằm trên mặt đất đo được.' });
      return;
    }
    // Đặt đáy giữa mặt đất thấp nhất và cao nhất dưới 4 góc (trên đất phẳng hai mức trùng nhau). Đo 25/10/2026 trên box
    // chuẩn ở dốc / bờ vỉa (nuScenes scene-1077, 1100, AV2) nâng hoặc hạ 30 cm rồi hạ đáy: đặt giữa lệch nhãn chuẩn p50
    // 3–7 cm, p90 9–18 cm; hạ tới mặt cao nhất (bản cũ, "dời ít nhất") lệch p50 tới 16 cm, p90 tới 36 cm.
    const box = B.fromCvatPoints(m.objectState.points);
    const edits = [{ frame: ctx.frame, box: Ops.snapToGround(box, (contact.contactZ + contact.topContactZ) / 2) }];
    await commit(ctx.job, new Map([[ctx.frame, { state: m.objectState }]]), edits, 'Hạ đáy box');
  }

  // ------------------------------------------------------------------ hành động từ panel / phím tắt

  // Thao tác ghi vào CVAT: không chạy khi box đang khóa (CVAT không cho người dùng sửa box khóa, PointSnap cũng vậy).
  const WRITE_ACTIONS = new Set(['snap-ground', 'plan-sync-size', 'plan-smooth-yaw', 'plan-thin', 'apply-plan']);

  async function onAction(name, data = {}) {
    const ctx = A.context();
    if (name === 'rerender') { S.lastPanelAt = 0; return; }
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
          if (S.followClientId !== null) S.followClientId = null;
          else if (objectState?.objectType === 'track') S.followClientId = objectState.clientID;
          else notify({ kind: 'info', text: 'Chọn một track trước khi bật camera theo track.' });
          break;
        case 'next-undone': {
          const done = doneSet(ctx.job.id), tracks = frameTracks().filter((s) => !done.has(trackId(s)));
          const start = tracks.findIndex((s) => s.clientID === objectState?.clientID);
          const next = tracks[(start + 1) % tracks.length];
          if (!next) notify({ kind: 'ok', text: 'Mọi track trong frame này đã đánh dấu xong.' });
          else if (next.clientID === objectState?.clientID) notify({ kind: 'info', text: 'Chỉ còn track đang chọn chưa xong trong frame này.' });
          else A.select(ctx, next.clientID);
          break;
        }
        case 'toggle-done':
          if (objectState?.objectType === 'track') toggleDone(ctx, objectState);
          break;
        case 'goto-frame': {
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

  const SHORTCUTS = { KeyF: 'toggle-follow', KeyG: 'snap-ground', KeyD: 'toggle-done' };
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
    const base = { notice: S.notice, guidelineErrors: S.guidelineErrors, follow: S.followClientId !== null, plan: S.plan };
    if (!ctx) return { ...base, status: 'waiting', message: 'Chờ mở job 3D (point cloud) trên CVAT…' };
    const done = doneSet(ctx.job.id), tracks = frameTracks();
    const vm = { ...base, status: 'ready', frame: ctx.frame,
      undo: S.lastUndo?.jobId === ctx.job.id ? { title: S.lastUndo.title, count: S.lastUndo.record.length } : null,
      progress: tracks.length ? { done: tracks.filter((s) => done.has(trackId(s))).length, total: tracks.length } : null };
    if (!m) return vm;
    const measured = Checks.usableContact(m.contact, m.box, g);
    const gapKind = !measured ? null : Math.abs(measured.gapM) <= g.ground.okM ? 'ok' : measured.gapM > 0 ? 'float' : 'sink';
    vm.box = {
      label: m.label, classKey: m.classKey, clientId: m.objectState.clientID, isTrack: m.objectState.objectType === 'track',
      locked: !!m.objectState.lock,
      dims: m.box.dims, yawDeg: m.box.rotation[2] * DEG, rangeM: B.rangeXY(m.box, g.sensorOrigin), issues: m.issues,
      contact: measured && { kind: gapKind, gapCm: Math.round(measured.gapM * 100),
        text: { ok: 'Sát mặt đất', float: 'Lơ lửng', sink: 'Lún' }[gapKind] },
      points: { inside: m.insideCount, outside: m.outsideCount, faces: m.faces },
    };
    vm.spec = S.specOpen ? specCard(m, g) : null;
    vm.specOpen = S.specOpen;
    vm.trackOpen = S.trackOpen;
    if (vm.box.isTrack) {
      const t = S.track?.clientID === m.objectState.clientID ? S.track : null;
      const rigid = !g.size.nonRigidClasses.includes(m.label);
      vm.track = !t || t.loading ? { loading: true } : {
        loading: false, keyframeCount: t.keyframes.length, series: trackSeries(t.keyframes, rigid),
        done: done.has(trackId(m.objectState)), rigid,
      };
    }
    return vm;
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
      if (ctx && ctx.job.id !== S.jobId) onJobChanged(ctx.job.id);
      const cache = ctx && frameData(ctx);
      const m = cache && measureActive(ctx, cache);
      if (ctx) syncTrack(ctx, m?.objectState || null);
      if (m) {
        // Tô màu chính các điểm của CVAT; cloud không có thuộc tính màu thì vẽ chấm trên lớp phủ thay thế.
        const painted = Colors.highlight(A.cloudObject(ctx), m.insideIdx, m.outsideIdx);
        Overlay.render({ ctx, box: m.box, contact: Checks.usableContact(m.contact, m.box, S.guideline),
          okM: S.guideline.ground.okM, insidePoints: painted ? [] : m.insidePoints, outsidePoints: painted ? [] : m.outsidePoints,
          faces: m.faces, overlaps: m.overlaps });
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
    panel = panel || Panel.create(onAction);
    panel.render(viewModel(ctx, m));
  }

  window.postMessage({ type: `${SETTINGS_MESSAGE}_REQUEST` }, location.origin);
  A.connect(() => {
    A.subscribe(onStoreChange);
    requestAnimationFrame(tick);
  });
  root.PointSnapAnnotator = { state: S };
})(globalThis);

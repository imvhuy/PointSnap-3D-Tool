/*
 * Ngưỡng kiểm tra cho annotator và tool QC (qc/ dùng chung file này). Mặc định ban đầu lấy từ config.yaml (class
 * nuScenes) và spec-vn.yaml (5 class spec VN, khóa `Class/thuộc tính phân loại`) của backend Python cũ, nay đã gỡ (còn
 * trong lịch sử git). Dự án ghi đè bằng trình sửa spec / trang Tùy chọn; chỉ cần ghi phần khác mặc định.
 */
(function (root) {
  'use strict';

  const range = (length, width, height) => ({ length, width, height });

  // Khoảng kích thước: car / truck / barrier / bicycle / construction_vehicle theo config.yaml. Người, xe máy, nón giao
  // thông, bus, trailer nới theo min–max nhãn chuẩn của cả 10 cảnh nuScenes mini (25/10/2026): khoảng cũ dựng từ 5 cảnh
  // báo nhầm 5–29% box chuẩn ở các class này (xe tay ga 1,27 m, người gầy 0,41 m); khoảng mới 0%. Car giữ nguyên
  // (1,3% báo nhầm) vì đó là luật bắt pre-label cắt ngắn xe (KITTI 000008: PointPillars cho xe dài 3,14 m).
  const DEFAULT_GUIDELINE = {
    // Vị trí LiDAR trong hệ tọa độ của point cloud; khác [0, 0, 0] khi dữ liệu xuất ở hệ xe thu.
    sensorOrigin: [0, 0, 0],
    size: {
      warningMargin: 0.10,
      errorMargin: 0.25,
      keyAttributes: { Vehicle: 'subtype', 'Two-wheels': 'rider_state', Pedestrian: 'age_group', Animal: 'species', Obstacle: 'type' },
      ranges: {
        car: range([3.90, 5.79], [1.58, 2.41], [1.39, 2.41]),
        truck: range([4.5, 12.5], [1.8, 3.2], [1.9, 4.3]),
        bus: range([6.0, 18.5], [2.2, 3.6], [2.4, 4.6]),
        trailer: range([1.5, 18.0], [1.5, 3.2], [1.0, 4.5]),
        construction_vehicle: range([2.5, 12.0], [1.5, 3.5], [1.8, 5.0]),
        pedestrian: range([0.30, 1.30], [0.30, 1.05], [1.00, 2.20]),
        motorcycle: range([1.20, 2.80], [0.45, 1.45], [1.00, 2.00]),
        bicycle: range([1.2, 2.1], [0.4, 0.95], [0.8, 2.0]),
        traffic_cone: range([0.28, 0.75], [0.20, 1.25], [0.50, 1.40]),
        barrier: range([0.40, 0.76], [1.73, 3.36], [0.90, 1.35]),
        'Vehicle/car': range([3.90, 5.79], [1.58, 2.41], [1.39, 2.41]),
        'Vehicle/van': range([4.0, 5.6], [1.7, 2.1], [1.8, 2.6]),
        'Vehicle/pickup': range([4.8, 5.6], [1.75, 2.0], [1.7, 2.0]),
        'Vehicle/truck': range([4.5, 12.5], [1.8, 3.2], [1.9, 4.3]),
        'Vehicle/bus': range([6.0, 18.5], [2.2, 3.6], [2.4, 4.6]),
        'Vehicle/Trailer': range([1.5, 18.0], [1.5, 3.2], [1.0, 4.5]),
        'Vehicle/contruction': range([2.5, 12.0], [1.5, 3.5], [1.8, 5.0]),
        'Vehicle/Tricycle': range([2.0, 3.5], [0.9, 1.6], [1.0, 2.2]),
        'Vehicle/Stroller': range([0.6, 1.2], [0.4, 0.8], [0.8, 1.3]),
        'Vehicle/Wheelchair': range([0.8, 1.3], [0.55, 0.8], [0.8, 1.4]),
        'Vehicle/other': range([1.0, 20.0], [0.5, 3.5], [0.8, 5.0]),
        // Chiều cao tách có / không người lái: nhãn chuẩn nuScenes mini (thuộc tính cycle.with_rider / without_rider, 596 box
        // xe máy + xe đạp): có người 1,56–1,93 m, không người 0,95–1,53 m (p99). Khoảng cũ [1,0–2,0] và [0,8–1,8] chồng nhau
        // nên xe ghi with_rider mà box không gồm người (hoặc ngược lại) không bị báo.
        'Two-wheels/with_rider': range([1.20, 2.80], [0.45, 1.45], [1.50, 2.00]),
        'Two-wheels/without_rider': range([1.20, 2.80], [0.40, 1.30], [0.90, 1.55]),
        'Pedestrian/adult': range([0.30, 1.30], [0.30, 1.05], [1.0, 2.2]),
        'Pedestrian/child': range([0.3, 0.9], [0.3, 0.8], [0.7, 1.5]),
        'Animal/dog': range([0.4, 1.2], [0.15, 0.5], [0.3, 0.9]),
        'Animal/cat': range([0.3, 0.7], [0.1, 0.3], [0.2, 0.5]),
        'Animal/cow': range([1.6, 3.0], [0.5, 1.0], [1.1, 1.8]),
        'Animal/buffalo': range([1.8, 3.2], [0.6, 1.2], [1.1, 1.8]),
        'Animal/other': range([0.2, 3.2], [0.1, 1.2], [0.2, 2.0]),
        'Obstacle/traffic cone': range([0.28, 0.75], [0.20, 1.25], [0.50, 1.40]),
        'Obstacle/traffic barrier': range([0.40, 0.76], [1.73, 3.36], [0.90, 1.35]),
      },
      inTrack: { warningAbsM: 0.10, warningRel: 0.05, errorAbsM: 0.30, errorRel: 0.15, minKeyframes: 3 },
      // Vật không cứng: kích thước đổi theo tư thế. Không kiểm scale theo track, không đồng bộ kích thước.
      nonRigidClasses: ['pedestrian', 'Pedestrian', 'Animal'],
    },
    ground: {
      // '*' = mọi class: danh sách tên cố định bỏ sót label đặt tên khác (CVAT công ty: "vehicles"), luật lặng im.
      classes: ['*'],
      // Đo trên 425 box nhãn chuẩn nuScenes scene-0061 (10 frame): đo được 132 box với độ tin cậy ≥ 0,3; ngưỡng 20 / 35 cm
      // báo 9 Cảnh báo + 2 Lỗi trên nhãn chuẩn, ngưỡng 15 / 30 cm báo 18 + 2. Chỉ có một frame, không so được với track.
      okM: 0.05,
      warningM: 0.20,
      errorM: 0.35,
      minConfidence: 0.3,
      pointsBelowBottomMin: 8,
      // Argoverse 2 (LiDAR 64 tia) so với bản đồ mặt đất thật: trong 50 m sai số p50 3–8 cm, p90 ≤ 10 cm, 0 báo nhầm;
      // 50–75 m sai tới 1,37 m và là nơi có cả 4 báo nhầm. Xa hơn ngưỡng này thì không đánh giá cao độ.
      maxRangeM: 50,
    },
    // Đáy box so với mặt đất chung của vùng (bán kính 15 m): chỉ bắt box bị kéo lệch thô khi quanh box thiếu điểm đất.
    // Khoảng rộng vì cảnh thật nhiều tầng: nhãn chuẩn scene-0061 có người đứng trên bục cao hơn mặt đường 1,6 m. Xa hơn
    // 35 m thì point cloud chỉ còn mái nhà / sàn cao, mặt đất chung không tin được nên không kiểm.
    zRange: { minM: -1.0, maxM: 2.0, maxRangeM: 35 },
    // Phạm vi gán nhãn theo spec (m, nhìn từ trên). null = chưa cấu hình, không kiểm tra.
    maxDistanceM: null,
    // Cứ chồng là Lỗi (tỉ lệ > error), mọi class ('*'). Cặp trong allowedPairs chỉ hiện ở mức Thông tin.
    overlap: {
      warning: 0,
      error: 0,
      classes: ['*'],
      allowedPairs: [
        ['pedestrian', 'pedestrian'], ['pedestrian', 'bicycle'], ['pedestrian', 'motorcycle'], ['pedestrian', 'car'],
        ['pedestrian', 'truck'], ['pedestrian', 'construction_vehicle'], ['bicycle', 'bicycle'],
        ['motorcycle', 'motorcycle'], ['bicycle', 'motorcycle'], ['truck', 'trailer'], ['car', 'trailer'],
        ['construction_vehicle', 'trailer'],
        ['Pedestrian', 'Pedestrian'], ['Pedestrian', 'Two-wheels'], ['Pedestrian', 'Vehicle'],
        ['Two-wheels', 'Two-wheels'], ['Animal', 'Animal'], ['Vehicle/truck', 'Vehicle/Trailer'],
        ['Two-wheels', 'Vehicle/Tricycle'],
      ],
    },
    attributes: {
      required: { Vehicle: ['subtype'], 'Two-wheels': ['rider_state'], Pedestrian: ['age_group', 'pose'], Animal: ['species'], Obstacle: ['type'] },
    },
    // Luật spec về việc box có nên tồn tại, lấy từ spec-vn.yaml của backend cũ. Cặp được xét trước
    // overlap.allowedPairs: vi phạm spec thì không ghi "được phép chồng".
    spec: {
      // spec 4.3C: xe có người lái thì người lái nằm trong box xe, không gán thêm box người.
      riderDouble: [['Two-wheels/with_rider', 'Pedestrian']],
      // spec 4.3B: không gán người bên trong xe; người đứng trên nóc / thùng xe (đáy cao hơn đáy xe ≥ insideMinLiftM) thì được.
      insideForbidden: [['Pedestrian', 'Vehicle']],
      insideMinLiftM: 0.6,
    },
    // Thẻ spec (A8): quy tắc ngắn theo class, trích các điều khoản spec-vn mà bộ luật đang dùng. '*' áp cho mọi class.
    specNotes: {
      '*': [
        'Box bao trọn vật, không dư quá mức (spec 4.2).',
        'Đáy box đặt trên mặt tiếp xúc (spec 4.2).',
        'Hướng box theo hướng chuyển động chính; vật đứng yên theo trục dài (spec 4.2).',
        'Không gán box khi vật quá ít điểm LiDAR (spec 4.2).',
      ],
      Vehicle: ['Người ngồi bên trong xe không gán box riêng (spec 4.3B).'],
      'Two-wheels': [
        'Xe có người lái: box gồm cả người lái, không gán thêm box người (spec 4.3C).',
        'Người lên / xuống xe: đổi rider_state đúng frame (spec 4.3C).',
      ],
      Pedestrian: ['Nhóm người đứng sát nhau được phép chồng box (spec 4.3B).'],
      Animal: ['Đàn động vật được phép chồng box (spec 4.3E).'],
    },
    trackOps: {
      thinning: { centerM: 0.05, yawDeg: 1, dimsM: 0.02 },
      yawSmoothing: { window: 5, minChangeDeg: 2, flipToleranceDeg: 30 },
      // Dải track đánh dấu bước nhảy yaw so với keyframe lân cận. Nhãn chuẩn scene-0061 (1395 keyframe): xe / rào chắn
      // lệch lân cận tối đa 12°, người đi bộ tối đa 37° (xoay người thật).
      yawJumpDeg: { rigid: 15, nonRigid: 45 },
      followCamera: true,
    },
  };

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Trộn ghi đè vào mặc định: object trộn theo khóa, mảng và giá trị đơn thay thế nguyên. */
  function merge(base, override) {
    if (!isObject(override)) return base;
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
      // null bỏ một mục dạng object của mặc định (vd khoảng kích thước của một class); với giá trị đơn, null giữ nghĩa riêng
      // (maxDistanceM: null = không kiểm).
      if (value === null && isObject(base[key])) delete out[key];
      else out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
    }
    return out;
  }

  /**
   * Phần của `value` khác `base`, dạng ghi đè: merge(base, diff(base, value)) cho lại `value`. Trình sửa spec chỉ lưu
   * phần này, để khi mặc định được hiệu chỉnh lại (vd khoảng kích thước theo dữ liệu mới), project vẫn hưởng phần
   * mình không sửa. Khóa có trong `base` mà `value` bỏ đi không biểu diễn được bằng ghi đè nên ghi null.
   */
  function diff(base, value) {
    if (!isObject(base) || !isObject(value)) return JSON.stringify(base) === JSON.stringify(value) ? undefined : value;
    const out = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(value)])) {
      if (!(key in value)) { out[key] = null; continue; }
      const d = key in base ? diff(base[key], value[key]) : value[key];
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function finitePair(v) {
    return Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && v[0] <= v[1];
  }

  const get = (g, path) => path.split('.').reduce((v, k) => (isObject(v) ? v[k] : undefined), g);
  const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

  // Mọi giá trị luật / panel đọc trực tiếp. Ghi đè sai kiểu ở bất kỳ chỗ nào thì vòng vẽ sẽ lỗi mỗi frame, nên kiểm hết.
  const NUMBERS = [
    'size.warningMargin', 'size.errorMargin', 'size.inTrack.warningAbsM', 'size.inTrack.warningRel',
    'size.inTrack.errorAbsM', 'size.inTrack.errorRel', 'size.inTrack.minKeyframes',
    'ground.okM', 'ground.warningM', 'ground.errorM', 'ground.minConfidence', 'ground.pointsBelowBottomMin', 'ground.maxRangeM',
    'zRange.minM', 'zRange.maxM', 'zRange.maxRangeM', 'overlap.warning', 'overlap.error',
    'trackOps.yawSmoothing.window', 'trackOps.yawSmoothing.minChangeDeg', 'trackOps.yawSmoothing.flipToleranceDeg',
    'trackOps.yawJumpDeg.rigid', 'trackOps.yawJumpDeg.nonRigid', 'spec.insideMinLiftM',
  ];
  const POSITIVE = ['trackOps.thinning.centerM', 'trackOps.thinning.yawDeg', 'trackOps.thinning.dimsM'];
  const STRING_LISTS = ['size.nonRigidClasses', 'ground.classes', 'overlap.classes'];
  const MAPS = ['size.ranges', 'size.keyAttributes', 'attributes.required', 'specNotes'];
  const ORDERED = [['ground.okM', 'ground.warningM'], ['ground.warningM', 'ground.errorM'], ['overlap.warning', 'overlap.error'],
    ['size.warningMargin', 'size.errorMargin'], ['zRange.minM', 'zRange.maxM']];

  /** Lỗi cấu hình đọc được cho người dùng; [] khi hợp lệ. */
  function validate(g) {
    const errors = [];
    for (const name of NUMBERS) if (!Number.isFinite(get(g, name))) errors.push(`${name} phải là số`);
    for (const name of POSITIVE) if (!(get(g, name) > 0)) errors.push(`${name} phải là số dương`);
    for (const name of STRING_LISTS) if (!isStrings(get(g, name))) errors.push(`${name} phải là danh sách tên class`);
    for (const name of MAPS) if (!isObject(get(g, name))) errors.push(`${name} phải là object`);
    for (const [lo, hi] of ORDERED) if (get(g, lo) > get(g, hi)) errors.push(`${lo} phải ≤ ${hi}`);
    for (const [key, r] of Object.entries(get(g, 'size.ranges') || {})) {
      if (!isObject(r) || !['length', 'width', 'height'].every((d) => finitePair(r[d]))) errors.push(`size.ranges["${key}"] cần length/width/height dạng [min, max]`);
    }
    for (const [key, v] of Object.entries(get(g, 'attributes.required') || {})) if (!isStrings(v)) errors.push(`attributes.required["${key}"] phải là danh sách tên thuộc tính`);
    for (const [key, v] of Object.entries(get(g, 'specNotes') || {})) if (!isStrings(v)) errors.push(`specNotes["${key}"] phải là danh sách câu`);
    for (const name of ['overlap.allowedPairs', 'spec.riderDouble', 'spec.insideForbidden']) {
      const pairs = get(g, name);
      if (!Array.isArray(pairs) || !pairs.every((p) => isStrings(p) && p.length === 2)) errors.push(`${name} phải là danh sách cặp [class, class]`);
    }
    if (g.maxDistanceM !== null && !(Number.isFinite(g.maxDistanceM) && g.maxDistanceM > 0)) errors.push('maxDistanceM phải là số dương hoặc null');
    if (!(Array.isArray(g.sensorOrigin) && g.sensorOrigin.length === 3 && g.sensorOrigin.every(Number.isFinite))) errors.push('sensorOrigin phải là [x, y, z]');
    return errors;
  }

  /** Guideline hiệu lực: mặc định + ghi đè; ghi đè sai thì dùng mặc định và trả về lỗi. */
  function resolve(override) {
    const merged = merge(DEFAULT_GUIDELINE, override);
    const errors = validate(merged);
    return errors.length ? { guideline: DEFAULT_GUIDELINE, errors } : { guideline: merged, errors: [] };
  }

  /** Khóa tra kích thước: `Class/giá trị thuộc tính phân loại` nếu có khoảng cho khóa đó, không thì `Class`. */
  function classKey(guideline, label, attributes) {
    const attr = guideline.size.keyAttributes[label];
    const value = attr ? attributes[attr] : null;
    if (value && guideline.size.ranges[`${label}/${value}`]) return `${label}/${value}`;
    return label;
  }

  const api = { DEFAULT_GUIDELINE, merge, diff, validate, resolve, classKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapGuideline = api;
})(globalThis);

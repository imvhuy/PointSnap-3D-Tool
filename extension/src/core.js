/*
 * Phần logic thuần của extension PointSnap cho CVAT (A15): không đụng DOM, không gọi mạng.
 * Chạy được cả trong content script (gắn vào globalThis.PointSnapCore) lẫn Node (module.exports) để test.
 */
(function (root) {
  'use strict';

  const FLAG_ATTR = 'pointsnap_error';

  // Gợi ý sửa theo luật, cùng nội dung với bảng RULE_FIX_TIPS của giao diện web PointSnap.
  const RULE_FIX_TIPS = {
    'floating': 'Hạ đáy box cho chạm mặt đường, đối chiếu ảnh camera trước và các frame lân cận của track.',
    'floating.no_evidence': 'Không cần sửa. Nếu nghi ngờ, kiểm tra bằng mắt trên ảnh camera.',
    'size.class_range': 'Kiểm tra xem đối tượng có bị gán nhầm class không (ví dụ nhầm car với truck/bus); nếu đúng class thì điều chỉnh kích thước box cho vừa khít vật.',
    'size.in_track': 'Kiểm tra kích thước box so với các frame khác của cùng track; điều chỉnh lại box bất thường.',
    'track.jump': 'Kéo box về đúng vị trí vật ở frame này, hoặc kiểm tra có bị gán nhầm sang vật khác không.',
    'track.split_id': 'Kiểm tra hai track nối tiếp nhau; nếu là cùng một đối tượng thì hợp nhất ID track.',
    'track.long_interpolation': 'Chèn thêm keyframe vào giữa khoảng nội suy dài để box bám sát chuyển động của vật.',
    'heading.flip': 'Xoay box về cùng hướng với các keyframe lân cận của track; bật Cuboid orientation và cho mũi tên đỏ chỉ đầu vật.',
    'heading.motion': 'Xoay box cho mũi tên đỏ (Cuboid orientation) trùng hướng vật đang chạy (spec 4.2). Xe lùi thật thì bỏ qua.',
    'heading.points': 'Xoay box cho các cạnh song song với thân vật trên point cloud (nhìn từ Top view).',
    'fit.empty': 'Xóa box nếu không có vật; vật bị che khuất tạm thời thì đánh dấu occluded thay vì để box rỗng.',
    'fit.outside': 'Nới hoặc dời box cho bao trọn các điểm của vật (spec 4.2), đối chiếu Top / Side / Front view.',
    'fit.loose': 'Kéo mặt box về sát các điểm của vật ở phía được nhìn rõ, không để dư khoảng trống.',
    'fit.overlap': 'Kiểm tra hai box có cùng là một vật không: vẽ trùng thì xóa box thừa; hai vật sát nhau thì thu box cho khỏi lấn.',
    'track.reuse_id': 'Vật chỉ bị che tạm thời (≤ 6 frame) thì bỏ outside và bật occluded; vắng lâu hơn thì tách phần sau thành track mới (spec 4.4.3–4.4.5).',
    'attr.height': 'Xem vật trên point cloud / ảnh: sửa thuộc tính (tư thế, nhóm tuổi, có người lái) hoặc chiều cao box cho khớp.',
    'spec.inside': 'Spec 4.3B: không gán người ngồi trong xe — xóa box người (người đứng trên nóc / thùng xe thì giữ).',
    'spec.rider_double': 'Spec 4.3C: người lái nằm trong box xe hai bánh — xóa box người; người đã xuống xe thì đổi xe sang without_rider.',
    'lidar.missing': 'Mở point cloud tại vị trí trong mục (tâm cụm từng frame): vật thật đang di chuyển mà chưa gán thì vẽ box và track mới (spec 4.2).',
    'attr.rider_state': 'Spec 4.3C: lên xe thì đổi sang with_rider, xuống xe thì đổi sang without_rider (người xuống thành track Pedestrian mới).',
    'cam.sparse': 'Spec 4.2: không gán vật quá ít điểm. Xem lại point cloud / ảnh các frame khác: không suy luận được vật thì xóa box.',
    'track.id_swap': 'Hai vật bị nối nhầm ID: tách lại từ frame bị đổi, mỗi đoạn về đúng track của vật (đối chiếu quỹ đạo, ảnh camera).',
    'track.occluded_long': 'Che khuất quá 6 frame: kết thúc track (Switch outside) và tạo track mới khi vật xuất hiện lại, trừ khi chắc chắn là cùng vật (spec 4.4.5).',
    'attr.missing': 'Chọn giá trị cho thuộc tính bắt buộc; không chắc thì chọn other (spec 3.1.3).',
    'attr.invalid': 'Chọn lại giá trị thuộc tính theo danh sách của guideline dự án.',
    'track.static_shift': 'Vật đứng yên: kéo box về trùng vị trí ở các keyframe khác của track (hoặc copy box từ keyframe đúng).',
    'heading.static': 'Vật đứng yên: xoay box về cùng hướng với các keyframe khác của track.',
    'cam.mismatch': 'Mở ảnh camera của frame, so khung box với vật: dời / chỉnh kích thước box cho khớp vật (đối chiếu cả point cloud).',
    'cam.class': 'Xem vật trên ảnh camera: nhãn sai thì đổi class cho cả track; ảnh nhận nhầm (vật bị che, phản chiếu) thì bỏ qua.',
    'cam.missing': 'Mở ảnh camera và point cloud của frame: có vật thật mà chưa gán thì vẽ thêm box (spec: gán mọi vật trong vùng quan tâm).',
    'critic.box': 'Box Critic nghi box sai: xem gợi ý sửa (dời / kích thước / xoay) trong chi tiết, đối chiếu point cloud rồi chỉnh tay.',
  };
  let sinkFixTip = 'Nâng đáy box lên cho chạm mặt đường, đối chiếu ảnh camera trước và các frame lân cận của track.';
  let defaultFixTip = 'Kiểm tra lại box và nhãn theo hướng dẫn gán nhãn của dự án.';

  // Tên tiếng Việt hiển thị của luật (đồng bộ với PointSnap Backend)
  const RULE_LABEL = {
    'floating': 'Lơ lửng / lún',
    'floating.no_evidence': 'Thiếu bằng chứng mặt đất',
    'size.class_range': 'Kích thước lạ so với class',
    'size.in_track': 'Kích thước lệch trong track',
    'track.jump': 'Nhảy vị trí',
    'track.split_id': 'Nghi tách ID',
    'track.long_interpolation': 'Nội suy dài',
    'track.reuse_id': 'Dùng lại track sau outside',
    'track.occluded_long': 'Che khuất quá lâu',
    'track.id_swap': 'Nghi đổi nhầm ID',
    'track.static_shift': 'Vật đứng yên: box dịch',
    'heading.flip': 'Hướng đổi đột ngột',
    'heading.motion': 'Ngược hướng chuyển động',
    'heading.points': 'Lệch trục cụm điểm',
    'heading.static': 'Vật đứng yên: box xoay',
    'fit.empty': 'Box rỗng',
    'fit.outside': 'Điểm của vật ngoài box',
    'fit.loose': 'Box dư',
    'fit.overlap': 'Hai box chồng nhau',
    'attr.missing': 'Thiếu thuộc tính',
    'attr.invalid': 'Thuộc tính sai giá trị',
    'attr.height': 'Thuộc tính lệch chiều cao',
    'attr.rider_state': 'Quên đổi trạng thái người lái',
    'spec.inside': 'Người bên trong xe',
    'spec.rider_double': 'Người lái bị gán 2 lần',
    'lidar.missing': 'Nghi sót đối tượng (LiDAR)',
    'cam.sparse': 'Box quá ít điểm, ảnh không thấy',
    'cam.mismatch': 'Box lệch vật trên ảnh',
    'cam.class': 'Ảnh camera thấy class khác',
    'cam.missing': 'Ảnh thấy vật chưa có box',
    'critic.box': 'Box Critic nghi box sai',
  };

  function ruleLabel(ruleId) {
    return RULE_LABEL[ruleId] || ruleId || '';
  }

  // Cờ trên CVAT chỉ chứa câu thông báo, nên nhận luật từ mẫu câu của từng bộ phát hiện.
  let RULE_PATTERNS = [
    ['cam.mismatch', /^Box chiếu lên ảnh/i],
    ['cam.class', /^Ảnh camera nhận vật là/i],
    ['cam.missing', /không có box 3D nào/i],
    ['critic.box', /^Box Critic:/i],
    ['cam.sparse', /^Vật chỉ có ≤ \d+ điểm LiDAR/i],
    ['lidar.missing', /mà không có box: nghi sót đối tượng/i],
    ['track.static_shift', /^Vật đứng yên \(các keyframe khác/i],
    ['heading.static', /^Vật đứng yên nhưng hướng box/i],
    ['heading.flip', /đổi hướng nhanh bất thường/i],
    ['heading.motion', /so với hướng chuyển động/i],
    ['heading.points', /trục của cụm điểm/i],
    ['fit.empty', /^Box (không có|chỉ có) .*điểm LiDAR/i],
    ['fit.outside', /nằm ngoài box/i],
    ['fit.loose', /box dư so với vật/i],
    ['fit.overlap', /^Box chồng .* diện tích/i],
    ['track.reuse_id', /đã kết thúc \(outside\)/i],
    ['track.occluded_long', /đánh occluded \d+ frame liền/i],
    ['track.id_swap', /đổi chỗ nhau ở frame/i],
    ['attr.height', /ngoài khoảng hợp lý .* kiểm tra lại thuộc tính/i],
    ['spec.inside', /nằm bên trong box/i],
    ['attr.rider_state', /(chưa đổi sang|người lái đã xuống xe thì đổi)/i],
    ['spec.rider_double', /đã có người lái \(with_rider\)/i],
    ['attr.missing', /thiếu thuộc tính bắt buộc/i],
    ['attr.invalid', /không có trong danh sách cho phép/i],
    ['floating.no_evidence', /thiếu bằng chứng/i],
    ['floating', /\((lơ lửng|lún)\)|so với mặt đất/i],
    ['size.class_range', /bất thường so với class/i],
    ['size.in_track', /so với trung vị track/i],
    ['track.long_interpolation', /nên thêm keyframe/i],
    ['track.split_id', /nghi tách ID/i],
    ['track.jump', /(Tâm box nhảy|Box dịch .* m\/s)/i],
  ];

  const SEVERITIES = { 'Lỗi': 'error', 'Cảnh báo': 'warning', 'Thông tin': 'info' };
  const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

  /** `/tasks/<t>/jobs/<j>` → { taskId, jobId }; trang khác → null. */
  function parseJobUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return null;
    }
    const m = url.pathname.match(/\/tasks\/(\d+)\/jobs\/(\d+)\/?$/);
    return m ? { taskId: Number(m[1]), jobId: Number(m[2]) } : null;
  }

  /** Bỏ dấu `/` cuối để so sánh URL gốc (http://localhost:8080/ ≡ http://localhost:8080). */
  function normalizeBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function ruleOfMessage(text) {
    const hit = RULE_PATTERNS.find(([, re]) => re.test(text));
    return hit ? hit[0] : null;
  }

  /** Gợi ý sửa của một câu thông báo; box lún thì nâng lên thay vì hạ xuống. */
  function fixTip(rule, text) {
    if (rule === 'floating' && /box này chạm đất/i.test(text || '')) {
      return 'Box này chạm đất; kiểm tra cao độ các frame khác của track trên point cloud và ảnh camera.';
    }
    if (rule === 'floating' && /\(lún\)|nằm dưới mặt đất/i.test(text || '')) return sinkFixTip;
    return RULE_FIX_TIPS[rule] || defaultFixTip;
  }

  /** Nạp danh mục quy tắc động từ PointSnap API (GET /api/rules) để đồng bộ 100%. */
  function setRulesCatalog(catalog) {
    if (!catalog || typeof catalog !== 'object') return;
    if (catalog.tips && typeof catalog.tips === 'object') {
      Object.assign(RULE_FIX_TIPS, catalog.tips);
    }
    if (catalog.labels && typeof catalog.labels === 'object') {
      Object.assign(RULE_LABEL, catalog.labels);
    }
    if (catalog.sink_fix_tip) sinkFixTip = String(catalog.sink_fix_tip);
    if (catalog.default_fix_tip) defaultFixTip = String(catalog.default_fix_tip);
    if (Array.isArray(catalog.rules)) {
      const dynamicPatterns = [];
      for (const r of catalog.rules) {
        if (r.id && Array.isArray(r.patterns)) {
          for (const pat of r.patterns) {
            try {
              dynamicPatterns.push([r.id, new RegExp(pat, 'i')]);
            } catch (_) {
              // Bỏ qua regex không hợp lệ
            }
          }
        }
      }
      if (dynamicPatterns.length > 0) {
        RULE_PATTERNS = dynamicPatterns;
      }
    }
  }

  /**
   * Tách nội dung cờ "[Lỗi] a; [Cảnh báo] b" thành từng mục { severity, text, rule, tip }.
   * Câu không có tiền tố mức thì coi là Cảnh báo.
   */
  function parseFlag(value) {
    const text = String(value || '').trim();
    if (!text) return [];
    const parts = text.split(/;\s*(?=\[(?:Lỗi|Cảnh báo|Thông tin)\])/);
    return parts.map((part) => {
      const m = part.match(/^\[(Lỗi|Cảnh báo|Thông tin)\]\s*(.*)$/s);
      const body = (m ? m[2] : part).trim();
      const rule = ruleOfMessage(body);
      return { severity: m ? SEVERITIES[m[1]] : 'warning', text: body, rule, tip: fixTip(rule, body) };
    });
  }

  /** Mức nặng nhất trong các mục của một cờ. */
  function worstSeverity(items) {
    return items.reduce(
      (worst, it) => (SEVERITY_RANK[it.severity] < SEVERITY_RANK[worst] ? it.severity : worst),
      'info',
    );
  }

  /** labels (GET /api/labels) → Map(label_id → { name, specId }) cho các nhãn có thuộc tính cờ. */
  function flagSpecs(labels, attrName) {
    const name = attrName || FLAG_ATTR;
    const specs = new Map();
    for (const label of labels || []) {
      const attr = (label.attributes || []).find((a) => a.name === name);
      if (attr) specs.set(label.id, { name: label.name, specId: attr.id });
    }
    return specs;
  }

  function attrValue(attributes, specId) {
    const hit = (attributes || []).find((a) => a.spec_id === specId);
    return hit ? String(hit.value || '') : '';
  }

  /**
   * Mọi box đang mang cờ trong GET /api/jobs/<id>/annotations, sắp theo frame.
   * Track: lấy keyframe có cờ (thuộc tính mutable nằm ở từng keyframe); bỏ keyframe `outside`.
   */
  function collectFlags(annotations, specs) {
    const flags = [];
    const push = (frame, labelId, value, kind, objectId) => {
      const items = parseFlag(value).filter(it => ['error','warning'].includes(it.severity) && !it.rule?.startsWith('track.'));
      if (!items.length) return;
      flags.push({
        frame,
        label: specs.get(labelId).name,
        kind,
        objectId,
        value,
        items,
        severity: worstSeverity(items),
      });
    };
    for (const shape of (annotations && annotations.shapes) || []) {
      const spec = specs.get(shape.label_id);
      if (!spec || shape.type !== 'cuboid' || shape.outside) continue;
      push(shape.frame, shape.label_id, attrValue(shape.attributes, spec.specId), 'shape', shape.id);
    }
    for (const track of (annotations && annotations.tracks) || []) {
      const spec = specs.get(track.label_id);
      if (!spec) continue;
      let value = attrValue(track.attributes, spec.specId);
      for (const shape of [...(track.shapes || [])].sort((a, b) => a.frame - b.frame)) {
        const attribute = (shape.attributes || []).find((a) => a.spec_id === spec.specId);
        if (attribute) value = String(attribute.value || '');
        if (shape.outside || shape.type !== 'cuboid') continue;
        push(shape.frame, track.label_id, value, 'track', track.id);
      }
    }
    return flags.sort((a, b) => a.frame - b.frame || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }

  /** Các frame có cờ, tăng dần, không trùng. */
  function flaggedFrames(flags) {
    return [...new Set(flags.map((f) => f.frame))].sort((a, b) => a - b);
  }

  /** Frame có cờ kế tiếp (dir = 1) hoặc trước đó (dir = -1) so với `current`; hết thì null. */
  function stepFrame(frames, current, dir) {
    if (dir > 0) return frames.find((f) => f > current) ?? null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i] < current) return frames[i];
    }
    return null;
  }

  /** Tên nhãn trong bộ lọc của CVAT: dấu `.` được thay bằng `∙` (adjustName trong filters-modal). */
  function adjustName(name) {
    return String(name).replace(/\./g, '∙');
  }

  /**
   * JsonLogic của bộ lọc "pointsnap_error không rỗng" trên mọi nhãn có thuộc tính cờ.
   * Cùng dạng CVAT lưu trong lịch sử bộ lọc, để mục "Recently used" nạp lại được.
   */
  function filterLogic(labelNames, attrName) {
    const name = adjustName(attrName || FLAG_ATTR);
    const rules = [...new Set(labelNames)].map((label) => ({
      '!!': { var: `attr.${adjustName(label)}.${name}` },
    }));
    return { or: rules };
  }

  /**
   * Các mục của lần quét PointSnap ứng với một cờ trên CVAT: cùng frame, cùng nhãn,
   * và câu thông báo của mục nằm trong nội dung cờ. Trả về chỉ số trong `findings`.
   */
  function matchFindings(findings, flag) {
    if(Number.isInteger(flag.finding_index))return (findings || []).flatMap((f,i)=>f.finding_index===flag.finding_index?[i]:[]);
    const out = [];
    (findings || []).forEach((f, index) => {
      if (f.frame === flag.frame && f.label === flag.label && f.message && flag.value.includes(f.message)) {
        if (flag.objectId != null) {
          const id = flag.kind === 'track' ? f.track_id : f.source_id;
          if (id == null || String(id) !== String(flag.objectId)) return;
        }
        out.push(index);
      }
    });
    return out;
  }

  /**
   * Chuyển đổi danh sách findings của lần quét PointSnap thành định dạng cờ (flags)
   * để extension hiển thị và điều hướng ngay lập tức kể cả khi CVAT chưa được gắn cờ.
   */
  function flagsFromFindings(findings) {
    const SEV_TEXT = { error: 'Lỗi', warning: 'Cảnh báo', info: 'Thông tin' };
    return (findings || []).filter(f => ['error','warning'].includes(f.severity) && !f.rule?.startsWith('track.') && (!f.error_type || ['floating','size','heading','fit','attribute'].includes(f.error_type))).map((f) => {
      const sev = f.severity || 'warning';
      const msg = f.message || '';
      const rule = f.rule || null;
      const items = [{
        severity: sev,
        text: msg,
        rule,
        tip: fixTip(rule, msg),
      }];
      return {
        frame: f.frame,
        label: f.label || '',
        kind: f.track_id != null ? 'track' : 'shape',
        objectId: f.track_id != null ? f.track_id : f.source_id,
        value: `[${SEV_TEXT[sev] || 'Cảnh báo'}] ${msg}`,
        items,
        severity: sev,
        fromScan: true,
        finding_index: f.finding_index,
      };
    }).sort((a, b) => a.frame - b.frame || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }

  const api = {
    FLAG_ATTR,
    RULE_FIX_TIPS,
    RULE_LABEL,
    ruleLabel,
    setRulesCatalog,
    parseJobUrl,
    normalizeBase,
    ruleOfMessage,
    fixTip,
    parseFlag,
    worstSeverity,
    flagSpecs,
    collectFlags,
    flaggedFrames,
    stepFrame,
    adjustName,
    filterLogic,
    matchFindings,
    flagsFromFindings,

  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

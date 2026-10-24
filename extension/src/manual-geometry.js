/* Pure geometry. Units: metres/radians; CVAT Euler XYZ, z up. Never modifies its inputs. */
(function (root) {
  'use strict';
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  function matrix(rotation) {
    const [x, y, z] = rotation, a = Math.cos(x), b = Math.sin(x), c = Math.cos(y),
      d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
    return [[c*e,-c*f,d],[a*f+b*e*d,a*e-b*f*d,-b*c],[b*f-a*e*d,b*e+a*f*d,a*c]];
  }
  const mul = (m, p) => m.map(row => row.reduce((s, v, i) => s + v*p[i], 0));
  const world = (box, p) => add(box.center, mul(matrix(box.rotation), p));
  function local(box, p) {
    const m = matrix(box.rotation), q = sub(p, box.center);
    return [0,1,2].map(i => m.reduce((s, row, j) => s + row[i]*q[j], 0));
  }
  const signs = [[1,1,-1],[-1,1,-1],[-1,-1,-1],[1,-1,-1],[1,1,1],[-1,1,1],[-1,-1,1],[1,-1,1]];
  const corners = box => signs.map(s => world(box, s.map((v, i) => v*box.dims[i]/2)));
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const faces = {front:[0,3,7,4],back:[1,2,6,5],left:[0,1,5,4],right:[2,3,7,6],bottom:[0,1,2,3],top:[4,5,6,7]};
  function project(point, camera, rect) {
    if (!camera?.matrixWorldInverse?.elements || !camera?.projectionMatrix?.elements) return null;
    const transform = (m, v) => [0,1,2,3].map(i => m[i]*v[0]+m[i+4]*v[1]+m[i+8]*v[2]+m[i+12]*v[3]);
    const v = transform(camera.projectionMatrix.elements, transform(camera.matrixWorldInverse.elements, [...point,1]));
    if (!v.every(Number.isFinite) || Math.abs(v[3]) < 1e-10 || camera.isPerspectiveCamera && v[3] <= 0) return null;
    const n = v.slice(0,3).map(x => x/v[3]);
    if (n[2] < -1 || n[2] > 1) return null;
    return [(n[0]+1)*rect.width/2, (1-n[1])*rect.height/2];
  }
  function valid(box) {
    return !!box && ['center','dims','rotation'].every(k => Array.isArray(box[k]) && box[k].length===3 && box[k].every(Number.isFinite)) && box.dims.every(v => v>0);
  }
  const CLASS_SPECS = {
    car: { name: 'Ô tô', dims: [4.62, 1.95, 1.60], ranges: { length: [3.48, 5.76], width: [1.60, 2.38], height: [1.40, 2.30] } },
    truck: { name: 'Xe tải', dims: [6.93, 2.51, 2.84], ranges: { length: [4.54, 10.20], width: [1.79, 2.88], height: [1.72, 3.96] } },
    bus: { name: 'Xe buýt', dims: [11.0, 2.95, 3.45], ranges: { length: [6.91, 13.82], width: [2.56, 3.52], height: [2.81, 3.61] } },
    pedestrian: { name: 'Người', dims: [0.67, 0.67, 1.72], ranges: { length: [0.37, 1.04], width: [0.43, 0.98], height: [1.35, 2.00] } },
    motorcycle: { name: 'Xe máy', dims: [2.11, 0.77, 1.48], ranges: { length: [1.81, 2.40], width: [0.56, 1.20], height: [1.34, 1.93] } },
    bicycle: { name: 'Xe đạp', dims: [1.70, 0.60, 1.28], ranges: { length: [1.34, 2.07], width: [0.43, 0.93], height: [1.03, 1.93] } },
    trailer: { name: 'Rơ-moóc', dims: [7.50, 2.25, 3.50], ranges: { length: [1.79, 14.01], width: [2.17, 2.33], height: [3.31, 3.89] } },
    construction_vehicle: { name: 'Xe công trình', dims: [5.60, 2.55, 2.45], ranges: { length: [3.71, 7.56], width: [2.11, 3.02], height: [2.03, 2.92] } },
    traffic_cone: { name: 'Cọc tiêu', dims: [0.41, 0.41, 1.07], ranges: { length: [0.30, 0.64], width: [0.29, 1.21], height: [0.51, 1.31] } },
    barrier: { name: 'Rào chắn', dims: [0.50, 2.50, 0.98], ranges: { length: [0.40, 0.76], width: [1.79, 3.59], height: [0.89, 1.34] } },
  };
  function evaluateSpec(box) {
    if (!valid(box)) return null;
    const spec = CLASS_SPECS[box.label] || CLASS_SPECS.car;
    const [l, w, h] = box.dims;
    const { length: rL, width: rW, height: rH } = spec.ranges;
    const check = (val, range) => val < range[0] ? 'too_small' : val > range[1] ? 'too_large' : 'ok';
    const evalL = check(l, rL), evalW = check(w, rW), evalH = check(h, rH);
    return {
      spec,
      eval: [evalL, evalW, evalH],
      isAllOk: evalL === 'ok' && evalW === 'ok' && evalH === 'ok',
      deltaSpec: [l - spec.dims[0], w - spec.dims[1], h - spec.dims[2]].map(v => v * 100)
    };
  }
  function specReference(box) {
    if (!valid(box)) return null;
    const spec = CLASS_SPECS[box.label] || CLASS_SPECS.car;
    const bottomZ = box.center[2] - box.dims[2] / 2;
    return {
      center: [box.center[0], box.center[1], bottomZ + spec.dims[2] / 2],
      dims: [...spec.dims],
      rotation: [...box.rotation],
      label: box.label || 'car'
    };
  }
  function reference(guide) {
    if (!valid(guide?.baseline) || (guide.evidence !== 'measured' && guide.evidence !== 'spec')) return null;
    const b = JSON.parse(JSON.stringify(guide.baseline)), r = guide.reference || {}, rule = String(guide.rule || '');
    const vec = v => v?.length === 3 && v.every(Number.isFinite);
    // Fit guides need an explicit centre and size from the server; visible point extents alone are not a target.
    // fit.offset / fit.yaw proposals include the unchanged baseline size along with their measured centre/yaw.
    if (rule.startsWith('fit.') && !(vec(r.center) && vec(r.dims))) return null;
    // heading.points measures yaw only; any centre/size from the visible point cluster is not a target.
    const yawOnly = rule === 'heading.points';
    let changed = false;
    if (!yawOnly && vec(r.center)) { b.center = [...r.center]; changed = true; }
    if (!yawOnly && Number.isFinite(r.bottom_z)) { b.center[2] = r.bottom_z+b.dims[2]/2; changed=true; }
    if (Number.isFinite(r.yaw)) { b.rotation[2]=r.yaw; changed=true; }
    if (!yawOnly && vec(r.dims)) { b.dims=[...r.dims]; changed=true; }
    return changed ? b : null;
  }
  function isAligned(box, ref, distTol = 0.03, dimTol = 0.03, yawTolDeg = 2.0) {
    if (!valid(box) || !valid(ref)) return false;
    const dDist = Math.hypot(box.center[0] - ref.center[0], box.center[1] - ref.center[1], box.center[2] - ref.center[2]);
    const dDim = Math.max(...[0,1,2].map(i => Math.abs(box.dims[i] - ref.dims[i])));
    const dYaw = Math.abs(wrap(box.rotation[2] - ref.rotation[2])) * 180 / Math.PI;
    return dDist <= distTol && dDim <= dimTol && dYaw <= yawTolDeg;
  }
  function metrics(box, baseline, guide, customGroundZ = null, customPitch = null, customRoll = null) {
    const base = valid(baseline) ? baseline : box, r=guide?.reference || {}, points=guide?.points || [];
    const targetGz = Number.isFinite(r.ground_z) ? r.ground_z : customGroundZ;
    const qs = points.map(p => local(box,p)), half=box.dims.map(v=>v/2);
    const gaps = qs.length ? [0,1,2].map(i => [half[i]-Math.max(...qs.map(p=>p[i])), half[i]+Math.min(...qs.map(p=>p[i]))]) : null;
    return {delta:sub(box.center,base.center).map(v=>v*100),
      deltaDims:sub(box.dims,base.dims).map(v=>v*100),
      deltaRotation:sub(box.rotation,base.rotation).map(v=>wrap(v)*180/Math.PI),
      bottom:Math.min(...corners(box).map(p=>p[2])),
      groundGap:Number.isFinite(targetGz)? Math.min(...corners(box).map(p=>p[2]-groundHeight(p,guide,targetGz,customPitch,customRoll,box))):null,
      yawGap:Number.isFinite(r.yaw)?wrap(box.rotation[2]-r.yaw)*180/Math.PI:null, gaps};
  }
  function groundHeight(point,guide,customGroundZ = null,customPitch = null,customRoll = null,fallbackBox = null){
    const r=guide?.reference || {};
    const b=valid(guide?.baseline) ? guide.baseline : (valid(fallbackBox) ? fallbackBox : null);
    const targetGz = Number.isFinite(r.ground_z) ? r.ground_z : customGroundZ;
    if(!Number.isFinite(targetGz))return null;
    if(!valid(b))return targetGz;
    const yaw=b.rotation[2];
    const dx=point[0]-b.center[0], dy=point[1]-b.center[1];
    const alongX=dx*Math.cos(yaw)+dy*Math.sin(yaw);
    const alongY=-dx*Math.sin(yaw)+dy*Math.cos(yaw);
    const pitch = (customPitch!==null)?customPitch:((r.pitch_deg || 0)*Math.PI/180);
    const roll = (customRoll!==null)?customRoll:((r.roll_deg || 0)*Math.PI/180);
    return targetGz+alongX*Math.tan(pitch)+alongY*Math.tan(roll);
  }
  const api={wrap,add,sub,matrix,mul,world,local,corners,edges,faces,project,valid,reference,specReference,isAligned,metrics,groundHeight,CLASS_SPECS,evaluateSpec};
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  else root.PointSnapGeometry=api;
})(globalThis);

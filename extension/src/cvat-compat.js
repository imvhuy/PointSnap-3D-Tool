/* CVAT 2.77.1 adapter. Isolate private camera access and fail closed on incompatible canvases. */
(function(root){
  'use strict';
  function sameOrigin(a,b){
    try {
      const key=value=>{const u=new URL(value);const host=['localhost','127.0.0.1','[::1]'].includes(u.hostname)?'localhost':u.hostname;
        return `${u.protocol}//${host}:${u.port || (u.protocol==='https:'?443:80)}`;};
      return key(a)===key(b);
    }catch(_){return false;}
  }
  function inspect(store) {
    const a=store?.getState?.()?.annotation, canvas=a?.canvas?.instance;
    if (!canvas?.html || !a.job?.instance || a.player?.frame?.fetching) return null;
    const dom=canvas.html(), views=canvas.view?.views;
    if (!views || !['perspective','top','side','front'].every(k =>
      dom[k]?.getDrawnObjects && views[k]?.renderer?.domElement===dom[k] &&
      views[k]?.camera?.projectionMatrix?.elements?.length===16 && views[k]?.camera?.matrixWorldInverse?.elements?.length===16)) return null;
    return {annotation:a,canvas,dom,views,frame:a.player.frame.number,jobId:a.job.instance.id,job:a.job.instance};
  }
  function record(context, identity=null) {
    const records=context.dom.perspective.getDrawnObjects();
    const id=context.annotation.annotations.activatedStateID;
    const found=records.filter(r => identity ?
      r.state?.serverID===identity.server_id && r.state?.objectType===identity.kind : r.state?.clientID===id);
    return found.length===1 ? found[0]:null;
  }
  function readBox(record, frame) {
    const m=record?.cuboid?.perspective, s=record?.state;
    if (!m || !s || s.outside || s.shapeType!=='cuboid') return null;
    const box={center:[m.position.x,m.position.y,m.position.z],dims:[m.scale.x,m.scale.y,m.scale.z],
      rotation:[m.rotation.x,m.rotation.y,m.rotation.z],frame,label:s.label?.name || s.label || 'car',
      track_id:s.objectType==='track'?s.serverID:null,source_id:s.objectType==='shape'?s.serverID:null,
      attrs:{...(s.attributes || {}),occluded:!!s.occluded},keyframe:!!s.keyframe,outside:!!s.outside};
    return root.PointSnapGeometry.valid(box)?box:null;
  }
  function normalizeExport(data, labels) {
    const result=[], byId=new Map(labels.map(l=>[l.id,l]));
    const convert=(shape,owner=null,inherited={})=>{
      if (shape.type!=='cuboid' || !shape.points?.slice(0,9).every(Number.isFinite)) return;
      const label=byId.get(owner?.label_id ?? shape.label_id); if (!label) throw Error('Missing label');
      const attrs={...inherited};
      for (const a of shape.attributes || []) attrs[label.attributes.find(s=>s.id===a.spec_id)?.name || String(a.spec_id)]=a.value;
      attrs.occluded=!!shape.occluded;
      result.push({center:shape.points.slice(0,3),rotation:shape.points.slice(3,6),dims:shape.points.slice(6,9),
        frame:shape.frame,label:label.name,track_id:owner?.id ?? null,source_id:owner?null:shape.id ?? null,
        attrs,outside:!!shape.outside,keyframe:true});
      return attrs;
    };
    for (const s of data.shapes || []) convert(s);
    for (const t of data.tracks || []) {
      const label=byId.get(t.label_id); if(!label) throw Error('Missing label');
      let attrs={}; for(const a of t.attributes || []) attrs[label.attributes.find(s=>s.id===a.spec_id)?.name || String(a.spec_id)]=a.value;
      for(const s of [...t.shapes].sort((a,b)=>a.frame-b.frame)) attrs=convert(s,t,attrs) || attrs;
    }
    return result;
  }
  let cachedExport=null, cachedExportJobId=null, cachedExportTime=0;
  function clearCache(){cachedExport=null;cachedExportJobId=null;cachedExportTime=0;}
  async function draft(context, box, rule='') {
    const fit=rule==='fit.offset' || rule==='fit.yaw';
    const now=Date.now();
    // Track fits need the latest unsaved keyframe list, including peers edited since the last draft.
    if(fit || !cachedExport || cachedExportJobId!==context.jobId || (now-cachedExportTime)>8000){
      cachedExport=await context.job.annotations.export();
      cachedExportJobId=context.jobId;
      cachedExportTime=now;
    }
    let normalized=normalizeExport(cachedExport,context.job.labels);
    const needed=new Set([context.frame]);
    if(fit && box.track_id!=null) {
      for(const b of normalized)
        if(b.track_id===box.track_id && b.label===box.label && !b.outside && b.keyframe) needed.add(b.frame);
    }
    const completeFrames=[...needed].sort((a,b)=>a-b);
    const actualFrames=await Promise.all(completeFrames.map(async frame=>[frame,await context.job.annotations.get(frame,false,[])]));
    // The fit reference/gate measures peer frames too. Include every interpolated blocker in those frames,
    // not just exported keyframes of the selected track. Any failed read leaves the whole draft uncertified.
    normalized=normalized.filter(b=>!needed.has(b.frame));
    for(const [frame,states] of actualFrames) {
      if(!Array.isArray(states)) throw Error('Incomplete frame states');
      for(const s of states) {
        if(s.shapeType!=='cuboid') continue;
        if(!Array.isArray(s.points) || s.points.length<9 || !s.points.slice(0,9).every(Number.isFinite) || !s.label?.name)
          throw Error('Invalid cuboid state');
        const label=s.label, attrs={occluded:!!s.occluded};
        for(const [id,value] of Object.entries(s.attributes || {})) attrs[(label.attributes || []).find(a=>String(a.id)===id)?.name || id]=value;
        normalized.push({center:s.points.slice(0,3),rotation:s.points.slice(3,6),dims:s.points.slice(6,9),
          frame,label:label.name,track_id:s.objectType==='track'?s.serverID:null,
          source_id:s.objectType==='shape'?s.serverID:null,attrs,outside:!!s.outside,keyframe:!!s.keyframe});
      }
    }
    // Use the actual mesh, including the final mouse movement before Redux updates.
    const same=b=>b.frame===box.frame && (box.track_id!=null?b.track_id===box.track_id:b.track_id==null && b.source_id===box.source_id);
    const selected=normalized.find(same);
    const actual={...box,attrs:selected?.attrs || box.attrs};
    normalized=normalized.filter(b=>!same(b));
    normalized.push(actual);
    normalized=normalized.filter(b=>needed.has(b.frame) || (box.track_id!=null && b.track_id===box.track_id));
    return {box:actual,context:normalized,context_complete:true,complete_frames:completeFrames};
  }
  function sampleNearbyPoints(context, box, maxRadius = 12, maxPoints = 800) {
    try {
      const scene = context?.views?.perspective?.scene || context?.canvas?.view?.scene || context?.canvas?.view?.model?.scene;
      if (!scene?.traverse) return null;
      let pos = null;
      scene.traverse(o => {
        if (!pos && (o.isPoints || o.type === 'Points') && o.geometry?.attributes?.position?.array) {
          pos = o.geometry.attributes.position.array;
        }
      });
      if (!pos || !pos.length) return null;
      const [bx, by, bz] = box.center, pts = [];
      const stride = Math.max(1, Math.floor(pos.length / (3 * 4000)));
      for (let i = 0; i < pos.length; i += 3 * stride) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        if (Math.hypot(x - bx, y - by, z - bz) <= maxRadius) {
          pts.push([x, y, z]);
          if (pts.length >= maxPoints) break;
        }
      }
      return pts.length ? pts : null;
    } catch (_) {
      return null;
    }
  }
  function estimateRoadGround(context, box) {
    const pts = sampleNearbyPoints(context, box, 12, 1000);
    if (!pts || !pts.length) return null;
    const [bx, by, bz] = box.center;
    const [l, w, h] = box.dims;
    const bottomZ = bz - h / 2;
    const candidates = [];
    for (const [x, y, z] of pts) {
      const dx = Math.abs(x - bx), dy = Math.abs(y - by);
      const inRing = (dx >= l / 2 + 0.3 && dx <= l / 2 + 3.5) || (dy >= w / 2 + 0.3 && dy <= w / 2 + 3.5);
      if (inRing && z <= bottomZ + 0.35 && z >= bottomZ - 1.5) {
        candidates.push(z);
      }
    }
    if (candidates.length < 5) return null;
    candidates.sort((a, b) => a - b);
    return candidates[Math.floor(candidates.length / 2)];
  }
  const api={inspect,record,readBox,normalizeExport,draft,sameOrigin,clearCache,sampleNearbyPoints,estimateRoadGround};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.PointSnapCvatCompat=api;
})(globalThis);

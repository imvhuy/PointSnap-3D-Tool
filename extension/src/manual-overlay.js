/* SVG overlays projected with CVAT's own cameras. No scene or annotation writes. */
(function(root){
  'use strict';
  const G=root.PointSnapGeometry, C=root.PointSnapCvatCompat, layers=new Map();
  const names={perspective:'3D',top:'Nhìn trên',side:'Bên hông',front:'Phía trước'};
  let lastKey='', latency=[], inputLatency=[], lastInputAt=null;
  let cachedRects=null, lastRectCheck=0;
  let sessionGroundZ=null, activeGroundZ=-1.80, lastBox=null, lastContext=null, lastOptions=null;
  let sessionSlopeMode=null, sessionPitchOffset=0, sessionRollOffset=0;
  let lastEvaluatedPoints={inside:0, outside:0, hasData:false};
  let resizeObserver=null;

  if(typeof window!=='undefined' && window.addEventListener) {
    window.addEventListener('resize',()=>{lastRectCheck=0;cachedRects=null;});

    window.addEventListener('message', event => {
      if(event.source!==window || event.origin!==location.origin) return;
      const {type, detail} = event.data || {};
      if(type==='POINTSNAP_MANUAL_ACTION' && detail) {
        const act = detail.action, param = detail.param;
        if(act==='ground-adj') {
          sessionGroundZ = Number(((activeGroundZ || 0) + Number(param)).toFixed(2));
          forceReRender();
        } else if(act==='ground-set-bottom') {
          if(lastBox) {
            sessionGroundZ = Number((lastBox.center[2] - lastBox.dims[2] / 2).toFixed(2));
            forceReRender();
          }
        } else if(act==='slope-mode') {
          if(param==='vehicle') {
            sessionSlopeMode = 'vehicle';
            sessionPitchOffset = 0;
            sessionRollOffset = 0;
          } else if(param==='flat') {
            sessionSlopeMode = 'flat';
            sessionPitchOffset = 0;
            sessionRollOffset = 0;
          }
          forceReRender();
        } else if(act==='pitch-adj') {
          sessionSlopeMode = 'custom';
          sessionPitchOffset = Number((sessionPitchOffset + (Number(param) * Math.PI) / 180).toFixed(4));
          forceReRender();
        } else if(act==='pitch-reset') {
          sessionSlopeMode = 'custom';
          sessionPitchOffset = -(lastBox ? (lastBox.rotation[1] || 0) : 0);
          forceReRender();
        } else if(act==='roll-adj') {
          sessionSlopeMode = 'custom';
          sessionRollOffset = Number((sessionRollOffset + (Number(param) * Math.PI) / 180).toFixed(4));
          forceReRender();
        } else if(act==='roll-reset') {
          sessionSlopeMode = 'custom';
          sessionRollOffset = -(lastBox ? (lastBox.rotation[0] || 0) : 0);
          forceReRender();
        }
      }
    });
  }

  function observeCanvases(views) {
    if(typeof ResizeObserver==='undefined' || resizeObserver) return;
    try {
      resizeObserver = new ResizeObserver(() => {
        cachedRects = null;
        lastRectCheck = 0;
        forceReRender();
      });
      for(const v of Object.values(views)) {
        if(v?.renderer?.domElement) resizeObserver.observe(v.renderer.domElement);
      }
    } catch (_) {}
  }

  const signed=(v,d=1)=>Number.isFinite(v)?`${v>0?'+':''}${v.toFixed(d)}`:'—';
  const safe=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function element(tag){return document.createElementNS('http://www.w3.org/2000/svg',tag);}
  function mount(view,canvas) {
    let l=layers.get(view);
    if(l?.canvas===canvas && l.svg.isConnected) return l;
    l?.svg.remove();
    const svg=element('svg'); svg.dataset.pointsnapView=view;
    svg.style.cssText='position:fixed;pointer-events:none;z-index:1001;overflow:hidden;font:12px system-ui;';
    svg.setAttribute('aria-hidden','true'); document.body.appendChild(svg);
    l={svg,canvas}; layers.set(view,l); return l;
  }
  function clear(){
    for(const l of layers.values()) l.svg.remove();
    layers.clear();lastKey='';cachedRects=null;lastRectCheck=0;
    lastBox=null;lastContext=null;lastOptions=null;
    if(resizeObserver){
      try{resizeObserver.disconnect();}catch(_){}
      resizeObserver=null;
    }
    if(typeof window!=='undefined' && window.postMessage) {
      window.postMessage({type:'POINTSNAP_MANUAL_TELEMETRY', detail:null}, location.origin);
    }
  }

  function forceReRender(){
    if(!lastContext || !lastBox || !lastOptions) return;
    lastKey='';
    render({context:lastContext,box:lastBox,baseline:lastBox,guide:null,options:lastOptions,evaluation:null,dragging:false});
  }

  function render({context,box,baseline,guide,options,evaluation,dragging,sampledAt,inputAt}) {
    if(!G.valid(box) || !options.enabled){clear();return;}
    lastBox=box;lastContext=context;lastOptions=options;
    const started=performance.now();
    const now=sampledAt || started;

    observeCanvases(context.views);

    // Dynamic viewport rect caching with instant maximize/collapse detection
    let needsRectUpdate = !cachedRects || (!dragging && now - lastRectCheck > 250);
    if(!needsRectUpdate && cachedRects) {
      for(const [k, v] of Object.entries(context.views)) {
        const el = v.renderer.domElement;
        const isHidden = !el.offsetParent || el.offsetWidth <= 25;
        const wasHidden = (cachedRects[k]?.width || 0) <= 25;
        if(isHidden !== wasHidden) {
          needsRectUpdate = true;
          break;
        }
      }
    }
    if(needsRectUpdate) {
      cachedRects = Object.fromEntries(
        Object.entries(context.views).map(([k, v]) => {
          const el = v.renderer.domElement;
          if(!el.offsetParent || el.offsetWidth <= 25 || el.offsetHeight <= 25) {
            return [k, { left: 0, top: 0, width: 0, height: 0 }];
          }
          return [k, el.getBoundingClientRect()];
        })
      );
      lastRectCheck = now;
    }
    const rectangles = cachedRects;

    // Detect if any view is currently maximized
    let maximizedView = null;
    const orthoKeys = ['top', 'side', 'front'];
    const winW = (typeof window !== 'undefined' && window.innerWidth) || 1200;

    for (const k of orthoKeys) {
      const el = context.views[k]?.renderer?.domElement;
      const r = rectangles[k];
      if (el && el.offsetParent !== null && r && r.width > 500 && r.height > 250) {
        const others = orthoKeys.filter(o => o !== k);
        const otherVisible = others.some(o => {
          const oEl = context.views[o]?.renderer?.domElement;
          const oR = rectangles[o];
          return oEl && oEl.offsetParent !== null && oR && oR.width > 50 && oR.height > 50;
        });
        if (!otherVisible || r.width > winW * 0.55) {
          maximizedView = k;
          break;
        }
      }
    }

    // Ground level resolution: Priority: 1. guide reference ground -> 2. session custom ground -> 3. scene auto-estimate -> 4. box bottom
    const bottomZ = box.center[2] - box.dims[2] / 2;
    const detectedGround = (C.estimateRoadGround && !guide) ? C.estimateRoadGround(context, box) : null;
    if(Number.isFinite(guide?.reference?.ground_z)) {
      activeGroundZ = guide.reference.ground_z;
    } else if(sessionGroundZ !== null) {
      activeGroundZ = sessionGroundZ;
    } else if(detectedGround !== null) {
      activeGroundZ = Number(detectedGround.toFixed(2));
      sessionGroundZ = activeGroundZ;
    } else {
      activeGroundZ = Number(bottomZ.toFixed(2));
    }

    // Ground slope resolution: Pitch (longitudinal incline) and Roll (lateral camber)
    let activePitch = 0, activeRoll = 0;
    const isVehicleTilted = Math.abs(box.rotation[1]) > 0.015 || Math.abs(box.rotation[0]) > 0.015;
    const useVehicleSlope = sessionSlopeMode === 'vehicle' || (sessionSlopeMode === null && isVehicleTilted);

    if(Number.isFinite(guide?.reference?.pitch_deg)) {
      activePitch = (guide.reference.pitch_deg * Math.PI) / 180;
      activeRoll = ((guide.reference.roll_deg || 0) * Math.PI) / 180;
    } else if(useVehicleSlope) {
      activePitch = box.rotation[1] || 0;
      activeRoll = box.rotation[0] || 0;
    } else {
      activePitch = 0;
      activeRoll = 0;
    }
    if(sessionPitchOffset) {
      activePitch += sessionPitchOffset;
    }
    if(sessionRollOffset) {
      activeRoll += sessionRollOffset;
    }

    const key=JSON.stringify([box,baseline,guide?.rule,guide?.identity,guide?.reference,guide?.points?.length,guide?.face,
      options,evaluation,dragging,activeGroundZ,activePitch,activeRoll,maximizedView,...Object.entries(context.views).map(([k,v])=>[...v.camera.projectionMatrix.elements,...v.camera.matrixWorldInverse.elements,
        rectangles[k]?.left,rectangles[k]?.top,rectangles[k]?.width,rectangles[k]?.height])]);
    if(key===lastKey) return; lastKey=key;

    // Separation of modes: Audit Mode (finding from scan) vs Free Labeling Mode
    const isAudit = !!guide;
    const measured = guide?.evidence==='measured' || guide?.evidence==='spec';
    // ONLY show target wireframe when there is an active guide from error scan!
    const ref = (isAudit && options.reference) ? G.reference(guide) : null;
    const aligned = (ref && G.isAligned) ? G.isAligned(box, ref) : false;
    const m = G.metrics(box, baseline, guide, activeGroundZ, activePitch, activeRoll), cs = G.corners(box);

    const deltaZ = Number.isFinite(m?.groundGap) ? m.groundGap : (bottomZ - activeGroundZ);
    const deltaCm = deltaZ * 100;

    // Sample LiDAR points for inclusion check
    let ptsList = (measured && guide?.points?.length) ? guide.points : null;
    if(!ptsList && options.points && C.sampleNearbyPoints && !dragging) {
      ptsList = C.sampleNearbyPoints(context, box, Math.max(box.dims[0], box.dims[1]) + 2, 400);
    }

    // Render SVG overlays for each view
    for(const [view,v] of Object.entries(context.views)) {
      const canvas=v.renderer.domElement, {svg}=mount(view,canvas);
      const rect=rectangles[view] || canvas.getBoundingClientRect();

      // Rule 1: Check if view canvas is collapsed or hidden in DOM
      const isCollapsed = !canvas.offsetParent || canvas.offsetWidth <= 25 || canvas.offsetHeight <= 25 || rect.width <= 25 || rect.height <= 25;
      if (isCollapsed) {
        svg.style.display = 'none';
        svg.innerHTML = '';
        continue;
      }

      // Rule 2: CRITICAL - When an orthographic view is maximized, HIDE ALL OTHER VIEWS (including Perspective 3D)!
      // This eliminates all overlapping wireframes and text clutter!
      if (maximizedView && view !== maximizedView) {
        svg.style.display = 'none';
        svg.innerHTML = '';
        continue;
      }

      svg.dataset.rule=guide?.rule || '';
      svg.dataset.frame=String(context.frame);
      svg.style.left=`${rect.left}px`;
      svg.style.top=`${rect.top}px`;
      svg.style.width=`${rect.width}px`;
      svg.style.height=`${rect.height}px`;
      svg.style.display='block';
      svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`);

      const p=q=>G.project(q,v.camera,rect), draw=[];
      const line=(a,b,color='#0b63ce',dash='',width=1.4)=>{
        const x=p(a),y=p(b);if(!x||!y)return;
        draw.push(`<path d="M${x.join(',')}L${y.join(',')}" stroke="${color}" stroke-width="${width}" fill="none"${dash?` stroke-dasharray="${dash}"`:''}/>`);
      };
      const text=(q,t,color='#0f2a47')=>{
        const x=p(q);if(!x)return;
        const tx = Math.max(12, Math.min(rect.width - 150, x[0]+5));
        const ty = Math.max(18, Math.min(rect.height - 12, x[1]-7));
        draw.push(`<text x="${tx}" y="${ty}" fill="${color}" stroke="#ffffff" stroke-width="3" paint-order="stroke" font-weight="600">${safe(t)}</text>`);
      };
      const mesh=(b,color,dash,width=1.4)=>{const c=G.corners(b);for(const [a,d] of G.edges)line(c[a],c[d],color,dash,width);};

      // Only draw reference wireframe if an actual error finding exists
      if(isAudit) {
        if(guide?.missing && options.reference && guide.baseline) mesh(guide.baseline,'#e9b56b','6 4',1.8);
        if(ref) {
          const refColor=aligned?'#10b981':'#00e5ff';
          const refDash=aligned?'':'6 3';
          mesh(ref,refColor,refDash,aligned?2.4:2.0);
          const topCenter=[ref.center[0],ref.center[1],ref.center[2]+ref.dims[2]/2+0.12];
          text(topCenter,aligned?'✓ Đã khớp chuẩn (Green Lock)':'🎯 Khung sửa lỗi',refColor);
        }
        const faceNames={'đầu':'front','trước':'front','đuôi':'back','sau':'back','trái':'left','phải':'right'};
        const face=G.faces[faceNames[guide?.face] || guide?.face];
        const highlight=indices=>{const qs=indices.map(i=>p(cs[i]));if(qs.every(Boolean))draw.push(`<polygon points="${qs.map(q=>q.join(',')).join(' ')}" fill="#f87171" fill-opacity=".18" stroke="#ef4444" stroke-width="1.8"/>`);};
        if(measured && m.gaps && guide?.rule==='fit.outside') {
          m.gaps.forEach((pair,i)=>pair.forEach((gap,j)=>{if(gap<-.05)highlight(G.faces[[['front','back'],['left','right'],['top','bottom']][i][j]]);}));
        } else if(measured && m.gaps && guide?.rule==='fit.loose') {
          m.gaps.forEach((pair,i)=>pair.forEach((gap,j)=>{if(gap>(guide.thresholds?.clearance_m || .4))highlight(G.faces[[['front','back'],['left','right'],['top','bottom']][i][j]]);}));
        } else if(measured && face) highlight(face);
      }

      // Rulers and Tilted Road Reference Plane Guideline
      // Vẫn giữ nguyên khi chưa phóng to; khi phóng to view nào thì CHỈ view đó hiển thị
      if(options.rulers) {
        // Measurement markers on box
        [[1,0,0],[0,1,0],[0,0,1]].forEach((axis,i)=>{
          const a=axis.map((n,j)=>n?-box.dims[j]/2:-box.dims[j]/2), b=[...a];b[i]=box.dims[i]/2;
          const wa=G.world(box,a),wb=G.world(box,b),qa=p(wa),qb=p(wb);
          if(qa&&qb&&Math.hypot(qa[0]-qb[0],qa[1]-qb[1])>25){
            line(wa,wb,['#0b63ce','#0284c7','#334155'][i],'',1.8);
            text(wa.map((x,j)=>(x+wb[j])/2),`${['D','R','C'][i]} ${box.dims[i].toFixed(2)}m`,['#0b63ce','#0284c7','#334155'][i]);
          }
        });

        // Road Ground Guideline: Passes through the base with 3D slope (pitch & roll)
        const yaw=box.rotation[2];
        const groundPt=(ax,ay)=>[
          box.center[0]+ax*Math.cos(yaw)-ay*Math.sin(yaw),
          box.center[1]+ax*Math.sin(yaw)+ay*Math.cos(yaw),
          activeGroundZ+ax*Math.tan(activePitch)+ay*Math.tan(activeRoll)
        ];

        const centerBottom=[box.center[0],box.center[1],bottomZ];
        const centerGround=[box.center[0],box.center[1],activeGroundZ];
        const isNearGround = Math.abs(deltaCm) <= 5;
        const vColor = isNearGround ? '#157a4a' : deltaCm > 5 ? '#d97706' : '#dc2626';

        const pitchDeg = activePitch * 180 / Math.PI;
        const rollDeg = activeRoll * 180 / Math.PI;
        const slopeTxt = Math.abs(pitchDeg) >= 0.1 ? ` · Dốc ${pitchDeg > 0 ? '+' : ''}${pitchDeg.toFixed(1)}°` : '';
        const camberTxt = Math.abs(rollDeg) >= 0.1 ? ` · Nghiêng ${rollDeg > 0 ? '+' : ''}${rollDeg.toFixed(1)}°` : '';

        if(view==='side') {
          // Extended long green dashed line across both sides (35m)
          const spanX=Math.max(box.dims[0]*4, 35);
          line(groundPt(-spanX,0),groundPt(spanX,0),'#157a4a','8 4',2.2);
          text(groundPt(box.dims[0]/2+1.5,0),`━━ Mặt đường (${activeGroundZ.toFixed(2)}m${slopeTxt}) ━━`,'#157a4a');
          line(centerBottom,centerGround,vColor,isNearGround?'':'3 2',2.0);
          text(centerBottom,isNearGround?'✓ Sát đất (0 cm)':(deltaCm>0?`+${deltaCm.toFixed(1)} cm`:`${deltaCm.toFixed(1)} cm`),vColor);
        } else if(view==='front') {
          // Extended long green dashed line across both sides (25m)
          const spanY=Math.max(box.dims[1]*6, 25);
          line(groundPt(0,-spanY),groundPt(0,spanY),'#157a4a','8 4',2.2);
          text(groundPt(0,box.dims[1]/2+1.2),`━━ Mặt đường (${activeGroundZ.toFixed(2)}m${camberTxt}) ━━`,'#157a4a');
          line(centerBottom,centerGround,vColor,isNearGround?'':'3 2',2.0);
          text(centerBottom,isNearGround?'✓ Sát đất (0 cm)':(deltaCm>0?`+${deltaCm.toFixed(1)} cm`:`${deltaCm.toFixed(1)} cm`),vColor);
        } else if(view==='perspective') {
          const hL=Math.max(box.dims[0]+6, 15), hW=Math.max(box.dims[1]+4, 8);
          const g0=groundPt(-hL,-hW), g1=groundPt(hL,-hW), g2=groundPt(hL,hW), g3=groundPt(-hL,hW);
          line(g0,g1,'#157a4a','6 4',1.6);
          line(g1,g2,'#157a4a','6 4',1.6);
          line(g2,g3,'#157a4a','6 4',1.6);
          line(g3,g0,'#157a4a','6 4',1.6);
          line(centerBottom,centerGround,vColor,isNearGround?'':'3 2',1.8);
          text(centerBottom,isNearGround?'✓ Sát đất':(deltaCm>0?`+${deltaCm.toFixed(0)}cm`:`${deltaCm.toFixed(0)}cm`),vColor);
        }
      }

      // Point Inclusion (LiDAR points inside vs outside)
      if(options.points && ptsList?.length && !dragging) {
        const paths=['',''];
        let outCount=0, inCount=0;
        const stride=Math.max(1,Math.ceil(ptsList.length/350));
        for(let i=0;i<ptsList.length;i+=stride){
          const q=ptsList[i], s=p(q);
          if(!s) continue;
          const loc=G.local(box,q);
          const isOut=Math.abs(loc[0])>box.dims[0]/2+0.04 || Math.abs(loc[1])>box.dims[1]/2+0.04 || Math.abs(loc[2])>box.dims[2]/2+0.04;
          if(isOut){outCount++;paths[1]+=`M${s[0].toFixed(1)},${s[1].toFixed(1)}h.1`;}
          else{inCount++;paths[0]+=`M${s[0].toFixed(1)},${s[1].toFixed(1)}h.1`;}
        }
        if(paths[0]) draw.push(`<path d="${paths[0]}" stroke="#06b6d4" stroke-width="3" stroke-linecap="round" fill="none"/>`);
        if(paths[1]) draw.push(`<path d="${paths[1]}" stroke="#ef4444" stroke-width="3.6" stroke-linecap="round" fill="none"/>`);
        lastEvaluatedPoints={inside:inCount,outside:outCount,hasData:true};
      }

      svg.innerHTML=draw.join('');
    }

    // Status Resolution for Extension Panel Telemetry
    const isNearGround = Math.abs(deltaCm) <= 5;
    const gStatus = isNearGround ? 'Sát mặt đường' : deltaCm > 5 ? 'Lơ lửng' : 'Lún đất';
    const gColor = isNearGround ? '#157a4a' : deltaCm > 5 ? '#a35200' : '#991b1b';
    const gBg = isNearGround ? '#ebf8f1' : deltaCm > 5 ? '#fff3e3' : '#fef2f2';
    const gBorder = isNearGround ? '#b7e8ce' : deltaCm > 5 ? '#e9b56b' : '#fca5a5';

    // Broadcast live telemetry to Extension Panel (no floating canvas HUD!)
    if(typeof window!=='undefined' && window.postMessage) {
      window.postMessage({
        type: 'POINTSNAP_MANUAL_TELEMETRY',
        detail: {
          box,
          bottomZ,
          activeGroundZ,
          deltaCm,
          activePitch,
          activeRoll,
          pitchDeg: activePitch * 180 / Math.PI,
          rollDeg: activeRoll * 180 / Math.PI,
          isNearGround,
          gStatus,
          gColor,
          gBg,
          gBorder,
          lastEvaluatedPoints,
          useVehicleSlope,
          isAudit,
          guideRule: guide?.rule
        }
      }, location.origin);
    }

    latency.push(performance.now()-(sampledAt || started));if(latency.length>1000)latency.shift();
    if(dragging && Number.isFinite(inputAt) && inputAt!==lastInputAt){inputLatency.push(performance.now()-inputAt);lastInputAt=inputAt;if(inputLatency.length>1000)inputLatency.shift();}
  }

  function performanceStats(){const p95=a=>{const s=[...a].sort((a,b)=>a-b);return s.length?s[Math.min(s.length-1,Math.floor(s.length*.95))]:null;};return {samples:latency.length,render_p95_ms:p95(latency),input_samples:inputLatency.length,input_to_overlay_p95_ms:p95(inputLatency)};}
  root.PointSnapManualOverlay={render,clear,performanceStats};
})(globalThis);

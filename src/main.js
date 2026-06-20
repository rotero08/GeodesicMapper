import * as d3geo from 'd3-geo';
import * as d3geoproj from 'd3-geo-projection';
import * as topojson from 'topojson-client';
import WORLD from './world-110m.json';
import './style.css';

// merge d3 geo modules into one namespace so the app code reads as `d3.geoX`
const d3 = { ...d3geo, ...d3geoproj };


"use strict";
(function(){
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const RAD=Math.PI/180, DEG=180/Math.PI;

  const ICON_PLAY='<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M4.5 3.2v9.6a.6.6 0 0 0 .92.5l7.2-4.8a.6.6 0 0 0 0-1L5.42 2.7a.6.6 0 0 0-.92.5Z"/></svg>';
  const ICON_PAUSE='<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>';
  function setPlay(on){ const b=$("#play"); b.classList.toggle("on",on);
    b.innerHTML=(on?ICON_PAUSE:ICON_PLAY)+"<span>"+(on?"Pause":"Play morph")+"</span>"; }

  if(typeof d3==="undefined"||typeof topojson==="undefined"){
    const e=$("#err"); e.style.display="flex";
    e.innerHTML="Couldn't load the mapping libraries (d3 / topojson) from the CDN.<br>Check the network connection and reload.";
    return;
  }

  // ---- geodata ----
  const countries = topojson.feature(WORLD, WORLD.objects.countries);
  const sphere = {type:"Sphere"};
  const graticule = d3.geoGraticule().step([20,20])();

  // ---- projection registry ----
  const PROJS = [
    {id:"orthographic", name:"Globe",                 gen:d3.geoOrthographic,        raw:d3.geoOrthographicRaw,        flat:0.0,  clip:90,  note:"3-D globe"},
    {id:"stereographic",name:"Stereographic",         gen:d3.geoStereographic,       raw:d3.geoStereographicRaw,       flat:0.35, clip:142},
    {id:"gnomonic",     name:"Gnomonic",              gen:d3.geoGnomonic,            raw:d3.geoGnomonicRaw,            flat:0.45, clip:60,  note:"great circles → straight"},
    {id:"azea",         name:"Azim. equal-area",      gen:d3.geoAzimuthalEqualArea,  raw:d3.geoAzimuthalEqualAreaRaw,  flat:0.3},
    {id:"azeq",         name:"Azim. equidistant",     gen:d3.geoAzimuthalEquidistant,raw:d3.geoAzimuthalEquidistantRaw,flat:0.3},
    {id:"equirect",     name:"Equirectangular",       gen:d3.geoEquirectangular,     raw:d3.geoEquirectangularRaw,     flat:1.0},
    {id:"mercator",     name:"Mercator",              gen:d3.geoMercator,            raw:d3.geoMercatorRaw,            flat:1.0,  fitLat:80, cover:1.5, note:"rhumb → straight"},
    {id:"naturalearth", name:"Natural Earth",         gen:d3.geoNaturalEarth1,       raw:d3.geoNaturalEarth1Raw,       flat:1.0},
    {id:"equalearth",   name:"Equal Earth",           gen:d3.geoEqualEarth,          raw:d3.geoEqualEarthRaw,          flat:1.0},
    {id:"robinson",     name:"Robinson",              gen:d3.geoRobinson,            raw:d3.geoRobinsonRaw,            flat:1.0},
    {id:"winkel",       name:"Winkel Tripel",         gen:d3.geoWinkel3,             raw:d3.geoWinkel3Raw,             flat:1.0},
    {id:"mollweide",    name:"Mollweide",             gen:d3.geoMollweide,           raw:d3.geoMollweideRaw,           flat:1.0},
    {id:"eckert4",      name:"Eckert IV",             gen:d3.geoEckert4,             raw:d3.geoEckert4Raw,             flat:1.0},
    {id:"sinusoidal",   name:"Sinusoidal",            gen:d3.geoSinusoidal,          raw:d3.geoSinusoidalRaw,          flat:1.0},
    {id:"aitoff",       name:"Aitoff",                gen:d3.geoAitoff,              raw:d3.geoAitoffRaw,              flat:1.0},
  ].filter(p=>typeof p.gen==="function" && typeof p.raw==="function");
  const byId = Object.fromEntries(PROJS.map(p=>[p.id,p]));

  // ---- state ----
  const state = {
    from:"orthographic", to:"mercator", t:0, flat:"mercator",
    rot:[ -12, -16, 0 ], zoom:1,
    tool:"rotate", unit:"km",
    layers:{countries:true, graticule:true, rhumb:true, tissot:false, terminator:false, stars:true, spin:false},
    paths:[],          // [{verts:[[lon,lat],...]}]
    cursorGeo:null, hoverGeo:null,
  };

  // ---- canvas / dpr ----
  const canvas=$("#map"), ctx=canvas.getContext("2d");
  let W=0,H=0,DPR=1, stars=[];
  function resize(){
    const r=$("#stage").getBoundingClientRect();
    W=Math.max(20,r.width); H=Math.max(20,r.height);
    DPR=Math.min(2, window.devicePixelRatio||1);
    canvas.width=W*DPR; canvas.height=H*DPR;
    canvas.style.width=W+"px"; canvas.style.height=H+"px";
    ctx.setTransform(DPR,0,0,DPR,0,0);
    computeFits(); seedStars(); requestRender();
  }
  function seedStars(){
    stars=[]; const n=Math.round(W*H/5200);
    for(let i=0;i<n;i++) stars.push({x:Math.random()*W,y:Math.random()*H,
      r:Math.random()*1.1+0.2, a:Math.random()*0.5+0.15, p:Math.random()*Math.PI*2});
  }

  // fit target: a latitude-bounded outline for projections whose poles are wasteful
  // (Mercator), otherwise the whole sphere.
  function fitObject(P){
    const L=P.fitLat||90; if(L>=90) return sphere;
    const ring=[]; const N=64;
    for(let i=0;i<=N;i++) ring.push([-180+360*i/N, L]);
    for(let i=0;i<=N;i++) ring.push([180-360*i/N, -L]);
    ring.push([-180,L]);
    return {type:"Polygon", coordinates:[ring]};
  }

  // ---- fit cache (scale + translate per projection, at rotate 0) ----
  let fitCache={};
  function computeFits(){
    fitCache={};
    const pad=Math.min(W,H)*0.05, availH=H-2*pad;
    for(const p of PROJS){
      try{
        const g=p.gen().rotate([0,0,0]);
        if(p.clip) g.clipAngle(p.clip);
        const obj=fitObject(p);
        g.fitExtent([[pad,pad],[W-pad,H-pad]], obj);   // contain
        if(p.cover){                                    // fill vertical gap, capped
          const b=d3.geoPath(g).bounds(obj), bh=b[1][1]-b[0][1];
          const k=Math.max(1, Math.min(p.cover, availH/bh));
          g.scale(g.scale()*k).translate([W/2,H/2]);
        }
        fitCache[p.id]={scale:g.scale(), translate:g.translate()};
      }catch(e){ fitCache[p.id]={scale:Math.min(W,H)*0.42, translate:[W/2,H/2]}; }
    }
  }
  const lerp=(a,b,t)=>a+(b-a)*t;

  function currentFlat(){ return lerp(byId[state.from].flat, byId[state.to].flat, state.t); }

  // a REAL d3 projection (correct clipping, invertible) for a given endpoint,
  // framed by the current (lerped) scale/translate/rotation.
  function realProjection(P){
    const fa=fitCache[state.from], fb=fitCache[state.to], t=state.t;
    const scale=lerp(fa.scale, fb.scale, t)*state.zoom;
    const tr=[lerp(fa.translate[0],fb.translate[0],t), lerp(fa.translate[1],fb.translate[1],t)];
    const flat=currentFlat();
    const proj=P.gen().scale(scale).translate(tr)
                 .rotate([state.rot[0], state.rot[1]*(1-flat), state.rot[2]]);
    if(P.clip) proj.clipAngle(P.clip);
    // crop banded projections (Mercator) to their latitude band so the empty/blown-up
    // poles are cut instead of shown.
    let ext=[[0,0],[W,H]];
    if(P.fitLat){
      const a=proj([0,P.fitLat]), b=proj([0,-P.fitLat]);
      if(a&&b){ ext=[[0, Math.max(0,Math.min(a[1],b[1]))],[W, Math.min(H,Math.max(a[1],b[1]))]]; }
    }
    proj.clipExtent(ext);
    return proj;
  }

  // build the projection for the current frame.
  // at a settled end (t≈0 or t≈1) use the real generator so the poles, sphere and
  // graticule clip correctly (no spikes). only morph strictly in between.
  function buildProjection(){
    const t=state.t;
    if(t<1e-4) return realProjection(byId[state.from]);
    if(t>1-1e-4) return realProjection(byId[state.to]);

    const A=byId[state.from], B=byId[state.to];
    const fa=fitCache[A.id], fb=fitCache[B.id];
    const scale=lerp(fa.scale, fb.scale, t)*state.zoom;
    const tr=[lerp(fa.translate[0],fb.translate[0],t), lerp(fa.translate[1],fb.translate[1],t)];
    const flat=currentFlat();
    const rot=[state.rot[0], state.rot[1]*(1-flat), state.rot[2]];

    // clamp any diverging output (Mercator/Gnomonic poles → ±∞) to a large finite
    // value so it lands off-screen and clips cleanly, instead of spiking to centre.
    const LIM=1e4;
    const C=v=> v!==v ? LIM : (v>LIM?LIM : v<-LIM?-LIM : v); // NaN→LIM, else clamp
    const mutate=d3.geoProjectionMutator(tt=>(x,y)=>{
      const a=A.raw(x,y), b=B.raw(x,y);
      const ax=C(a[0]),ay=C(a[1]),bx=C(b[0]),by=C(b[1]);
      return [ax+(bx-ax)*tt, ay+(by-ay)*tt];
    });
    const proj=mutate(t).scale(scale).translate(tr).rotate(rot);
    proj.clipExtent([[-2,-2],[W+2,H+2]]);
    return proj;
  }

  // an invertible projection matching the current frame, for cursor/click picking.
  function pickProjection(){
    const t=state.t;
    return realProjection(t>=0.5 ? byId[state.to] : byId[state.from]);
  }

  // ---- geodesy ----
  const Rkm=6371.0088, Rmi=3958.7613;
  const R=()=>state.unit==="km"?Rkm:Rmi;
  const U=()=>state.unit==="km"?"km":"mi";
  function fmtDist(d){ return d>=100? d.toLocaleString(undefined,{maximumFractionDigits:0})
                       : d.toLocaleString(undefined,{maximumFractionDigits:1}); }
  function gcDist(a,b){ return d3.geoDistance(a,b)*R(); }
  function bearing(a,b){
    const p1=a[1]*RAD,p2=b[1]*RAD,dl=(b[0]-a[0])*RAD;
    const y=Math.sin(dl)*Math.cos(p2);
    const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    return ((Math.atan2(y,x)*DEG)%360+360)%360;
  }
  function rhumbDist(a,b){
    const p1=a[1]*RAD,p2=b[1]*RAD,dp=p2-p1; let dl=Math.abs(b[0]-a[0])*RAD;
    if(dl>Math.PI) dl=2*Math.PI-dl;
    const dps=Math.log(Math.tan(Math.PI/4+p2/2)/Math.tan(Math.PI/4+p1/2));
    const q=Math.abs(dps)>1e-11?dp/dps:Math.cos(p1);
    return Math.sqrt(dp*dp+q*q*dl*dl)*R();
  }
  function geodesicPts(a,b,n){ n=n||80; const f=d3.geoInterpolate(a,b),o=[];
    for(let i=0;i<=n;i++)o.push(f(i/n)); return o; }
  function rhumbPts(a,b,n){
    n=n||80; const cl=v=>Math.max(-89.9,Math.min(89.9,v));
    const psi=lat=>Math.log(Math.tan(Math.PI/4+cl(lat)*RAD/2));
    const inv=y=>(2*Math.atan(Math.exp(y))-Math.PI/2)*DEG;
    let l0=a[0],l1=b[0],dl=l1-l0; if(Math.abs(dl)>180) dl-=Math.sign(dl)*360;
    const y0=psi(a[1]),y1=psi(b[1]),o=[];
    for(let i=0;i<=n;i++){const k=i/n; let lon=l0+dl*k; lon=((lon+540)%360)-180;
      o.push([lon, inv(y0+(y1-y0)*k)]); }
    return o;
  }
  function lineString(coords){ return {type:"LineString",coordinates:coords}; }
  function polyGeodesic(verts){ const c=[]; for(let i=0;i<verts.length-1;i++){
      const seg=geodesicPts(verts[i],verts[i+1]); c.push(...(i?seg.slice(1):seg)); } return c; }
  function polyRhumb(verts){ const c=[]; for(let i=0;i<verts.length-1;i++){
      const seg=rhumbPts(verts[i],verts[i+1]); c.push(...(i?seg.slice(1):seg)); } return c; }

  // ---- render ----
  function render(){
    const proj=buildProjection();
    const path=d3.geoPath(proj,ctx);
    const flat=currentFlat();
    ctx.clearRect(0,0,W,H);

    // starfield (fades as the world flattens)
    if(state.layers.stars && flat<0.999){
      const tw=performance.now()/1000;
      for(const s of stars){
        const a=s.a*(1-flat)*(0.6+0.4*Math.sin(tw*1.1+s.p));
        ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,7); ctx.fillStyle=`rgba(210,228,238,${a})`; ctx.fill();
      }
    }
    // atmosphere glow on the globe end
    if(flat<0.999){
      const fa=fitCache[state.from],fb=fitCache[state.to];
      const cx=lerp(fa.translate[0],fb.translate[0],state.t);
      const cy=lerp(fa.translate[1],fb.translate[1],state.t);
      const rad=lerp(fa.scale,fb.scale,state.t)*state.zoom;
      const g=ctx.createRadialGradient(cx,cy,rad*0.86,cx,cy,rad*1.22);
      g.addColorStop(0,`rgba(59,182,204,0)`);
      g.addColorStop(0.55,`rgba(59,150,204,${0.16*(1-flat)})`);
      g.addColorStop(1,`rgba(20,60,90,0)`);
      ctx.beginPath(); ctx.arc(cx,cy,rad*1.22,0,7); ctx.fillStyle=g; ctx.fill();
    }

    // ocean sphere
    ctx.beginPath(); path(sphere);
    if(flat<0.6){
      const fa=fitCache[state.from],fb=fitCache[state.to];
      const cx=lerp(fa.translate[0],fb.translate[0],state.t);
      const cy=lerp(fa.translate[1],fb.translate[1],state.t);
      const rad=lerp(fa.scale,fb.scale,state.t)*state.zoom;
      const g=ctx.createRadialGradient(cx-rad*0.3,cy-rad*0.34,rad*0.1,cx,cy,rad*1.05);
      g.addColorStop(0,"#10334a"); g.addColorStop(1,"#081722"); ctx.fillStyle=g;
    } else ctx.fillStyle="#0c2536";
    ctx.fill();

    // graticule
    if(state.layers.graticule){
      ctx.beginPath(); path(graticule);
      ctx.strokeStyle="rgba(59,150,180,.28)"; ctx.lineWidth=0.6; ctx.stroke();
    }
    // land
    if(state.layers.countries){
      ctx.beginPath(); path(countries);
      ctx.fillStyle="#c2cdc8"; ctx.fill();
      ctx.lineWidth=0.45; ctx.strokeStyle="rgba(60,80,72,.6)"; ctx.stroke();
    }
    // tissot
    if(state.layers.tissot){
      ctx.lineWidth=1; ctx.strokeStyle="rgba(231,171,64,.7)"; ctx.fillStyle="rgba(231,171,64,.13)";
      for(let lat=-60;lat<=60;lat+=30) for(let lon=-150;lon<=180;lon+=30){
        const c=d3.geoCircle().center([lon,lat]).radius(5).precision(2)();
        ctx.beginPath(); path(c); ctx.fill(); ctx.stroke();
      }
    }
    // day / night
    if(state.layers.terminator){
      const sun=subsolar(new Date());
      const night=d3.geoCircle().center([sun[0]+180,-sun[1]]).radius(90).precision(3)();
      ctx.beginPath(); path(night); ctx.fillStyle="rgba(5,12,22,.46)"; ctx.fill();
      const sp=proj(sun);
      if(sp){ ctx.beginPath(); ctx.arc(sp[0],sp[1],4,0,7); ctx.fillStyle="#ffd97a"; ctx.fill(); }
    }
    // sphere outline
    ctx.beginPath(); path(sphere);
    ctx.strokeStyle="rgba(140,180,200,.5)"; ctx.lineWidth=1.1; ctx.stroke();

    // drawn paths
    for(const p of state.paths) drawPath(p,proj,path,false);
    if(drawingActive && state.paths.length){
      drawPath(state.paths[state.paths.length-1],proj,path,true);
    }
    // rubber band while measuring
    if(state.tool==="draw" && drawingActive && state.paths.length && state.hoverGeo){
      const last=state.paths[state.paths.length-1].verts.slice(-1)[0];
      if(last){
        ctx.beginPath(); path(lineString(geodesicPts(last,state.hoverGeo)));
        ctx.setLineDash([2,4]); ctx.strokeStyle="rgba(248,209,129,.7)"; ctx.lineWidth=1.4; ctx.stroke();
        ctx.setLineDash([]);
        const mid=proj(d3.geoInterpolate(last,state.hoverGeo)(0.5));
        if(mid) pill(mid[0], mid[1]-9, fmtDist(gcDist(last,state.hoverGeo))+" "+U(), "#f3c570");
      }
    }
  }

  function drawPath(p,proj,path,active){
    const v=p.verts; if(v.length<1) return;
    if(v.length>=2){
      // great circle
      ctx.beginPath(); path(lineString(polyGeodesic(v)));
      ctx.strokeStyle="#e7ab40"; ctx.lineWidth=2.1; ctx.lineJoin="round"; ctx.stroke();
      // rhumb overlay
      if(state.layers.rhumb){
        ctx.beginPath(); path(lineString(polyRhumb(v)));
        ctx.setLineDash([5,5]); ctx.strokeStyle="#e56a3c"; ctx.lineWidth=1.6; ctx.stroke();
        ctx.setLineDash([]);
      }
      // per-segment distance labels, drawn on the line
      for(let i=0;i<v.length-1;i++){
        const sg=geodesicPts(v[i],v[i+1],40), mg=proj(sg[sg.length>>1]);
        if(mg) pill(mg[0], mg[1]-(state.layers.rhumb?9:0), fmtDist(gcDist(v[i],v[i+1]))+" "+U(), "#f3c570");
        if(state.layers.rhumb){
          const sr=rhumbPts(v[i],v[i+1],40), mr=proj(sr[sr.length>>1]);
          if(mr) pill(mr[0], mr[1]+9, fmtDist(rhumbDist(v[i],v[i+1]))+" "+U(), "#ec8a64");
        }
      }
    }
    // vertices
    for(const pt of v){ const s=proj(pt); if(!s) continue;
      ctx.beginPath(); ctx.arc(s[0],s[1],4.2,0,7); ctx.fillStyle="#0a141d"; ctx.fill();
      ctx.lineWidth=2; ctx.strokeStyle="#f8d181"; ctx.stroke();
    }
  }

  // small rounded label drawn directly on the map
  function pill(x,y,text,col){
    ctx.font="600 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
    const w=ctx.measureText(text).width, padX=6, h=16, rw=w+padX*2;
    const rx=x-rw/2, ry=y-h/2;
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(rx,ry,rw,h,5); else ctx.rect(rx,ry,rw,h);
    ctx.fillStyle="rgba(7,16,24,.88)"; ctx.fill();
    ctx.lineWidth=1; ctx.strokeStyle=col; ctx.stroke();
    ctx.fillStyle=col; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText(text,x,y+0.5);
    ctx.textAlign="start"; ctx.textBaseline="alphabetic";
  }

  function subsolar(date){
    const d=(date - Date.UTC(date.getUTCFullYear(),0,0))/864e5;
    const decl=-23.44*Math.cos(RAD*(360/365)*(d+10));
    const utc=date.getUTCHours()+date.getUTCMinutes()/60+date.getUTCSeconds()/3600;
    const lon=-15*(utc-12);
    return [lon, decl];
  }

  // ---- measurement readout ----
  function updateMeasure(){
    const box=$("#measure");
    if(state.tool!=="draw" || !state.paths.length){ box.style.display="none"; return; }
    const v=state.paths[state.paths.length-1].verts;
    box.style.display="";
    let gc=0,rh=0; for(let i=0;i<v.length-1;i++){ gc+=gcDist(v[i],v[i+1]); rh+=rhumbDist(v[i],v[i+1]); }
    $("#m-gc").textContent = v.length>=2? fmtDist(gc)+" "+U() : "—";
    $("#m-rh").textContent = (v.length>=2 && state.layers.rhumb)? fmtDist(rh)+" "+U() : "—";
    $("#m-br").textContent = v.length>=2? bearing(v[0],v[1]).toFixed(1)+"°" : "—";
    $("#m-pts").textContent = v.length;
  }

  // ---- render loop ----
  let dirty=true;
  function requestRender(){ dirty=true; }
  function loop(){
    if(state.layers.spin && !dragging && !playing){
      state.rot[0]=(state.rot[0]+0.12)%360; dirty=true;
    }
    if(state.layers.stars && currentFlat()<0.999 && !dirty) dirty=true; // twinkle
    if(dirty){ render(); updateMeasure(); dirty=false; }
    requestAnimationFrame(loop);
  }

  // ---- interaction ----
  // left button:  tool action (rotate-drag in Rotate, place point in Measure/Marker, delete in Cut)
  // middle button: always drag-to-spin, in any tool
  // right button:  undo the last measure point (cancel)
  let dragging=false, drawingActive=false, downPt=null, moved=0, dragBtn=0;
  canvas.addEventListener("contextmenu", e=>e.preventDefault());
  canvas.addEventListener("pointerdown", e=>{
    canvas.setPointerCapture(e.pointerId);
    downPt=[e.offsetX,e.offsetY]; moved=0; dragBtn=e.button;
    const spin = e.button===1 || (e.button===0 && state.tool==="rotate");
    if(e.button!==0) e.preventDefault();
    if(spin){ dragging=true; canvas.classList.add("dragging"); }
  });
  canvas.addEventListener("pointermove", e=>{
    const m=[e.offsetX,e.offsetY];
    // live cursor coords
    const g=invertSafe(pickProjection(),m);
    state.hoverGeo=g;
    $("#cursor").textContent = g? fmtLon(g[0])+", "+fmtLat(g[1]) : "off-globe";
    if(state.tool==="draw" && state.paths.length) requestRender();

    if(dragging && downPt){
      const dx=m[0]-downPt[0], dy=m[1]-downPt[1];
      moved+=Math.abs(dx)+Math.abs(dy);
      const k=0.32/state.zoom;
      const wrap=v=>((v+540)%360)-180;
      state.rot[0]=wrap(state.rot[0]+dx*k);
      state.rot[1]=wrap(state.rot[1]-dy*k);   // no clamp: spin over the poles freely
      downPt=m; requestRender();
    }
  });
  canvas.addEventListener("pointerup", e=>{
    const m=[e.offsetX,e.offsetY], click = moved<6;
    if(dragBtn===2 && click){               // right-click: undo last measure point
      undoPoint();
    } else if(dragBtn===0 && click){
      if(state.tool==="draw"||state.tool==="marker"){
        const g=invertSafe(pickProjection(),m); if(g) addPoint(g);
      } else if(state.tool==="cut"){
        deletePathAt(m);
      }
    }
    dragging=false; canvas.classList.remove("dragging"); downPt=null;
  });
  canvas.addEventListener("dblclick", ()=>{ if(state.tool==="draw") drawingActive=false; });
  canvas.addEventListener("pointerleave", ()=>{ state.hoverGeo=null; $("#cursor").textContent="— , —"; requestRender(); });
  canvas.addEventListener("wheel", e=>{ e.preventDefault();
    state.zoom=Math.max(0.5,Math.min(8, state.zoom*(e.deltaY<0?1.12:1/1.12))); requestRender();
  },{passive:false});

  function invertSafe(proj,m){
    try{ const g=proj.invert(m); if(!g||!isFinite(g[0])||!isFinite(g[1])) return null;
      // reject points that don't round-trip (outside the map face)
      const f=proj(g); if(!f) return null;
      if(Math.hypot(f[0]-m[0],f[1]-m[1])>2) return null;
      return [((g[0]+540)%360)-180, Math.max(-90,Math.min(90,g[1]))];
    }catch(e){ return null; }
  }
  function addPoint(g){
    if(state.tool==="marker"){ state.paths.push({verts:[g]}); drawingActive=false; }
    else{
      if(!drawingActive){ state.paths.push({verts:[g]}); drawingActive=true; }
      else state.paths[state.paths.length-1].verts.push(g);
    }
    requestRender();
  }
  // right-click: remove the last point of the path being drawn; empty path is dropped
  function undoPoint(){
    if(!state.paths.length) return;
    const p=state.paths[state.paths.length-1];
    p.verts.pop();
    if(p.verts.length===0){ state.paths.pop(); drawingActive=false; }
    updateMeasure(); requestRender();
  }
  // scissors: delete the single path nearest the click (within ~12 px on screen)
  function deletePathAt(m){
    const proj=buildProjection(); let best=-1, bestD=12;
    state.paths.forEach((p,idx)=>{
      const v=p.verts; if(!v.length) return;
      const pts = v.length>=2 ? polyGeodesic(v) : v;
      let prev=null;
      for(const g of pts){
        const s=proj(g); if(!s){ prev=null; continue; }
        const dp=Math.hypot(s[0]-m[0],s[1]-m[1]); if(dp<bestD){ bestD=dp; best=idx; }
        if(prev){ const d=segDist(m,prev,s); if(d<bestD){ bestD=d; best=idx; } }
        prev=s;
      }
    });
    if(best>=0){ state.paths.splice(best,1); drawingActive=false; updateMeasure(); requestRender(); }
  }
  // distance from point p to segment a-b (screen space)
  function segDist(p,a,b){
    const vx=b[0]-a[0], vy=b[1]-a[1], wx=p[0]-a[0], wy=p[1]-a[1];
    const c1=vx*wx+vy*wy; if(c1<=0) return Math.hypot(wx,wy);
    const c2=vx*vx+vy*vy; if(c2<=c1) return Math.hypot(p[0]-b[0],p[1]-b[1]);
    const t=c1/c2; return Math.hypot(p[0]-(a[0]+t*vx), p[1]-(a[1]+t*vy));
  }
  const fmtLat=v=>Math.abs(v).toFixed(2)+"°"+(v>=0?"N":"S");
  const fmtLon=v=>Math.abs(v).toFixed(2)+"°"+(v>=0?"E":"W");

  // ---- transition ----
  // model: Globe (orthographic) at t=0  <->  selected map projection (state.flat) at t=1.
  // the dropdown picks the map; the slider sets how flat. picking a new map while flat
  // does a quick cross-morph between the two maps, then settles.
  let playing=false, animReq=null;
  function rampT(a,b,dur,after){
    cancelAnimationFrame(animReq); const t0=performance.now();
    const ease=x=>x<0.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
    (function step(now){
      const k=Math.min(1,(now-t0)/dur); state.t=a+(b-a)*ease(k); $("#t").value=state.t; requestRender();
      if(k<1) animReq=requestAnimationFrame(step); else if(after) after();
    })(performance.now());
  }
  function updateProjLabel(){
    $("#t-to").textContent = byId[state.flat].name;
    $("#projsel").value = state.flat;
  }
  function selectProjection(id){
    if(id===state.flat) return;
    playing=false; setPlay(false);
    const old=state.flat;
    state.flat=id; updateProjLabel();
    if(state.t>=0.5){
      // cross-morph old map -> new map at full flatten, then settle to globe<->new
      state.from=old; state.to=id; state.t=0;
      rampT(0,1,650, ()=>{ state.from="orthographic"; state.to=id; state.t=1; $("#t").value=1; });
    }else{
      // near the globe: nothing visible changes, just retarget
      state.from="orthographic"; state.to=id; requestRender();
    }
  }

  // ---- map projection dropdown (every projection except the globe itself) ----
  const sel=$("#projsel");
  PROJS.filter(p=>p.id!=="orthographic").forEach(p=>{
    const o=document.createElement("option"); o.value=p.id; o.textContent=p.name;
    if(p.note) o.title=p.note; sel.appendChild(o);
  });
  sel.value=state.flat;
  sel.addEventListener("change", e=>selectProjection(e.target.value));

  // ---- slider: globe <-> selected map ----
  $("#t").addEventListener("input", e=>{ playing=false; setPlay(false); cancelAnimationFrame(animReq);
    state.from="orthographic"; state.to=state.flat; state.t=+e.target.value; requestRender(); });

  $("#play").onclick=function(){
    playing=!playing; setPlay(playing);
    state.from="orthographic"; state.to=state.flat;
    if(playing) pingpong();
  };
  function pingpong(){ if(!playing) return;
    const fwd=state.t<0.5;
    rampT(state.t, fwd?1:0, 1400*Math.abs((fwd?1:0)-state.t)+200, ()=>{ if(playing) pingpong(); });
  }

  $("#reset").onclick=()=>{ state.rot=[-12,-16,0]; state.zoom=1; requestRender(); };
  $("#zin").onclick=()=>{ state.zoom=Math.min(8,state.zoom*1.25); requestRender(); };
  $("#zout").onclick=()=>{ state.zoom=Math.max(0.5,state.zoom/1.25); requestRender(); };

  // ---- tools ----
  $$('[data-tool]').forEach(b=>b.onclick=()=>{
    state.tool=b.dataset.tool; drawingActive=false;
    $$('[data-tool]').forEach(x=>x.classList.toggle("on",x===b));
    canvas.classList.toggle("drawing", state.tool!=="rotate");
    $("#hint").textContent =
        state.tool==="draw"  ? "Left-click to add points · right-click to undo · double-click to finish"
      : state.tool==="marker"? "Left-click to drop markers · middle-drag to spin"
      : state.tool==="cut"   ? "Click a measurement to delete it · middle-drag to spin"
      :                        "Drag to spin · scroll to zoom · middle-drag spins in any tool";
    updateMeasure(); requestRender();
  });
  $("#erase").onclick=()=>{ state.paths=[]; drawingActive=false; updateMeasure(); requestRender(); };

  // ---- layers ----
  $$('#layers .tg').forEach(t=>t.onclick=()=>{
    const k=t.dataset.k; state.layers[k]=!state.layers[k];
    t.classList.toggle("on",state.layers[k]); requestRender();
  });

  // ---- units ----
  $$('[data-unit]').forEach(b=>b.onclick=()=>{
    state.unit=b.dataset.unit; $$('[data-unit]').forEach(x=>x.classList.toggle("on",x===b));
    updateMeasure();
  });

  // ---- keys ----
  window.addEventListener("keydown",e=>{
    if(e.key===" "){ e.preventDefault(); $("#play").click(); }
    else if(e.key.toLowerCase()==="r") $("#reset").click();
  });

  // ---- go ----
  window.addEventListener("resize", resize);
  setPlay(false); updateProjLabel(); resize(); requestRender(); loop();
})();


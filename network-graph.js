(function(){
  if(window.__graphSetup) return; window.__graphSetup=true;

  /* ---- REAL attribution data (snapshot from the registry, nothing invented) ---- */
  const ENTITIES=[
    { id:"forward-industries", name:"Forward Industries", ticker:"FORD", ex:"NASDAQ",
      declared:6900000, source:"community",
      custodians:["Coinbase Prime","Fireblocks"], validators:[], funders:[],
      summary:"The largest public Solana treasury. 25 addresses across Coinbase Prime and Fireblocks custody plus dedicated stake accounts. Community-aggregated and cross-checked, not first-party attribution.",
      wallets:[
        ["FYPQEy1hPa5owwLRPrRDDE6AWZKXusufwaCGe72pLXvj","Coinbase Prime"],["7d4ZhfBRamc2szcuHbVGYbuKFNfjZoKeXm2S3JC2uXeP","Coinbase Prime"],
        ["DrUaDcRmjVhuEoTNExydnVWisu6wwTWoe8f5DVJZJ5Bh","Coinbase Prime"],["96LHAJCo1AaKQKmRXAQ2pWDTRz7v7qWSiSRziEzXPkeR","Coinbase Prime"],
        ["5tsTE13chYaj2AtakSyfxrMFuGRxLowXLbnpkJk6W3Y","Coinbase Prime"],["HTqfGde83HAGquU9JbfX8CkwaR56AELrrdu4X6aHCk2y","Coinbase Prime"],
        ["EuHYgyQwp1M1D155jJRtSnpnw8Rf1mTKVFqAWvk4DBeT","Coinbase Prime"],["4PTib8Hv9T6DmtYVNjFKPSd6hTJXVxQ8VSADvTYvxqF1","Coinbase Prime"],
        ["2RoTFMkfrzryYqkt3feBA5UaxAwvEWkoCzg1NUG8XnFV","Coinbase Prime"],["5wjSnZti7gXdFwMRKSGCx3pTaR111tby33VZ1JYm2c4g","Coinbase Prime"],
        ["B6dtH1n1n7xCAyneSYM8GJTDdzm4ZHwr3Yt79h1xbiak","Coinbase Prime"],["Gft3xmznZdiMeSDz9m6MpBZCs4Gghk6Vj5pm4HgcsuKb","Fireblocks"],
        ["5AYVHr45axSVr3Nw314PFcEY87cUG6iPiBbaiDAu5NYp","Fireblocks"],["3sDXAL3ojojK4znGuZJYL4bdMTXd9c5N4nSULAjgQJ6j","Fireblocks"],
        ["26de9hfRYYCmGrGkYb8z48yDd49UZeXfXei6ms39azzY","Fireblocks"],["9mZyj53THUNMiCSUEzaDSo4oc42XUbbAJzYDwu4YF71U","Stake account"],
        ["6W72bUKNUcrNhTE13x7PbXuaUDUy8pTkKhofA6JaQ7Fp","Stake account"],["5kuumvgSX6GFgEvWsRw1NXJhggAXKp1TRRXVRfrueifD","Stake account"],
        ["2rCQCiAWqh5qZU6eLVfmwyk8K1rZaZ6GEabxPMbS2FbT","Stake account"],["ByDgEPVKudwLBHFYYhzq1khCWKHBNQfZVJD1L7gMQkw7","Stake account"],
        ["HNhYTNCXgaskLRV2Zh6gVmTHSokKj19XcXsEsU2hKMqk","Stake account"],["Eqo5ep3A6A1kng6AybSvG1BExwGp48TbP6HymWupCTe7","Stake account"],
        ["Foa3XmYxiFRsptJKPovTz8v1Mg4ZdgtHneTxRifK6WrN","Stake account"],["GTw9vw39HEVUJTbzJkstghpNyS3XDSXf6rKfX4QpsPVc","Stake account"],
        ["4ZB8dPDb6V8cces72dYKQqiyewontUdXqPbFCJ9qQaUr","Fundraise"]
      ]},
    { id:"solana-company", name:"Solana Company", ticker:"HSDT", ex:"NASDAQ",
      declared:2300000, source:"independent",
      custodians:["Coinbase Prime","Anchorage Digital","BitGo"], validators:["Helius","Twinstake"],
      funders:["Solana Foundation","FalconX"],
      summary:"Formerly Helius Medical. A treasury wallet received 999,999 SOL directly from a Solana Foundation non-circulating-supply wallet, one day before the discount agreement was public. Dual-validator staking and a Coinbase-funded deposit cluster.",
      wallets:[
        ["7kBQy7e14gW4CJ9BNBHhrxoHFtBthBmZyUWcuSCKkVEY","Primary, Foundation transfer","verified"],
        ["9ggSjgTeNnvSGQYmMQJ1TwjiRmUFGCFfdUG54Gg2QCe3","Helius + Twinstake stake"],
        ["BsnXPFsKpXSoHq5LLg2MhEhiyLwbx8h6fbemsm6gKeuo","Shared deposit cluster"],
        ["98k8sDazxJbdvb6ENaapRmamyZoCDJY5FZjvakMfrL8X","Shared deposit cluster"],
        ["Nw5Trj8i5jKzuJufc9iNp5azTYtk8pnAc2yhsm6BqRv","Shared deposit cluster"],
        ["AMTdpu1npRe16Mkr9Wnz8uNyHN7oQ5xSzCcv4tt49zkK","Shared deposit cluster"],
        ["BPA6SSHNWAVgr4RNxEUQUmMyejS71Jvkv1nF3Lpi8Lqj","Shared deposit cluster"],
        ["DAtyhwj3AExisi2FS3Jw4ZU4Pq5PvATJ6fHzgsadzMHF","Helius stake (300K SOL)"]
      ]},
    { id:"sharps-technology", name:"Sharps Technology", ticker:"STSS", ex:"NASDAQ",
      declared:2000000, source:"independent",
      custodians:["Coinbase Prime"], validators:["Jupiter","Chorus One","Anchorage Digital"],
      funders:["FalconX"],
      summary:"Raised $400M+ to build a Solana treasury. Six addresses under Coinbase Prime custody, staked across Jupiter, Chorus One and Anchorage. 1,253,407 SOL traced from the filings.",
      wallets:[
        ["HHSNLApE2Txh6U2p2QsmfocE2fzoBk9fY5Vir9ndHM23","Coinbase Prime (primary)"],
        ["5tfHZEKdQFTEfYCNoGYbV8Sq6vfmCS83sVADFUSrTBE","Coinbase Prime, Jupiter"],
        ["72aSNbcPea1QN7NbxmEuQqDmBVowZpvFi1AvNdUekX5C","Cluster A, Jupiter"],
        ["DGVxn3q4TNFvDUXDHzM8gSTcYDNaqNmZ1vBkTiU4zCoX","Cluster C, Chorus One / Anchorage"],
        ["4vvMe3mYNHrNb3rwZiqCWh3QCbTi6DaLN2NHbDxgSHM5","Cluster C, Anchorage"]
      ]}
  ];
  const SMOKING={ wallet:"7kBQy7e14gW4CJ9BNBHhrxoHFtBthBmZyUWcuSCKkVEY", from:"Solana Foundation", amount:"999,999 SOL" };
  const TRACED={ "sharps-technology":1253407, "solana-company":3000000 };

  /* ---- build nodes + edges ---- */
  const KIND={ entity:{col:"#eaf0ff",r:0}, wallet:{col:"#2f6b53",r:5}, walletV:{col:"#14f195",r:6.5},
    custodian:{col:"#9945ff",r:11}, validator:{col:"#22d3ee",r:10}, funder:{col:"#ffb24a",r:11} };
  const nodes=[], edges=[], byId={};
  function short(a){ return a.slice(0,4)+"\u2026"+a.slice(-4); }
  function ensure(id,label,kind){ if(byId[id]) return byId[id];
    const k=KIND[kind]||KIND.wallet;
    const n={ id,label,kind, col:k.col, r:k.r||10, x:(Math.random()-.5)*420, y:(Math.random()-.5)*320, vx:0, vy:0, mass:2, pin:false, ph:Math.random()*6.283, data:null };
    byId[id]=n; nodes.push(n); return n; }
  const infraKind={};
  ENTITIES.forEach(e=>e.custodians.forEach(n=>{ infraKind[n]="custodian"; }));
  ENTITIES.forEach(e=>e.funders.forEach(n=>{ if(!infraKind[n]) infraKind[n]="funder"; }));
  ENTITIES.forEach(e=>e.validators.forEach(n=>{ if(!infraKind[n]) infraKind[n]="validator"; }));
  const ROLE={ custodian:"Custodian", validator:"Validator", funder:"Funding source" };

  function build(){
    ENTITIES.forEach((e,i)=>{
      const en=ensure("E:"+e.id, e.name, "entity");
      en.r=17+Math.sqrt(e.declared/1e6)*7; en.mass=9; en.data={ type:"entity", e };
      const ang=-Math.PI/2 + i*(2*Math.PI/ENTITIES.length);
      en.x=Math.cos(ang)*240; en.y=Math.sin(ang)*150;
      e.wallets.forEach((w,wi)=>{
        const ver=w[2]==="verified";
        const wn=ensure("W:"+w[0], short(w[0]), ver?"walletV":"wallet");
        wn.mass=1.4; wn.data={ type:"wallet", addr:w[0], wtype:w[1], verified:ver, parent:e };
        wn.x=en.x+Math.cos(wi)*70+(Math.random()-.5)*40; wn.y=en.y+Math.sin(wi)*70+(Math.random()-.5)*40;
        edges.push({ a:en, b:wn, col:ver?"rgba(20,241,149,.5)":"rgba(90,120,110,.28)", len:70, w:ver?1.4:0.7 });
      });
      e.custodians.forEach(c=>{ const cn=ensure("I:"+c,c,infraKind[c]); cn.data={type:"infra",role:ROLE[infraKind[c]],name:c};
        edges.push({ a:en, b:cn, col:"rgba(153,69,255,.4)", len:165, w:1.1 }); });
      e.validators.forEach(v=>{ const vn=ensure("I:"+v,v,infraKind[v]); vn.data={type:"infra",role:ROLE[infraKind[v]],name:v};
        edges.push({ a:en, b:vn, col:"rgba(34,211,238,.38)", len:160, w:1 }); });
      e.funders.forEach(f=>{ const fn=ensure("I:"+f,f,infraKind[f]); fn.data={type:"infra",role:ROLE[infraKind[f]],name:f};
        edges.push({ a:en, b:fn, col:"rgba(255,178,74,.4)", len:175, w:1.1 }); });
    });
    const f=byId["I:Solana Foundation"], w=byId["W:"+SMOKING.wallet];
    if(f&&w) edges.push({ a:f, b:w, col:"rgba(255,178,74,.85)", len:120, w:2.2, special:true });
  }

  /* ---- canvas, sized to its container ---- */
  let cv,ctx,stage,dossier,W=0,H=0,DPR=Math.min(window.devicePixelRatio||1,2);
  function measure(){ if(!stage) return; const r=stage.getBoundingClientRect();
    W=Math.max(320,r.width); H=Math.max(360,r.height);
    cv.width=W*DPR; cv.height=H*DPR; cv.style.width=W+"px"; cv.style.height=H+"px"; ctx.setTransform(DPR,0,0,DPR,0,0); }
  function CX(){ return W/2; } function CY(){ return H*0.52; }
  function SX(n){ return CX()+n.x; } function SY(n){ return CY()+n.y; }

  /* ---- force sim ---- */
  const REPULSE=2600, SPRING=0.018, CENTER=0.0022, DAMP=0.9, VMAX=6;
  let hot=null, q="";
  const reduced=(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)||false;
  function step(){
    for(let i=0;i<nodes.length;i++){ const a=nodes[i];
      for(let j=i+1;j<nodes.length;j++){ const b=nodes[j];
        let dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy+0.01; if(d2>120000) continue;
        const f=Math.min(REPULSE/d2,4), d=Math.sqrt(d2), fx=dx/d*f, fy=dy/d*f;
        a.vx+=fx/a.mass; a.vy+=fy/a.mass; b.vx-=fx/b.mass; b.vy-=fy/b.mass; } }
    for(const e of edges){ let dx=e.b.x-e.a.x, dy=e.b.y-e.a.y, d=Math.sqrt(dx*dx+dy*dy)+0.01;
      const diff=(d-e.len)/d*SPRING, fx=dx*diff, fy=dy*diff;
      e.a.vx+=fx/e.a.mass; e.a.vy+=fy/e.a.mass; e.b.vx-=fx/e.b.mass; e.b.vy-=fy/e.b.mass; }
    for(const n of nodes){ n.vx+=(-n.x)*CENTER; n.vy+=(-n.y)*CENTER; n.vx*=DAMP; n.vy*=DAMP;
      n.vx=Math.max(-VMAX,Math.min(VMAX,n.vx)); n.vy=Math.max(-VMAX,Math.min(VMAX,n.vy));
      if(!n.pin){ n.x+=n.vx; n.y+=n.vy; } }
  }
  function matches(n){ if(!q) return null;
    const d=n.data, s=(n.label+" "+(d&&(d.wtype||d.name||(d.e&&(d.e.ticker+" "+d.e.name)))||"")).toLowerCase();
    return s.indexOf(q)>=0; }
  function draw(){
    ctx.clearRect(0,0,W,H);
    const focus=hot, near=new Set();
    if(focus){ near.add(focus); for(const e of edges){ if(e.a===focus) near.add(e.b); if(e.b===focus) near.add(e.a); } }
    for(const e of edges){ const x1=SX(e.a),y1=SY(e.a),x2=SX(e.b),y2=SY(e.b);
      let on=!focus||(near.has(e.a)&&near.has(e.b)); if(q) on=on&&(matches(e.a)||matches(e.b));
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.lineWidth=e.w; ctx.strokeStyle=on?e.col:"rgba(60,80,120,.07)";
      if(e.special&&on){ const t=(Math.sin(Date.now()/420)+1)/2; ctx.strokeStyle="rgba(255,178,74,"+(0.5+0.45*t)+")"; ctx.lineWidth=1.6+1.4*t; ctx.shadowColor="rgba(255,178,74,.7)"; ctx.shadowBlur=10; }
      ctx.stroke(); ctx.shadowBlur=0; }
    for(const n of nodes){ const x=SX(n),y=SY(n);
      let m=q?matches(n):null; const dim=(focus&&!near.has(n))||(q&&!m);
      ctx.globalAlpha=dim?0.16:1;
      if(n.kind==="entity"){
        const rim=n.data.e.source==="community"?"#9945ff":"#14f195";
        ctx.beginPath(); ctx.arc(x,y,n.r,0,7); ctx.fillStyle="#0a1120"; ctx.fill();
        ctx.lineWidth=2; ctx.strokeStyle=rim; ctx.shadowColor=rim; ctx.shadowBlur=dim?0:(m?26:14); ctx.stroke(); ctx.shadowBlur=0;
        ctx.beginPath(); ctx.arc(x,y,3.2,0,7); ctx.fillStyle=rim; ctx.fill();
        ctx.globalAlpha=dim?0.2:1;
        ctx.fillStyle="#eaf0ff"; ctx.font="700 12px 'Archivo',sans-serif"; ctx.textAlign="center"; ctx.fillText(n.data.e.ticker,x,y+n.r+15);
        ctx.fillStyle="#5a6488"; ctx.font="500 8.5px 'JetBrains Mono',monospace"; ctx.fillText((n.data.e.declared/1e6).toFixed(1)+"M DECLARED",x,y+n.r+27);
      } else {
        const glow=(n===focus)||m;
        ctx.beginPath(); ctx.arc(x,y,n.r,0,7); ctx.fillStyle=n.col;
        ctx.shadowColor=n.col; ctx.shadowBlur=dim?0:(glow?22:(n.kind==="walletV"?9:5)); ctx.fill(); ctx.shadowBlur=0;
        if(m){ ctx.lineWidth=1.6; ctx.strokeStyle="rgba(20,241,149,.9)"; ctx.stroke(); }
        if(n.kind==="custodian"||n.kind==="validator"||n.kind==="funder"){
          ctx.lineWidth=1.2; ctx.strokeStyle="rgba(255,255,255,.18)"; ctx.stroke();
          if(!dim){ ctx.fillStyle="#8b96b8"; ctx.font="500 9px 'JetBrains Mono',monospace"; ctx.textAlign="center"; ctx.fillText(n.label.toUpperCase(),x,y+n.r+13); } }
      }
      ctx.globalAlpha=1;
    }
  }
  let rafId=0;
  function wander(){ const t=Date.now()/1000; for(const n of nodes){ if(n.pin) continue; n.vx+=Math.cos(t*0.5+n.ph)*0.09; n.vy+=Math.sin(t*0.45+n.ph*1.7)*0.09; } }
  function loop(){ if(document.body.dataset.view==="graph"){ if(!reduced) wander(); step(); draw(); } rafId=requestAnimationFrame(loop); }

  /* ---- interaction ---- */
  function pick(mx,my){ let best=null,bd=22*22;
    for(const n of nodes){ const dx=SX(n)-mx, dy=SY(n)-my, d=dx*dx+dy*dy, rr=(n.r+8)*(n.r+8); if(d<rr&&d<bd){ bd=d; best=n; } }
    return best; }
  let dragNode=null, downAt=null;
  function bind(){
    const tip=document.getElementById("gphTip");
    cv.addEventListener("mousemove", e=>{
      const r=cv.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
      const gx=document.getElementById("gphGX"), gy=document.getElementById("gphGY");
      if(gx) gx.textContent=((mx-CX())/10).toFixed(2); if(gy) gy.textContent=((my-CY())/10).toFixed(2);
      if(dragNode){ dragNode.x=mx-CX(); dragNode.y=my-CY(); dragNode.vx=dragNode.vy=0; return; }
      const n=pick(mx,my); hot=n; cv.style.cursor=n?"pointer":"grab";
      if(n){ tip.classList.add("on"); tip.style.left=(e.clientX+14)+"px"; tip.style.top=(e.clientY+14)+"px";
        let a,b; const d=n.data;
        if(d.type==="entity"){ a=d.e.name+" \u00b7 "+d.e.ticker; b=(d.e.declared/1e6).toFixed(1)+"M SOL DECLARED \u00b7 "+d.e.wallets.length+" WALLETS"; }
        else if(d.type==="wallet"){ a=d.addr; b=(d.verified?"VERIFIED \u00b7 ":"")+d.wtype.toUpperCase(); }
        else { a=d.name; b=d.role.toUpperCase(); }
        document.getElementById("gphTipA").textContent=a; document.getElementById("gphTipB").textContent=b;
      } else tip.classList.remove("on");
    });
    cv.addEventListener("mousedown", e=>{ const r=cv.getBoundingClientRect(); const n=pick(e.clientX-r.left,e.clientY-r.top);
      downAt={x:e.clientX,y:e.clientY}; if(n){ dragNode=n; n.pin=true; } cv.classList.add("drag"); });
    window.addEventListener("mouseup", e=>{ cv.classList.remove("drag");
      if(dragNode){ const moved=downAt&&(Math.abs(e.clientX-downAt.x)+Math.abs(e.clientY-downAt.y))>6; dragNode.pin=false; if(!moved) openDossier(dragNode); dragNode=null; } });
    cv.addEventListener("touchstart", e=>{ const t=e.touches[0], r=cv.getBoundingClientRect(); const n=pick(t.clientX-r.left,t.clientY-r.top); if(n){ hot=n; openDossier(n); } }, {passive:true});
    const qi=document.getElementById("gphQ"); if(qi) qi.addEventListener("input", e=>{ q=e.target.value.trim().toLowerCase(); });
    const dx=document.getElementById("gphDX"); if(dx) dx.addEventListener("click", ()=> dossier.classList.remove("open"));
    window.addEventListener("resize", ()=>{ if(inited){ measure(); if(reduced) draw(); } });
  }

  /* ---- dossier ---- */
  function rows(arr){ return arr.map(r=>'<div class="gph-r"><span class="k">'+r[0]+'</span><span class="v">'+r[1]+'</span></div>').join(''); }
  function chipBlock(title,arr,cls){ return '<div style="margin-top:13px"><div style="font-family:\'JetBrains Mono\',monospace;font-size:9.5px;color:var(--ink-faint);letter-spacing:.18em">'+title+'</div><div class="gph-chips">'+arr.map(a=>'<span class="gph-chip '+cls+'">'+a+'</span>').join('')+'</div></div>'; }
  function openDossier(n){
    const d=n.data; let kind,name,sub,idtag,body="";
    if(d.type==="entity"){ const e=d.e; idtag=e.ticker;
      kind='<span style="color:'+(e.source==='community'?'var(--violet)':'var(--sol)')+'">'+(e.source==='community'?'\u25c8 COMMUNITY-SOURCED':'\u25c6 ORIGINAL ATTRIBUTION')+'</span>';
      name=e.name; sub=e.ex+": "+e.ticker;
      body+=rows([["DECLARED", e.declared.toLocaleString()+" SOL"]]);
      const tr=TRACED[e.id];
      if(tr){ const pct=Math.min(100,Math.round(tr/e.declared*100));
        body+='<div class="gph-r"><span class="k">TRACED ON-CHAIN</span><span class="v">'+tr.toLocaleString()+' SOL</span></div><div class="gph-bar"><i style="width:'+pct+'%"></i></div><div style="font-family:\'JetBrains Mono\',monospace;font-size:9.5px;color:var(--ink-faint);letter-spacing:.1em;margin-top:7px">'+pct+'% OF DECLARED ATTRIBUTED</div>'; }
      body+=rows([["WALLETS MAPPED", e.wallets.length]]);
      if(e.custodians.length) body+=chipBlock("CUSTODY FINGERPRINT", e.custodians, "c");
      if(e.validators.length) body+=chipBlock("STAKING", e.validators, "v");
      if(e.funders.length) body+=chipBlock("FUNDING TRACE", e.funders, "f");
      body+='<div class="gph-note">'+e.summary+'</div>';
    } else if(d.type==="wallet"){ idtag=short(d.addr);
      kind=d.verified?'<span style="color:var(--sol)">\u25c9 VERIFIED ON-CHAIN LINK</span>':'<span style="color:#7fd9b0">\u25cb ATTRIBUTED ADDRESS</span>';
      name=short(d.addr); sub=d.parent.name+" \u00b7 "+d.parent.ticker;
      body+='<div class="gph-r"><span class="k">ADDRESS</span><span class="v" style="font-size:10.5px">'+d.addr+'</span></div>';
      body+=rows([["ROLE", d.wtype],["CONTROLLED BY", d.parent.name],["CONFIDENCE", d.verified?"VERIFIED":"HIGH"]]);
      if(d.verified) body+='<div class="gph-smoke"><div class="h">\u2316 SMOKING GUN</div><div class="b">Received <b>'+SMOKING.amount+'</b> directly from a <b>Solana Foundation</b> non-circulating-supply wallet, one day before the discount agreement was public.</div></div>';
      body+='<button class="gph-cta" onclick="window.open(\'https://solscan.io/account/'+d.addr+'\',\'_blank\')">OPEN ON SOLSCAN \u2192</button>';
    } else { idtag=d.name.slice(0,12).toUpperCase();
      const c=d.role==="Custodian"?"var(--violet)":d.role==="Validator"?"var(--cyan)":"#ffb24a";
      kind='<span style="color:'+c+'">'+d.role.toUpperCase()+'</span>'; name=d.name; sub="INSTITUTIONAL INFRASTRUCTURE";
      const linked=ENTITIES.filter(e=> e.custodians.indexOf(d.name)>=0||e.validators.indexOf(d.name)>=0||e.funders.indexOf(d.name)>=0).map(e=>e.ticker);
      body+=rows([["APPEARS ACROSS", linked.length+" ENTIT"+(linked.length>1?"IES":"Y")]]);
      body+=chipBlock("LINKED ENTITIES", linked, d.role==="Custodian"?"c":d.role==="Validator"?"v":"f");
      body+='<div class="gph-note">'+(linked.length>1?'A shared '+d.role.toLowerCase()+' across multiple treasuries. Common infrastructure is exactly the fingerprint the attribution method clusters on.':'Infrastructure node linked to one tracked entity.')+'</div>';
    }
    document.getElementById("gphDId").textContent=idtag;
    document.getElementById("gphDKind").innerHTML=kind;
    document.getElementById("gphDName").textContent=name;
    document.getElementById("gphDSub").textContent=sub;
    document.getElementById("gphDBody").innerHTML=body;
    dossier.classList.add("open");
  }

  /* ---- init (lazy, on first Network view) ---- */
  let inited=false;
  function init(){ if(inited) return;
    stage=document.getElementById("gphStage"); cv=document.getElementById("gphCanvas");
    if(!stage||!cv) return;
    ctx=cv.getContext("2d"); dossier=document.getElementById("gphDossier");
    inited=true; build(); bind(); measure();
    if(reduced){ for(let i=0;i<300;i++) step(); }
    loop();
  }
  window.__initGraph=init;
  window.__graphHide=function(){ if(dossier) dossier.classList.remove("open"); };
  document.addEventListener("keydown", e=>{ if(e.key==="Escape" && dossier) dossier.classList.remove("open"); });
})();

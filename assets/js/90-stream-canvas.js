
(function(){
  try{
    var c=document.getElementById('osi-stream'); if(!c||!c.getContext) return;
    var ctx=c.getContext('2d'); if(!ctx) return;
    var rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var DPR=Math.min(window.devicePixelRatio||1,2), W=0,H=0,frags=[];
    var hex='0123456789abcdef', tags=['tx','memo','sig','case','sol','seal','0x','vault','hash','slot'];
    function R(a,b){return a+Math.random()*(b-a);}
    function hsh(n){var s='';for(var i=0;i<n;i++)s+=hex[(Math.random()*16)|0];return s;}
    function frag(){return (Math.random()<.5?tags[(Math.random()*tags.length)|0]+':':'')+hsh(6+(Math.random()*10|0));}
    function build(){
      W=c.width=Math.floor(innerWidth*DPR); H=c.height=Math.floor(innerHeight*DPR);
      c.style.width=innerWidth+'px'; c.style.height=innerHeight+'px';
      var n=Math.max(14,Math.min(44,Math.floor(innerWidth/38))); frags=[];
      for(var i=0;i<n;i++){
        var cyan=Math.random()<.16, hot=Math.random()<.12;
        frags.push({x:R(0,W),y:R(0,H),v:R(.05,.28)*DPR,s:R(9.5,12.5)*DPR,
          a:hot?R(.16,.26):R(.05,.15),cyan:cyan,hot:hot,t:frag()});
      }
    }
    function paint(){
      ctx.clearRect(0,0,W,H);
      for(var i=0;i<frags.length;i++){var f=frags[i];
        ctx.font='600 '+f.s+"px 'JetBrains Mono',monospace";
        if(f.hot){ctx.shadowColor=f.cyan?'rgba(34,211,238,.7)':'rgba(255,122,61,.7)';ctx.shadowBlur=8*DPR;}
        else{ctx.shadowBlur=0;}
        ctx.fillStyle=(f.cyan?'rgba(34,211,238,':'rgba(255,138,70,')+f.a+')';
        ctx.fillText(f.t,f.x,f.y);
      }
      ctx.shadowBlur=0;
    }
    var raf;
    function tick(){ for(var i=0;i<frags.length;i++){var f=frags[i]; f.y+=f.v; if(f.y>H+18){f.y=-18;f.x=R(0,W);f.t=frag();}} paint(); raf=requestAnimationFrame(tick); }
    build(); window.addEventListener('resize',build);
    if(rm) paint(); else tick();
  }catch(e){}
})();

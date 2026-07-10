
(function(){
  function showAll(){ try{ var a=document.querySelectorAll('.reveal'); for(var k=0;k<a.length;k++) a[k].classList.add('in'); }catch(_){}}
  try{
    var els=document.querySelectorAll('.reveal'); if(!els.length) return;
    var rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(rm||!('IntersectionObserver' in window)){ showAll(); return; }
    var io=new IntersectionObserver(function(ents){ ents.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }); },{threshold:.12,rootMargin:'0px 0px -7% 0px'});
    for(var j=0;j<els.length;j++) io.observe(els[j]);
    setTimeout(showAll, 2200);
  }catch(e){ showAll(); }
})();

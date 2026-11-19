'use strict';
(() => {
  const views=[...document.querySelectorAll('[data-view]')];
  if(!views.length)return;
  const valid=new Set(views.map(el=>el.dataset.view));
  const shell=document.querySelector('[data-default-view]') || document.body;
  let current=valid.has(location.hash.slice(1))?location.hash.slice(1):(shell.dataset.defaultView||[...valid][0]);
  function show(name,{hash=true,scroll=true}={}){
    if(!valid.has(name))return false;
    current=name;
    for(const el of views){const on=el.dataset.view===name;el.classList.toggle('is-current',on);el.setAttribute('aria-hidden',String(!on));}
    for(const btn of document.querySelectorAll('[data-tab]')){const on=btn.dataset.tab===name;btn.classList.toggle('active',on);btn.setAttribute('aria-current',on?'page':'false');}
    if(hash)history.replaceState(null,'',location.pathname+location.search+'#'+name);
    if(scroll)window.scrollTo({top:0,behavior:'instant'});
    // Leaflet maps may have been initialized inside an offscreen tab.
    window.setTimeout(()=>window.dispatchEvent(new Event('resize')),120);
    return true;
  }
  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-tab],[data-go]');
    if(!target)return;
    const name=target.dataset.tab||target.dataset.go;
    if(valid.has(name)){event.preventDefault();show(name);}
  });
  window.addEventListener('hashchange',()=>show(location.hash.slice(1),{hash:false}));
  window.FDUI={show,current:()=>current};
  document.body.classList.add('ui-ready');
  show(current,{hash:false,scroll:false});
})();
document.addEventListener('DOMContentLoaded',()=>{
  const drawer=document.querySelector('[data-mobile-drawer]');if(!drawer)return;
  let overlay=document.querySelector('[data-mobile-drawer-overlay]');
  if(!overlay){overlay=document.createElement('button');overlay.type='button';overlay.className='mobile-drawer-overlay';overlay.dataset.mobileDrawerOverlay='';overlay.setAttribute('aria-label','Close navigation menu');document.body.append(overlay);}
  const close=()=>{drawer.classList.remove('is-open');overlay.classList.remove('is-open');document.body.classList.remove('drawer-open');};
  document.querySelectorAll('[data-drawer-toggle]').forEach(button=>button.addEventListener('click',()=>{const opened=drawer.classList.toggle('is-open');overlay.classList.toggle('is-open',opened);document.body.classList.toggle('drawer-open',opened);button.setAttribute('aria-expanded',String(opened));}));
  overlay.addEventListener('click',close);drawer.querySelectorAll('a').forEach(link=>link.addEventListener('click',close));
});

(() => {
  const stored=localStorage.getItem('hp_theme');
  const theme=stored==='light'||stored==='dark'?stored:(document.documentElement.dataset.defaultTheme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
  document.documentElement.dataset.theme=theme;
  window.HPTheme={get value(){return document.documentElement.dataset.theme;},toggle(){const next=this.value==='dark'?'light':'dark';document.documentElement.dataset.theme=next;localStorage.setItem('hp_theme',next);document.querySelectorAll('[data-theme-toggle]').forEach(button=>button.textContent=next==='dark'?'☀️':'🌙');}};
  addEventListener('DOMContentLoaded',()=>document.querySelectorAll('[data-theme-toggle]').forEach(button=>{button.textContent=theme==='dark'?'☀️':'🌙';button.addEventListener('click',()=>window.HPTheme.toggle());}));
})();

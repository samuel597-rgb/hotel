(()=>{
  const roleLabel=role=>({super_admin:'Administrator',admin:'Administrator',manager:'Manager',front_desk:'Front Desk',kitchen:'Kitchen',employee:'Waiter',waiter:'Waiter',cashier:'Cashier',supervisor:'Supervisor'})[role]||'Staff';
  const managerRoles=['super_admin','admin','manager'];
  const token=()=>localStorage.getItem('hp_admin_token')||sessionStorage.getItem('hp_admin_token')||localStorage.getItem('hp_staff_token')||sessionStorage.getItem('hp_staff_token')||'';
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const itemsFor=(role,landing)=>{
    const items=[{label:'Dashboard',href:role==='kitchen'?'/staff/dashboard.html':landing,key:'dashboard'},{label:'Messages',href:'/app/#messages',key:'messages'},{label:'Profile',href:'/app/#profile',key:'profile'}];
    if(managerRoles.includes(role))items.push({label:'Staff',href:'/admin/staff.html',key:'staff'},{label:'Products',href:'/app/#products',key:'products'},{label:'Floor & Tables',href:'/app/#floor',key:'floor'},{label:'Settings',href:'/app/#settings',key:'settings'},{label:'Audit log',href:'/admin/audit.html',key:'audit'},{label:'Online now',href:'/admin/dashboard.html#online',key:'online'});
    else if(role==='front_desk')items.push({label:'Orders',href:'/staff/orders.html',key:'orders'},{label:'Floor & Tables',href:'/app/#floor',key:'floor'},{label:'Customer support',href:'/app/#messages',key:'support'});
    else if(role==='kitchen')items.push({label:'Kitchen Display',href:'/staff/kds.html',key:'kds'},{label:'Orders (read-only)',href:'/staff/orders.html',key:'orders'});
    else items.push({label:'Orders (read-only)',href:'/staff/orders.html',key:'orders'},{label:'Floor & Tables (read-only)',href:'/app/#floor',key:'floor'});
    return items;
  };
  document.addEventListener('DOMContentLoaded',async()=>{
    const sidebar=document.querySelector('[data-staff-sidebar]');if(!sidebar)return;
    const authToken=token();if(!authToken){location.replace('/portal');return;}
    let result;try{const response=await fetch('/staff/me',{headers:{'x-auth-token':authToken}});if(!response.ok)throw new Error('Sign in required');result=await response.json();}catch{location.replace('/portal');return;}
    const user=result.user||{},role=user.role||'',path=location.pathname,section=new URLSearchParams(location.search).get('section')||location.hash.slice(1),userLanding=result.landing||'/portal';
    const routeKey=path.endsWith('/staff.html')?'staff':path.endsWith('/audit.html')?'audit':path.endsWith('/settings.html')?'settings':path.endsWith('/orders.html')?'orders':path.endsWith('/kds.html')?'kds':section;
    const admin=managerRoles.includes(role),isDashboard=path.endsWith('/dashboard.html'),isOrders=path.endsWith('/orders.html'),isKds=path.endsWith('/kds.html');
    const allowed=admin||(path.startsWith('/staff/')&&((role==='front_desk'&&(isDashboard||isOrders))||(role==='kitchen'&&(isDashboard||isOrders||isKds))||(['employee','waiter'].includes(role)&&(isDashboard||isOrders))));
    if(!allowed){sessionStorage.setItem('hp_portal_denied','1');location.replace(userLanding);return;}
    if(['staff','audit','settings'].includes(routeKey)&&!admin){location.replace(userLanding);return;}
    sidebar.innerHTML=`<div class="staff-sidebar-brand"><img src="/icons/logo-192.png" alt=""><strong>HOTELI POA</strong><small>Staff Portal</small></div><nav>${itemsFor(role,userLanding).map(item=>`<a href="${item.href}" data-nav="${item.key}">${escapeHtml(item.label)}</a>`).join('')}</nav><div class="staff-sidebar-user"><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.display_role||roleLabel(role))}</span><button type="button" data-staff-logout>Sign out</button></div>`;
    sidebar.dataset.role=role;
    if(sessionStorage.getItem('hp_portal_denied')==='1'){sessionStorage.removeItem('hp_portal_denied');let toast=document.createElement('div');toast.className='portal-toast';toast.textContent="You don't have access to that page.";document.body.append(toast);setTimeout(()=>toast.remove(),3200);}
    sidebar.querySelector('[data-staff-logout]').addEventListener('click',async()=>{try{await fetch('/staff/logout',{method:'POST',headers:{'x-auth-token':authToken}});}catch{}for(const store of [localStorage,sessionStorage])for(const key of ['hp_admin_token','hp_staff_token'])store.removeItem(key);location.replace('/portal');});
  });
})();

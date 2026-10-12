const adminToken=()=>localStorage.getItem('hp_admin_token')||sessionStorage.getItem('hp_admin_token');
const roleLabel=role=>({super_admin:'Administrator',admin:'Administrator',manager:'Manager',front_desk:'Front Desk',kitchen:'Kitchen',employee:'Waiter/Employee',waiter:'Waiter/Employee',cashier:'Cashier',supervisor:'Supervisor',customer:'Customer'})[role]||'Staff';
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.addEventListener('DOMContentLoaded',()=>{
  const form=document.querySelector('#login');
  if(form&&adminToken())location.replace('/admin/dashboard.html');
  form?.addEventListener('submit',async event=>{
    event.preventDefault();const error=document.querySelector('#error');error.textContent='';
    try{const response=await fetch('/staff/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const result=await response.json();if(!response.ok)throw new Error(result.error);if(!['admin','super_admin','manager'].includes(result.role)){error.textContent='This account does not have admin access.';return;}localStorage.setItem('hp_admin_token',result.token);location.href='/admin/dashboard.html';}
    catch(error){error.textContent=error.message;}
  });
  if(!location.pathname.startsWith('/admin/'))return;
  if(!adminToken())location.replace('/admin');
  let currentStaffRole='';
  HPApi.request('/staff/me').then(({user})=>{currentStaffRole=user.role||'';const names={super_admin:'Administrator',admin:'Administrator',manager:'Manager',front_desk:'Front Desk',kitchen:'Kitchen',employee:'Waiter/Employee',waiter:'Waiter/Employee',cashier:'Cashier',supervisor:'Supervisor'};document.querySelector('#user-badge').textContent=`${user.name} · ${user.display_role||names[user.role]||'Staff'}`;load();}).catch(()=>{});
  document.querySelector('#logout')?.addEventListener('click',async()=>{try{await HPApi.request('/staff/logout',{method:'POST'});}catch{}localStorage.removeItem('hp_admin_token');sessionStorage.removeItem('hp_admin_token');location.replace('/admin');});
  document.querySelector('#broadcast')?.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,body=new FormData(form).get('body'),roles=[...form.querySelectorAll('input[name=role]:checked')].map(input=>input.value);
    try{const result=await HPApi.request('/api/messages/broadcast',{method:'POST',body:JSON.stringify({body,roles})});document.querySelector('#broadcast-status').textContent=`Sent to ${result.recipients} roles.`;form.reset();}
    catch(error){document.querySelector('#broadcast-status').textContent=error.message;}
  });
  document.querySelector('#staff-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget;try{await HPApi.request('/api/admin/staff',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();await load();}
    catch(error){document.querySelector('#error').textContent=error.message;}
  });
  document.addEventListener('click',async event=>{const remove=event.target.closest('[data-delete-staff]'),deactivate=event.target.closest('[data-deactivate]'),button=remove||deactivate;if(!button)return;const id=remove?remove.dataset.deleteStaff:deactivate.dataset.deactivate;if(!confirm(remove?'Delete this staff account? It will be deactivated and its records retained.':'Deactivate this staff account?'))return;try{await HPApi.request(remove?`/api/admin/staff/${id}/delete`:`/api/admin/staff/${id}`,{method:'DELETE'});await load();}catch(error){document.querySelector('#error').textContent=error.message;}});
  async function load(){
    try{
      const [orders,staff,customers,online,audit]=await Promise.all([HPApi.request('/api/admin/orders'),HPApi.request('/api/admin/staff'),HPApi.request('/api/admin/customers'),HPApi.request('/api/admin/online'),HPApi.request('/api/admin/audit')]);
      document.querySelector('#summary').innerHTML=[['Orders',orders.length],['Staff',staff.length],['Customers',customers.length]].map(([label,value])=>`<article class="hp-card card"><span class="hp-muted">${label}</span><strong style="display:block;font-size:2rem">${value}</strong></article>`).join('');
      document.querySelector('#orders').innerHTML=orders.slice(0,12).map(order=>`<article class="hp-card card"><strong>Order #${escapeHtml(String(order.id).slice(0,8))}</strong><p>${escapeHtml(order.customer||'Customer')} · ${escapeHtml(order.status)}</p><p>${order.items.map(item=>`${escapeHtml(item.qty)}× ${escapeHtml(item.name)}`).join(', ')}</p></article>`).join('')||'<p>No orders yet.</p>';
      document.querySelector('#staff-list').innerHTML=staff.map(member=>`<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border);padding:8px 0"><span>${escapeHtml(member.name)} · ${escapeHtml(roleLabel(member.role))}${member.active?'':' · inactive'}</span><span style="display:flex;gap:8px">${member.active?`<button data-deactivate="${member.id}">Deactivate</button>`:''}${currentStaffRole==='super_admin'&&member.role!=='super_admin'&&member.active?`<button data-delete-staff="${member.id}">Delete</button>`:''}</span></div>`).join('')||'<p>No staff accounts.</p>';
      document.querySelector('#online-list').innerHTML=[...online.staff,...online.customers].map(person=>`<p>${escapeHtml(person.name)} · ${escapeHtml(roleLabel(person.role))} · ${escapeHtml(person.currentPage||'App')}</p>`).join('')||'<p class="hp-muted">Nobody active right now.</p>';
      document.querySelector('#audit-list').innerHTML=audit.rows.slice(0,12).map(row=>`<p>${escapeHtml(row.actorName||'System')} · ${escapeHtml(roleLabel(row.actorRole))} · ${escapeHtml(row.action)} · ${escapeHtml(new Date(row.createdAt).toLocaleString())}</p>`).join('')||'<p class="hp-muted">No audit events yet.</p>';
    }catch(error){document.querySelector('#error').textContent=error.message;}
  }
  const alertToggle=document.querySelector('#order-alerts');if(alertToggle){alertToggle.checked=localStorage.getItem('hp_order_alerts')==='1';alertToggle.addEventListener('change',()=>localStorage.setItem('hp_order_alerts',alertToggle.checked?'1':'0'));}
  document.querySelector('#refresh-orders')?.addEventListener('click',load);
  const sectionTarget=location.pathname.endsWith('/staff.html')?'staff':location.pathname.endsWith('/audit.html')?'audit':location.hash.slice(1);
  if(sectionTarget)setTimeout(()=>document.getElementById(sectionTarget)?.scrollIntoView({block:'start'}),0);
  let flashing=false,flashTimer=null;function flashTitle(){if(!alertToggle?.checked)return;const original='Admin workspace · HOTELI POA';clearInterval(flashTimer);flashTimer=setInterval(()=>{flashing=!flashing;document.title=flashing?'New order · HOTELI POA':original;},700);setTimeout(()=>{clearInterval(flashTimer);document.title=original;},6000);}
  const token=adminToken();let fallback=setInterval(load,5000);if(token&&'EventSource'in window){const stream=new EventSource(`/api/stream?token=${encodeURIComponent(token)}&scope=admin`);stream.addEventListener('order.new',()=>{load();flashTitle();});stream.addEventListener('order.status',load);stream.onerror=()=>{stream.close();if(!fallback)fallback=setInterval(load,5000);};}
  load();
});

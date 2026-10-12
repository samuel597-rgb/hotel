const adminToken=()=>localStorage.getItem('hp_admin_token')||sessionStorage.getItem('hp_admin_token');
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.addEventListener('DOMContentLoaded',()=>{
  const form=document.querySelector('#login');
  if(form&&adminToken())location.replace('/admin/dashboard.html');
  form?.addEventListener('submit',async event=>{
    event.preventDefault();const error=document.querySelector('#error');error.textContent='';
    try{const response=await fetch('/staff/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const result=await response.json();if(!response.ok)throw new Error(result.error);if(!['admin','super_admin','manager'].includes(result.role)){error.textContent='This account does not have admin access.';return;}localStorage.setItem('hp_admin_token',result.token);location.href='/admin/dashboard.html';}
    catch(error){error.textContent=error.message;}
  });
  if(!location.pathname.endsWith('dashboard.html'))return;
  if(!adminToken())location.replace('/admin');
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
  document.addEventListener('click',async event=>{const button=event.target.closest('[data-deactivate]');if(!button)return;if(!confirm('Deactivate this staff account?'))return;try{await HPApi.request(`/api/admin/staff/${button.dataset.deactivate}`,{method:'DELETE'});await load();}catch(error){document.querySelector('#error').textContent=error.message;}});
  async function load(){
    try{
      const [orders,staff,customers,online,audit]=await Promise.all([HPApi.request('/api/admin/orders'),HPApi.request('/api/admin/staff'),HPApi.request('/api/admin/customers'),HPApi.request('/api/admin/online'),HPApi.request('/api/admin/audit')]);
      document.querySelector('#summary').innerHTML=[['Orders',orders.length],['Staff',staff.length],['Customers',customers.length]].map(([label,value])=>`<article class="hp-card card"><span class="hp-muted">${label}</span><strong style="display:block;font-size:2rem">${value}</strong></article>`).join('');
      document.querySelector('#orders').innerHTML=orders.slice(0,12).map(order=>`<article class="hp-card card"><strong>Order #${escapeHtml(String(order.id).slice(0,8))}</strong><p>${escapeHtml(order.customer||'Customer')} · ${escapeHtml(order.status)}</p><p>${order.items.map(item=>`${escapeHtml(item.qty)}× ${escapeHtml(item.name)}`).join(', ')}</p></article>`).join('')||'<p>No orders yet.</p>';
      document.querySelector('#staff-list').innerHTML=staff.map(member=>`<div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--border);padding:8px 0"><span>${escapeHtml(member.name)} · ${escapeHtml(member.role)}${member.active?'':' · inactive'}</span>${member.active?`<button data-deactivate="${member.id}">Deactivate</button>`:''}</div>`).join('')||'<p>No staff accounts.</p>';
      document.querySelector('#online-list').innerHTML=[...online.staff,...online.customers].map(person=>`<p>${escapeHtml(person.name)} · ${escapeHtml(person.role)} · ${escapeHtml(person.currentPage||'App')}</p>`).join('')||'<p class="hp-muted">Nobody active right now.</p>';
      document.querySelector('#audit-list').innerHTML=audit.rows.slice(0,12).map(row=>`<p>${escapeHtml(row.actorRole)} · ${escapeHtml(row.action)} · ${escapeHtml(new Date(row.createdAt).toLocaleString())}</p>`).join('')||'<p class="hp-muted">No audit events yet.</p>';
    }catch(error){document.querySelector('#error').textContent=error.message;}
  }
  load();setInterval(load,15000);
});

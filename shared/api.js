(() => {
  const tokenKey=()=>location.pathname.startsWith('/admin')?'hp_admin_token':'hp_staff_token';
  async function request(url,options={}){
    const headers=new Headers(options.headers||{});headers.set('Content-Type','application/json');
    const token=localStorage.getItem(tokenKey())||sessionStorage.getItem(tokenKey());if(token)headers.set('x-auth-token',token);
    const response=await fetch(url,{...options,headers});
    if(response.status===401){localStorage.removeItem(tokenKey());sessionStorage.removeItem(tokenKey());if(location.pathname!=='/portal')location.replace('/portal');}
    const data=response.status===204?null:await response.json().catch(()=>({}));if(!response.ok)throw new Error(data?.error||'Request failed.');return data;
  }
  window.HPApi={request,tokenKey};
})();

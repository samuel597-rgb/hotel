import { apiRequest, auth, setSession } from './local-api.js';
import { db, storage } from './local-data.js';
import { toast, printReceipt, printThermal, downloadReceiptPDF } from './receipt.js';
import { onAuthStateChanged, signOut, updateProfile, sendPasswordResetEmail }
  from './local-auth.js';
import {
  collection, getDocs, getDoc, setDoc, addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, where, serverTimestamp, onSnapshot, limit
} from './local-data.js';
import { storageRef, uploadBytes, getDownloadURL } from './local-data.js';
import { applyAppearance as applySettingsAppearance } from './settings-behaviors.js';
import {
  loadSettings as loadUserSettings, saveSettings as saveUserSettings,
  applyAppearance as applyUserAppearance,
  loadMiniStatement, clearPaymentHistory as archivePaymentHistory,
  loadSessions, endSession as endUserSession
} from './settings-behaviors.js';

window.ksh = value => `KSH ${Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const asDate = value => value instanceof Date ? value : (value?.toDate?.() || new Date(value || ''));
const asMillis = value => { const parsed = asDate(value).getTime(); return Number.isFinite(parsed) ? parsed : 0; };

let flushingOfflineWrites = false;
let offlineQueueDb;
function getOfflineQueueDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (offlineQueueDb) return offlineQueueDb;
  offlineQueueDb = new Promise(resolve => {
    const request = indexedDB.open('hoteli-poa-offline', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('writes', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return offlineQueueDb;
}
async function readOfflineQueue() {
  const database = await getOfflineQueueDb();
  if (!database) return JSON.parse(localStorage.getItem('hotelPosPendingWrites') || '[]');
  return new Promise(resolve => { const request=database.transaction('writes').objectStore('writes').getAll(); request.onsuccess=()=>resolve(request.result||[]); request.onerror=()=>resolve([]); });
}
async function saveOfflineQueue(items) {
  localStorage.setItem('hotelPosPendingWrites', JSON.stringify(items));
  const database=await getOfflineQueueDb(); if (!database) return;
  return new Promise(resolve=>{const transaction=database.transaction('writes','readwrite'),store=transaction.objectStore('writes');store.clear();items.forEach(item=>store.put(item));transaction.oncomplete=resolve;transaction.onerror=resolve;});
}
async function flushOfflineWrites() {
  if (flushingOfflineWrites || !navigator.onLine) return;
  flushingOfflineWrites = true;
  try {
    const queue = await readOfflineQueue();
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : '';
    const apiBase = String(window.POS_API_BASE_URL || '').replace(/\/$/, '');
    const remaining = [];
    for (const item of queue) {
      try {
        const response = await fetch(`${apiBase}${item.path}`, {
          method: item.method,
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
          body: item.body === undefined ? undefined : JSON.stringify(item.body)
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          if (response.status >= 500 || response.status === 401) remaining.push(item);
          else console.warn('Discarded invalid offline write:', result.error || response.status);
        }
      } catch { remaining.push(item); }
    }
    await saveOfflineQueue(remaining);
    if (queue.length && !remaining.length) toast('Offline changes synced.', 'success');
  } catch (error) { console.warn('Offline changes remain queued:', error.message); }
  finally { flushingOfflineWrites = false; }
}
window.addEventListener('online', flushOfflineWrites);
window.addEventListener('load', () => setTimeout(flushOfflineWrites, 1000));

async function backendRequest(path, method = 'POST', body) {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : '';
  const requestBody = ['POST', 'PUT', 'PATCH'].includes(method) && body && !body.clientWriteId
    ? { ...body, clientWriteId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` }
    : body;
  const apiBase = String(window.POS_API_BASE_URL || '').replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody)
    });
  } catch (error) {
    if (!navigator.onLine || error instanceof TypeError) {
      const pending = await readOfflineQueue();
      const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pending.push({ id, path, method, body: requestBody, createdAt: new Date().toISOString() });
      await saveOfflineQueue(pending);
      return { success: true, id, queued: true, clientQueued: true };
    }
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (response.status >= 500 && ['POST', 'PUT', 'PATCH'].includes(method)) {
    const pending = await readOfflineQueue();
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending.push({ id, path, method, body: requestBody, createdAt: new Date().toISOString() });
    await saveOfflineQueue(pending);
    return { success: true, id, queued: true, clientQueued: true };
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

// ═══════════════════════════════════════════════════
//  ROOT APP — sidebar, routing, auth, shared state
// ═══════════════════════════════════════════════════
window.rootApp = function () {
  return {
    user: null, userName: 'Guest', role: 'customer', activeView: 'pos',
    hotelName: "HOTELI POA", taxRate: 16, taxMode: 'included',
    categories: [], products: [],
    staffLoginOpen: false, staffLoginPortal: 'admin', staffUsername: '', staffPassword: '', staffLoginError: '', staffLoginBusy: false,
    canInstall: false, installPrompt: null,
    get isManager() { return this.role === 'manager' || this.role === 'admin'; },
    get navItems() {
      if (this.role === 'customer') return [
        {id:'pos', label:'Food & Drinks', icon:'🍽️'},
        ...(this.user ? [{id:'orders', label:'My Orders', icon:'🧾'}, {id:'profile', label:'Profile', icon:'👤'}] : [])
      ];
      if (this.role === 'waiter') return [
        {id:'pos', label:'Food & Drinks', icon:'🍽️'},
        {id:'kitchen', label:'Kitchen Display', icon:'🍳'},
        {id:'messages', label:'Messages', icon:'✉️'}
      ];
      if (['cashier', 'supervisor'].includes(this.role)) return [
        {id:'pos', label:'Food & Drinks', icon:'🍽️'},
        {id:'orders', label:'Open Bills', icon:'🧾'},
        {id:'messages', label:'Messages', icon:'✉️'},
        {id:'profile', label:'Profile', icon:'👤'}
      ];
      const items = [
        {id:'messages', label:'Messages', icon:'✉️'},
        {id:'dashboard', label:'Dashboard', icon:'📊'},
        {id:'pos', label:'Food & Drinks', icon:'🍽️'},
        {id:'orders', label:'Bills', icon:'🧾'},
        {id:'profile', label:'Profile', icon:'👤'},
        {id:'settings', label:this.isManager ? 'Admin Settings' : 'Settings', icon:'⚙️'}
      ];
      if (this.isManager) items.push({id:'products', label:'Products', icon:'📦'}, {id:'floor', label:'Floor & Tables', icon:'🪑'}, {id:'kitchen', label:'Kitchen Display', icon:'🍳'});
      return items;
    },

    catalogUnsubscribers: [],
    async init() {
      // Customer menu is the public start page. Staff views require a staff claim.
      const applyHash = () => {
        const requested = (location.hash || (this.role === 'customer' ? '#pos' : '#dashboard')).slice(1);
        const staffViews = ['dashboard', 'orders', 'messages', 'profile'];
        const adminViews = ['products', 'settings', 'floor', 'kitchen'];
        if (this.isManager) this.activeView = [...staffViews, ...adminViews, 'pos'].includes(requested) ? requested : 'dashboard';
        else if (this.role === 'waiter') this.activeView = ['pos', 'messages', 'kitchen'].includes(requested) ? requested : 'pos';
        else if (['cashier', 'supervisor'].includes(this.role)) this.activeView = ['pos', 'orders', 'messages', 'profile'].includes(requested) ? requested : 'orders';
        else this.activeView = requested === 'pos' || (this.user && ['profile', 'orders'].includes(requested)) ? requested : 'pos';
      };
      window.addEventListener('hashchange', applyHash);
      window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        this.installPrompt = event;
        this.canInstall = true;
      });
      window.addEventListener('appinstalled', () => {
        this.installPrompt = null;
        this.canInstall = false;
      });

      onAuthStateChanged(auth, async (u) => {
        if (!u) {
          this.user = null;
          this.userName = 'Guest';
          this.role = 'customer';
          applyHash();
          this.watchCatalog();
          this.watchSettings();
          return;
        }
        this.user = u;
        this.userName = u ? (u.displayName || u.email || 'Customer') : 'Guest';
        const token = u ? await u.getIdTokenResult() : null;
        this.role = token?.claims.role || 'customer';
        applyHash();
        this.watchCatalog();
        this.watchSettings();
        if (u) flushOfflineWrites();
      });
    },

    openStaffLogin(portal) {
      this.staffLoginPortal = portal;
      this.staffUsername = portal === 'admin' ? 'admin 1' : 'employee 1';
      this.staffPassword = '';
      this.staffLoginError = '';
      this.staffLoginOpen = true;
    },
    async installApp() {
      if (!this.installPrompt) return;
      await this.installPrompt.prompt();
      await this.installPrompt.userChoice;
      this.installPrompt = null;
      this.canInstall = false;
    },
    async submitStaffLogin() {
      if (this.staffLoginBusy) return;
      this.staffLoginBusy = true;
      this.staffLoginError = '';
      try {
        const result = await apiRequest('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username: this.staffUsername, password: this.staffPassword })
        });
        const expectedRole = this.staffLoginPortal === 'admin' ? 'admin' : 'employee';
        if ((expectedRole === 'admin' && result.user?.role !== 'admin')
          || (expectedRole === 'employee' && !['waiter','cashier','supervisor','manager'].includes(result.user?.role))) throw new Error('This account cannot use that login option.');
        setSession(result.token, result.user);
        this.staffLoginOpen = false;
        this.staffPassword = '';
        location.hash = expectedRole === 'admin' ? '#dashboard' : (['cashier','supervisor'].includes(result.user.role) ? '#orders' : '#pos');
      } catch (error) {
        this.staffLoginError = error.message || 'Sign in failed. Check your username and password.';
      } finally {
        this.staffLoginBusy = false;
      }
    },

    watchCatalog() {
      this.catalogUnsubscribers.forEach(unsubscribe => unsubscribe());
      this.catalogUnsubscribers = [
        onSnapshot(collection(db, 'categories'), snap => {
          this.categories = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(category => category.isAvailable !== false)
            .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
        }, error => console.warn('Category updates unavailable:', error.message)),
        onSnapshot(collection(db, 'products'), snap => {
          this.products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }, error => console.warn('Product updates unavailable:', error.message))
      ];
    },

    watchSettings() {
      onSnapshot(doc(db, 'settings', 'general'), snap => {
        if (!snap.exists()) return;
        const settings = snap.data();
        this.hotelName = settings.hotelName || this.hotelName;
        this.taxRate = Number(settings.taxRate) || 0;
        this.taxMode = settings.taxMode === 'excluded' ? 'excluded' : 'included';
      }, error => console.warn('Hotel settings unavailable:', error.message));
    },

    goto(view) { location.hash = '#' + view; },
    async logout() {
      const sessionId = sessionStorage.getItem('hotelPosSessionId');
      if (this.user && sessionId) await endUserSession(this.user.uid, sessionId).catch(() => {});
      sessionStorage.removeItem('hotelPosSessionId');
      await signOut(auth);
      location.hash = '#pos';
      location.reload();
    },

    // Expose helpers to child components
    helpers: { toast, printReceipt, printThermal, downloadReceiptPDF }
  };
};

// ═══════════════════════════════════════════════════
//  POS COMPONENT (Food & Drinks)
// ═══════════════════════════════════════════════════
window.posApp = function (root) {
  return {
    get root() { return root; },
    currentCategory: null, search: '', cart: [], selectedProduct: null, selectedQty: 1,
    order: { table: '', tableId: null, channel: 'takeout', guests: 1, customer: '', customerPhone: '', riderName: '', riderPhone: '', tip: 0, rating: 0, feedback: '' },
    showPay: false, showChannel: false, payMethod: 'cash', processing: false,
    enabledPaymentMethods: ['cash', 'card', 'mpesa'],
    receiptSettings: { enabled: true, autoPrint: false },

    get categories() { return root.categories; },
    get products()   { return root.products; },
    get taxRate()    { return root.taxRate; },
    get activeView() { return root.activeView; },

    init() {
      try {
        const saved = JSON.parse(sessionStorage.getItem('samsCustomerCart') || '[]');
        if (saved.length) this.cart = saved;
      } catch {}
      window.addEventListener('hp-table-selected', event => { this.order.table=event.detail.label;this.order.tableId=event.detail.id;this.order.channel='dine_in';this.syncDisplay(); });
      try { const table=JSON.parse(sessionStorage.getItem('hpSelectedTable')||'null'); if(table){this.order.table=table.label;this.order.tableId=table.id;this.order.channel='dine_in';sessionStorage.removeItem('hpSelectedTable');} } catch {}
      if (root.user?.displayName) this.order.customer = root.user.displayName;
      if (root.user) getDoc(doc(db, 'userSettings', root.user.uid)).then(snap => {
        const checkout = snap.exists() ? snap.data().checkout : null;
        const methods = checkout?.methods;
        if (methods) this.enabledPaymentMethods = Object.keys(methods).filter(key => methods[key]);
        if (!this.enabledPaymentMethods.includes(this.payMethod)) this.payMethod = this.enabledPaymentMethods[0] || 'cash';
        if (checkout?.receipt && typeof checkout.receipt === 'object') this.receiptSettings = { ...this.receiptSettings, ...checkout.receipt };
        else if (checkout?.receipt === false) this.receiptSettings.enabled = false;
      }).catch(() => {});
    },
    get paymentOptions() {
      return [{ v: 'cash', l: '💵 Cash / pay on collection' }];
    },

    filteredCategories() {
      const q = this.search.toLowerCase();
      return q ? this.categories.filter(c => c.name.toLowerCase().includes(q))
               : this.categories;
    },
    filteredProducts() {
      const list = this.products.filter(p =>
        p.categoryId === this.currentCategory.id && p.isAvailable !== false);
      const q = this.search.toLowerCase();
      return q ? list.filter(p => p.name.toLowerCase().includes(q)) : list;
    },
    selectCategory(c) { this.currentCategory = c; this.search = ''; },
    selectProduct(p) { this.selectedProduct = p; this.selectedQty = 1; },

    addToCart(p, qty = 1) {
      const l = this.cart.find(x => x.productId === p.id);
      if (l) l.qty += qty; else this.cart.push({
        productId: p.id, name: p.name, price: p.price, qty
      });
      sessionStorage.setItem('samsCustomerCart', JSON.stringify(this.cart));
      this.syncDisplay();
    },
    inc(i) { this.cart[i].qty++; this.syncDisplay(); },
    dec(i) { if (--this.cart[i].qty <= 0) this.cart.splice(i, 1); this.syncDisplay(); },
    syncDisplay() {
      clearTimeout(this.displayTimer);
      this.displayTimer = setTimeout(() => fetch('/api/pos/cart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({table:this.order.table,tableId:this.order.tableId,channel:this.order.channel,items:this.cart})}).catch(()=>{}),250);
    },

    subtotal() { return this.cart.reduce((s, l) => s + l.price * l.qty, 0); },
    tax()      { return root.taxMode === 'included' ? this.subtotal() - this.subtotal() / (1 + this.taxRate / 100) : this.subtotal() * (this.taxRate / 100); },
    total()    { return this.subtotal() + (root.taxMode === 'excluded' ? this.tax() : 0) + Math.max(0, Number(this.order.tip) || 0); },
    setTipPercent(percent) { this.order.tip = Math.round(this.subtotal() * percent / 100); },
    openPay() {
      if (!this.cart.length) return;
      this.showChannel = true;
    },
    chooseChannel(channel) { this.order.channel = channel; this.showChannel = false; this.showPay = true; },

    async finalizeOrder() {
      this.processing = true;
      try {
        const orderDoc = {
          table: this.order.table, tableId: this.order.tableId, channel: this.order.channel, customerPhone: this.order.customerPhone,
          riderName: this.order.riderName, riderPhone: this.order.riderPhone, guests: this.order.guests,
          customer: this.order.customer,
          customerId: root.role === 'customer' ? root.user?.uid || null : null,
          waiterId: root.role === 'customer' ? null : root.user?.uid || null,
          waiterName: root.role === 'customer' ? root.userName : root.userName,
          status: root.role === 'customer' || this.payMethod === 'mpesa' ? 'pending' : 'paid',
          paymentStatus: root.role === 'customer' || this.payMethod === 'mpesa' ? 'pending' : 'paid', paymentMethod: this.payMethod,
          subtotal: this.subtotal(), tax: this.tax(), tip: Math.max(0, Number(this.order.tip) || 0),
          rating: this.order.rating, feedback: this.order.feedback,
          total: this.total(),
          currency: 'KES', createdAt: serverTimestamp()
        };
        const result = await backendRequest('/api/orders', 'POST', { ...orderDoc, items: this.cart });
        const orderId = result.id;
        if (result.order) Object.assign(orderDoc, result.order);
        if (result.clientQueued) {
          orderDoc.status = 'pending';
          orderDoc.paymentStatus = 'pending';
        }
        if (result.queued) toast('Order saved on this server and queued for sync.', 'info');

        const savedOrder = { id: orderId, ...orderDoc, lines: result.lines || this.cart };
        toast(`Order ${orderId.slice(0,6)} saved · ${window.ksh(orderDoc.total)}`, 'success');
        this.showPay = false;
        if (orderDoc.paymentStatus === 'paid' && this.receiptSettings.enabled) {
          setTimeout(() => {
            if (this.receiptSettings.autoPrint || confirm('Print receipt?')) printReceipt(savedOrder, root.hotelName);
          }, 200);
        }
        this.cart = [];
        this.syncDisplay();
        sessionStorage.removeItem('samsCustomerCart');
        this.order = { table: '', tableId: null, channel: 'takeout', guests: 1, customer: root.role === 'customer' ? root.userName : '', customerPhone: '', riderName: '', riderPhone: '', tip: 0, rating: 0, feedback: '' };
      } catch (e) {
        toast(e.message, 'error');
      } finally { this.processing = false; }
    },

    setRating(value) { this.order.rating = value; }
  };
};

// ═══════════════════════════════════════════════════
//  ORDERS / BILLS COMPONENT
// ═══════════════════════════════════════════════════
window.ordersApp = function (root) {
  return {
    get root() { return root; },
    orders: [], selected: null,
    get activeView() { return root.activeView; },

    unsubscribe: null,
    init() {
      if (!root.user) return;
      const q = root.role === 'customer'
        ? query(collection(db, 'orders'), where('customerId', '==', root.user.uid))
        : ['cashier', 'supervisor'].includes(root.role)
          ? query(collection(db, 'orders'), where('paymentStatus', '==', 'pending'))
          : query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
      this.unsubscribe = onSnapshot(q, snap => {
        this.orders = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => !o.archivedAt)
          .sort((a,b) => asMillis(b.createdAt) - asMillis(a.createdAt));
        if (this.selected) this.selected = this.orders.find(order => order.id === this.selected.id) || this.selected;
      }, error => toast(error.message, 'error'));
    },
    async select(o) {
      const lineSnap = await getDocs(collection(db, 'orders', o.id, 'lines'));
      this.selected = { ...o, lines: lineSnap.docs.map(d => d.data()) };
    },
    print(o) { printReceipt(o, root.hotelName); },
    pdf(o)   { downloadReceiptPDF(o).catch(e => toast(e.message, 'error')); },
    async clearOrder(o) {
      if (!['manager', 'admin'].includes(root.role)) return toast('Manager access required to archive bills.', 'error');
      if (!confirm(`Remove order #${o.id.slice(0, 8)} from this list?`)) return;
      await backendRequest(`/api/orders/${encodeURIComponent(o.id)}/archive`, 'PATCH', {});
      this.orders = this.orders.filter(item => item.id !== o.id);
      if (this.selected?.id === o.id) this.selected = null;
      toast('Order removed from the active list.');
    },
    async markPaid(o, method = 'cash') {
      if (!['cashier', 'supervisor', 'manager', 'admin'].includes(root.role)) return toast('Cashier access required to settle bills.', 'error');
      try {
        const payment = await backendRequest(`/api/orders/${encodeURIComponent(o.id)}/payment`, 'PATCH', { paymentMethod: method });
        Object.assign(o, { status: 'paid', paymentStatus: 'paid', paymentMethod: method });
        if (this.selected?.id === o.id) Object.assign(this.selected, o);
        toast(payment.loyalty ? `Payment recorded. Loyalty stamps: ${payment.loyalty.stamps}/10.` : 'Payment recorded as paid.', 'success');
      } catch (error) { toast(error.message, 'error'); }
    },
    async promptMpesa(o) {
      toast('M-Pesa payments are disabled in the free SQLite demo.', 'info');
    },
    async splitLine(order,line) {
      const quantity=Number(prompt(`How many of “${line.name}” should move to a new bill?`,String(Math.max(1,Math.floor((line.qty||line.quantity)/2)))));
      if(!Number.isFinite(quantity)||quantity<=0)return;
      try{const result=await backendRequest(`/api/orders/${encodeURIComponent(order.id)}/split`,'POST',{lines:[{id:line.id,qty:quantity}]});this.selected={...result.source,lines:result.source.lines};toast(`Created split bill #${result.split.id.slice(0,8)}.`,'success');}
      catch(error){toast(error.message,'error');}
    },
    async mergeBills(order) {
      const others=prompt('Enter the other open bill IDs, separated by commas:');if(!others)return;
      try{const orderIds=[order.id,...others.split(',').map(value=>value.trim()).filter(Boolean)];const result=await backendRequest('/api/orders/merge','POST',{orderIds});this.selected={...result.order};toast('Bills merged.','success');}
      catch(error){toast(error.message,'error');}
    },
    timestamp(o) { return (asMillis(o.createdAt) ? asDate(o.createdAt).toLocaleString() : 'Sync pending'); }
  };
};

window.messagesApp = function (root) {
  return {
    get root() { return root; },
    teams: ['Front of House', 'Kitchen'], activeTeam: 'Front of House', messages: [], draft: '', unsubscribe: null, typingUnsubscribe: null, typingNames: [], typingTimer: null, hasLoaded: false, messagePush: false,
    async init() {
      if (root.role === 'customer') return;
      try {
        const settings = await getDoc(doc(db, 'userSettings', root.user.uid));
        this.messagePush = false;
      } catch {}
      this.watchTeam();
    },
    selectTeam(team) { this.activeTeam = team; this.watchTeam(); },
    watchTeam() {
      this.unsubscribe?.();
      this.hasLoaded = false;
      const q = query(collection(db, 'messages'), where('team', '==', this.activeTeam), limit(100));
      this.unsubscribe = onSnapshot(q, snap => {
        const incoming = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a,b)=>asMillis(a.createdAt)-asMillis(b.createdAt));
        if (this.hasLoaded && this.messagePush) {
          incoming.filter(message => !this.messages.some(old => old.id === message.id) && message.fromUid !== root.user?.uid)
            .forEach(message => {
              toast(`${message.fromName}: ${message.text}`);
              if ('Notification' in window && Notification.permission === 'granted') new Notification('Sam\'s Hotel · ' + this.activeTeam, { body: message.text });
            });
        }
        this.messages = incoming;
        this.hasLoaded = true;
      }, error => toast(error.message, 'error'));
      this.typingUnsubscribe?.();
      this.typingUnsubscribe = onSnapshot(query(collection(db, 'typing'), where('team', '==', this.activeTeam)), snap => {
        const freshAfter = Date.now() - 10000;
        this.typingNames = snap.docs.map(item => item.data()).filter(item =>
          item.uid !== root.user?.uid && item.typing && asMillis(item.updatedAt) > freshAfter
        ).map(item => item.name || 'A teammate');
      });
    },
    async setTyping() {
      if (!root.user) return;
      const id = `${this.activeTeam.replace(/[^A-Za-z0-9_-]/g, '_')}_${root.user.uid}`;
      try {
        await setDoc(doc(db, 'typing', id), {
          uid: root.user.uid, name: root.userName, team: this.activeTeam,
          typing: Boolean(this.draft.trim()), updatedAt: serverTimestamp()
        }, { merge: true });
      } catch {}
      clearTimeout(this.typingTimer);
      if (this.draft.trim()) this.typingTimer = setTimeout(() => this.setTyping(), 3500);
    },
    async send() {
      const text = this.draft.trim(); if (!text || !root.user) return;
      this.draft = '';
      this.setTyping();
      try {
        const result = await backendRequest('/api/messages', 'POST', { team: this.activeTeam, text });
        if (result.queued) toast('Message queued for retry.', 'info');
      } catch (error) { this.draft = text; toast(error.message, 'error'); }
    },
    time(message) { return (asMillis(message.createdAt) ? asDate(message.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : 'Sending…'); }
  };
};

// ═══════════════════════════════════════════════════
//  DASHBOARD COMPONENT
// ═══════════════════════════════════════════════════
window.dashApp = function (root) {
  return {
    orders: [], totalRevenue: 0, newCustomers: 0,
    orderChange: 0, revenueChange: 0, customerChange: 0,
    bestEmployee: '', trendingDish: '', topEmployees: [], trending: [], _chartsDone: false,
    period: 'week',
    get activeView() { return root.activeView; },

    unsubscribe: null,
    init() {
      const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
      this.unsubscribe = onSnapshot(q, snap => {
        this.orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this.changePeriod();
        setTimeout(() => this.renderCharts(), 50);
      }, error => toast(error.message, 'error'));
    },

    periodStart(offset = 0) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      if (this.period === 'month') return new Date(start.getFullYear(), start.getMonth() - offset, 1).getTime();
      if (this.period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - offset * 7);
      else start.setDate(start.getDate() - offset);
      return start.getTime();
    },
    periodOrders(offset = 0) {
      const start = this.periodStart(offset);
      const end = offset === 0 ? Date.now() : this.periodStart(offset - 1);
      return this.orders.filter(o => {
        const createdAt = asMillis(o.createdAt);
        return createdAt >= start && createdAt < end;
      });
    },
    changePercent(current, previous) {
      if (!previous) return current ? null : 0;
      return Math.round(((current - previous) / previous) * 100);
    },
    changeLabel(value) {
      if (value === null) return 'New this period';
      return `${value > 0 ? '+' : ''}${value}% ${this.comparisonLabel()}`;
    },
    comparisonLabel() {
      return this.period === 'day' ? 'vs yesterday' : this.period === 'week' ? 'vs last week' : 'vs last month';
    },
    async changePeriod() {
      const visible = this.periodOrders();
      const previous = this.periodOrders(1);
      const paidSales = orders => orders.filter(o => o.paymentStatus === 'paid' || o.status === 'paid')
        .reduce((sum, order) => sum + (order.total || 0), 0);
      this.totalRevenue = paidSales(visible);
      this.orderChange = this.changePercent(visible.length, previous.length);
      this.revenueChange = this.changePercent(this.totalRevenue, paidSales(previous));

      const firstPaidOrder = new Map();
      for (const order of this.orders) {
        const createdAt = asMillis(order.createdAt);
        if (!order.customerId || !createdAt || (order.paymentStatus !== 'paid' && order.status !== 'paid')) continue;
        const first = firstPaidOrder.get(order.customerId);
        if (first === undefined || createdAt < first) firstPaidOrder.set(order.customerId, createdAt);
      }
      const countFirstTimeCustomers = (start, end) =>
        [...firstPaidOrder.values()].filter(createdAt => createdAt >= start && createdAt < end).length;
      const currentStart = this.periodStart();
      const previousStart = this.periodStart(1);
      const now = Date.now();
      this.newCustomers = countFirstTimeCustomers(currentStart, now);
      this.customerChange = this.changePercent(
        this.newCustomers,
        countFirstTimeCustomers(previousStart, currentStart)
      );
      await this.computeStats();
      if (document.getElementById('salesChart')) this.renderCharts();
    },

    async computeStats() {
      const byWaiter = {}, byItem = {};
      for (const o of this.periodOrders().filter(o => o.paymentStatus === 'paid' || o.status === 'paid')) {
        if (o.waiterId) byWaiter[o.waiterName || 'Team member'] = (byWaiter[o.waiterName || 'Team member'] || 0) + (o.total || 0);
        const ls = await getDocs(collection(db, 'orders', o.id, 'lines'));
        ls.docs.forEach(d => {
          const l = d.data();
          byItem[l.name] = (byItem[l.name] || 0) + l.qty;
        });
      }
      this.bestEmployee = Object.entries(byWaiter).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';
      this.trendingDish = Object.entries(byItem).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';
      this.topEmployees = Object.entries(byWaiter).sort((a,b)=>b[1]-a[1]).slice(0,5)
        .map(([name, sales]) => ({ name: name || 'Team member', sales }));
      this.trending = Object.entries(byItem).sort((a,b)=>b[1]-a[1]).slice(0,5)
        .map(([name, count]) => ({ name, count }));
    },

    renderCharts() {
      const paidOrders = this.periodOrders().filter(o => o.paymentStatus === 'paid' || o.status === 'paid');
      const salesEl = document.getElementById('salesChart');
      if (salesEl) {
        const now = new Date();
        let labels, totals;
        if (this.period === 'day') {
          labels = ['9 AM','12 PM','3 PM','6 PM','9 PM']; totals = [0,0,0,0,0];
          paidOrders.forEach(o => { const date=asDate(o.createdAt); if (!date) return; const bucket=Math.max(0,Math.min(4,Math.floor((date.getHours()-9)/3))); totals[bucket] += o.total||0; });
        } else {
          const count = this.period === 'week' ? 7 : 30;
          const dates = Array.from({length:count}, (_,i) => { const date=new Date(now); date.setHours(0,0,0,0); date.setDate(date.getDate()-count+1+i); return date; });
          const key = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
          labels = dates.map(d => this.period === 'week' ? d.toLocaleDateString('en-KE',{weekday:'short'}) : d.toLocaleDateString('en-KE',{day:'numeric',month:'short'}));
          totals = dates.map(date => paidOrders.filter(o => { const created=asDate(o.createdAt); return created && key(created)===key(date); }).reduce((sum,o)=>sum+(o.total||0),0));
        }
        Chart.getChart(salesEl)?.destroy();
        new Chart(salesEl, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Paid sales (KSH)', data: totals,
            borderColor: '#1E6FD9',
            backgroundColor: 'rgba(30,111,217,0.1)',
            tension: 0.4, fill: true
          }]
        },
        options: { plugins: { legend: { display: false } } }
        });
      }
      const revEl = document.getElementById('revChart');
      if (revEl) {
        const methods = ['cash','card','mpesa'];
        const totals = methods.map(method => paidOrders.filter(o=>o.paymentMethod===method).reduce((sum,o)=>sum+(o.total||0),0));
        Chart.getChart(revEl)?.destroy();
        new Chart(revEl, {
        type: 'doughnut',
        data: {
          labels: ['Cash','Bank card','M-Pesa'],
          datasets: [{
            data: totals,
            backgroundColor: ['#0A2540','#1E6FD9','#7FB2F0'],
            borderWidth: 0
          }]
        },
        options: { plugins: { legend: { display: false } }, cutout: '70%' }
        });
      }
    }
  };
};

// ═══════════════════════════════════════════════════
//  PRODUCTS MANAGER COMPONENT (CRUD)
// ═══════════════════════════════════════════════════
window.productManager = function (root) {
  return {
    products: [], search: '', filterCat: '',
    showModal: false, editing: null,
    form: { name: '', categoryId: '', price: 0, unit: '', description: '' }, imageFile: null,

    get categories() { return root.categories; },
    get role() { return root.role; },
    get activeView() { return root.activeView; },

    init() {
      if (!['manager', 'admin'].includes(this.role)) {
        return;
      }
      this.load();
    },
    load() {
      this.unsubscribe?.();
      const refresh = async () => {
        try { const response = await fetch('/api/products', { cache: 'no-store' }); if (!response.ok) throw new Error('Could not load products.'); this.products = await response.json(); }
        catch (error) { toast(error.message, 'error'); }
      };
      refresh();
      this.unsubscribe = setInterval(refresh, 5000);
    },
    catName(id) {
      const c = this.categories.find(c => c.id === id);
      return c ? c.name : 'Uncategorized';
    },
    filtered() {
      return this.products.filter(p => {
        const ms = p.name.toLowerCase().includes(this.search.toLowerCase());
        const mc = !this.filterCat || p.categoryId === this.filterCat;
        return ms && mc;
      });
    },
    openAdd() {
      this.editing = null;
      this.form = { name: '', categoryId: this.categories[0]?.id || '', price: 0, unit: '', description: '' };
      this.imageFile = null;
      this.showModal = true;
    },
    openEdit(p) {
      this.editing = p;
      this.form = { name: p.name, categoryId: p.categoryId, price: p.price, unit: p.unit, description: p.description || '' };
      this.imageFile = null;
      this.showModal = true;
    },
    async save() {
      if (!this.form.name || !this.form.categoryId) return toast('Name & Category required', 'error');
      if (this.imageFile && (this.imageFile.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(this.imageFile.type))) return toast('Choose a JPG, PNG, or WEBP image up to 5 MB.', 'error');
      const payload = new FormData();
      for (const [key, value] of Object.entries(this.form)) payload.set(key, String(value ?? ''));
      if (this.imageFile) payload.set('image', this.imageFile);
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(this.editing ? `/api/products/${encodeURIComponent(this.editing.id)}` : '/api/products', {
        method: this.editing ? 'PUT' : 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: payload
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return toast(result.error || 'Product could not be saved.', 'error');
      this.showModal = false;
      this.load();
      toast('Product saved.', 'success');
    },
    async importLegacy() {
      try { const result=await backendRequest('/api/products/import-legacy','POST',{}); await this.load(); toast(`Imported ${result.imported}; skipped ${result.skipped}.`,'success'); }
      catch(error) { toast(error.message,'error'); }
    },
    async remove(id) {
      if (!confirm('Delete this product?')) return;
      await backendRequest(`/api/products/${encodeURIComponent(id)}`, 'DELETE');
      this.products = this.products.filter(product => product.id !== id);
      toast('Deleted', 'success');
    }
  };
};

window.floorApp = function (root) {
  return {
    tables: [], floor: 'Main Floor', staff: [], registerOpen: null, showOpen: false, showTax: false, showQr: null,
    openingCash: 0, openingNote: '', newFloor: 'Main Floor', newNumber: '', newCategory: '', newStaffName: '', newStaffUser: '', newStaffPassword: '', newStaffRole: 'waiter',
    settings: { hotelName: root.hotelName, taxRate: root.taxRate, taxMode: root.taxMode },
    async init() { await this.refresh(); this.loadStaff(); this.registerOpen=await backendRequest('/api/register/current','GET').catch(()=>null); },
    async refresh() { this.tables = await fetch('/api/tables').then(r => r.json()).catch(() => []); },
    async loadStaff() { this.staff = await backendRequest('/api/staff','GET').catch(() => []); },
    setStatus(table, status) { return backendRequest(`/api/tables/${table.id}/status`,'PUT',{status}).then(() => this.refresh()).catch(e => toast(e.message,'error')); },
    async openTable(table) { try { const display=await backendRequest(`/api/tables/${table.id}/display`,'GET'); this.showQr={...table,displayURL:new URL(display.url,location.origin).href,qrURL:new URL(display.qrUrl,location.origin).href}; } catch(error) { toast(error.message,'error'); } },
    async addTable() { const result = await backendRequest('/api/tables','POST',{floor:this.newFloor,number:Number(this.newNumber)}); this.newNumber=''; await this.refresh(); toast(`Table ${result.number} added.`,'success'); },
    async addCategory() { const name=this.newCategory.trim(); if (!name) return; await backendRequest('/api/categories','POST',{name,icon:'🍽️',sort_order:root.categories.length+1}); this.newCategory=''; root.watchCatalog(); toast('Category added.','success'); },
    async renameCategory(category) { const name=prompt('Category name',category.name)?.trim(); if(!name||name===category.name)return; await backendRequest(`/api/categories/${category.id}`,'PUT',{name,icon:category.icon,sort_order:category.sort_order}); root.watchCatalog(); },
    async removeCategory(category) { if(!confirm(`Remove category ${category.name}?`))return; try{await backendRequest(`/api/categories/${category.id}`,'DELETE');root.watchCatalog();}catch(error){toast(error.message,'error');} },
    async addStaff() { const result=await backendRequest('/api/staff','POST',{name:this.newStaffName,username:this.newStaffUser,password:this.newStaffPassword,role:this.newStaffRole}); this.newStaffName=this.newStaffUser=this.newStaffPassword=''; await this.loadStaff(); toast(`Staff account ${result.username} created.`,'success'); },
    async editStaff(member) { const name=prompt('Staff name',member.name); if(!name?.trim())return; const role=prompt('Role: waiter, cashier, supervisor, manager',member.role); if(!role)return; try{await backendRequest(`/api/staff/${member.id}`,'PUT',{name:name.trim(),role});await this.loadStaff();}catch(error){toast(error.message,'error');} },
    async removeStaff(member) { if (!confirm(`Remove ${member.name}?`)) return; await backendRequest(`/api/staff/${member.id}`,'DELETE'); await this.loadStaff(); },
    async saveTax() { const result=await backendRequest('/api/settings/general','PUT',this.settings); root.taxRate=Number(this.settings.taxRate)||0; root.taxMode=this.settings.taxMode; this.showTax=false; toast('Tax display saved.','success'); return result; },
    openRegister() { if (this.registerOpen) return toast('A register is already open.','info'); if (!localStorage.getItem('hpTaxModeChosen')) this.showTax=true; else this.showOpen=true; },
    acceptTax(mode) { this.settings.taxMode=mode; localStorage.setItem('hpTaxModeChosen','yes'); this.saveTax().then(()=>this.showOpen=true); },
    discardTax() { this.showTax=false; },
    discardRegister() { this.showOpen=false; },
    async confirmRegister() { try { this.registerOpen=await backendRequest('/api/register/open','POST',{openingCash:this.openingCash,openingNote:this.openingNote}); this.showOpen=false; toast('Register opened.','success'); } catch(error) { toast(error.message,'error'); } },
    statusClass(status) { return ({available:'bg-emerald-100 text-emerald-800',occupied:'bg-red-100 text-red-800',reserved:'bg-purple-100 text-purple-800',cleaning:'bg-amber-100 text-amber-900'})[status] || 'bg-slate-100 text-slate-600'; },
    displayUrl(table) { return table?.displayURL || ''; },
    launchDisplay(table) { if (table?.displayURL) window.open(table.displayURL, '_blank', 'noopener'); },
    openPos(table) { const selected={id:table.id,label:`${table.floor} ${table.number}`};sessionStorage.setItem('hpSelectedTable',JSON.stringify(selected));root.goto('pos');window.dispatchEvent(new CustomEvent('hp-table-selected',{detail:selected})); }
  };
};

window.kitchenApp = function () {
  return {
    orders: [], timer: null,
    async init() { await this.refresh(); this.timer=setInterval(()=>this.refresh(),3000); },
    async refresh() { this.orders=await backendRequest('/api/orders','GET').then(rows=>rows.filter(order=>['new','preparing','ready'].includes(order.status))).catch(()=>this.orders); },
    async setStatus(order,status) { await backendRequest(`/api/orders/${encodeURIComponent(order.id)}/status`,'PUT',{status}); await this.refresh(); toast(`Order marked ${status}.`,'success'); },
    destroy() { clearInterval(this.timer); }
  };
};

// ═══════════════════════════════════════════════════
//  SETTINGS COMPONENT
// ═══════════════════════════════════════════════════
window.settingsApp = function (root) {
  return {
    get root() { return root; },
    tab: 'profile',
    notifList: ['New messages', 'Weekly report', 'Payment success', 'Billing alert', 'New inventory'],
    notif: {
      'New messages': { push: false, email: false },
      'Weekly report': { push: true, email: true },
      'Payment success': { push: false, email: false },
      'Billing alert': { push: true, email: false },
      'New inventory': { push: false, email: true }
    },
    appearance: { theme: 'light', fontSize: 16, lineHeight: 22 },
    checkout: { paymentHistory: true, miniStatement: true, receipt: { enabled: true, autoPrint: false }, methods: { cash: true, card: true, mpesa: true } },
    region: { location: 'Kenya', language: 'English', predictiveText: true },
    settings: { hotelName: "HOTELI POA", currency: 'KES', taxRate: 16, taxMode: 'included' },
    profile: { firstName: '', lastName: '', phone: '', dob: '', location: '' },
    miniStatement: [], sessions: [],
    avatarUploading: false,
    generalSettingsUnsubscribe: null,
    userSettingsUnsubscribe: null,
    get activeView() { return root.activeView; },

    init() {
      this.$watch('tab', tab => this.loadTab(tab));
      this.$watch('root.user', user => {
        if (user) { this.loadSettings(); this.watchUserSettings(); }
        else { this.userSettingsUnsubscribe?.(); this.userSettingsUnsubscribe = null; }
      });
      this.generalSettingsUnsubscribe = onSnapshot(doc(db, 'settings', 'general'), snapshot => {
        if (snapshot.exists()) this.settings = { ...this.settings, ...snapshot.data(), currency: 'KES' };
      }, error => console.warn('Live hotel settings unavailable:', error.message));
      this.watchUserSettings();
      this.loadSettings();
      const u = root.user;
      if (u) {
        const parts = (u.displayName || '').split(' ');
        this.profile.firstName = parts[0] || '';
        this.profile.lastName = parts.slice(1).join(' ') || '';
        this.profile.phone = u.phoneNumber || '';
      }
    },
    watchUserSettings() {
      this.userSettingsUnsubscribe?.();
      if (!root.user) return;
      this.userSettingsUnsubscribe = onSnapshot(doc(db, 'settings', root.user.uid), snapshot => {
        const preferences = snapshot.data()?.userPreferences;
        if (!preferences) return;
        this.notif = { ...this.notif, ...(preferences.notifications || {}) };
        this.appearance = { ...this.appearance, ...(preferences.appearance || {}) };
        this.checkout = { ...this.checkout, ...(preferences.checkout || {}) };
        this.region = { ...this.region, ...(preferences.region || {}) };
        this.profile = { ...this.profile, ...(preferences.profile || {}) };
        this.applyAppearance();
      }, error => console.warn('Live user settings unavailable:', error.message));
    },
    async loadSettings() {
      try {
        const [gen, userSettings] = await Promise.all([
          getDoc(doc(db, 'settings', 'general')),
          root.user ? loadUserSettings(root.user.uid) : Promise.resolve(null)
        ]);
        if (gen?.exists()) {
          const saved = gen.data();
          this.settings = {
            ...this.settings,
            ...saved,
            hotelName: saved.hotelName === "Sam's Hotel" ? "HOTELI POA" : (saved.hotelName || this.settings.hotelName),
            currency: 'KES'
          };
        }
        if (userSettings) {
          const saved = userSettings;
          this.notif = { ...this.notif, ...(saved.notifications || {}) };
          this.appearance = { ...this.appearance, ...(saved.appearance || {}) };
          const legacyFontSizes = { small: 14, medium: 16, large: 18 };
          if (typeof this.appearance.fontSize !== 'number') {
            this.appearance.fontSize = legacyFontSizes[this.appearance.fontSize] || 16;
          }
          this.appearance.lineHeight = Number(this.appearance.lineHeight) || 22;
          this.checkout = { ...this.checkout, ...(saved.checkout || {}) };
          if (typeof this.checkout.receipt !== 'object' || this.checkout.receipt === null) {
            this.checkout.receipt = { enabled: this.checkout.receipt !== false, autoPrint: false };
          } else {
            this.checkout.receipt = { enabled: true, autoPrint: false, ...this.checkout.receipt };
          }
          this.region = { ...this.region, ...(saved.region || {}) };
          this.profile = { ...this.profile, ...(saved.profile || {}) };
          this.profile.photoURL ||= saved.photoURL || root.user?.photoURL || '';
        }
        this.applyAppearance();
        await this.loadTab(this.tab);
      } catch (e) { console.warn('Could not load settings', e); }
    },
    applyAppearance() {
      applySettingsAppearance({ appearance: this.appearance });
    },
    async setTheme(theme) {
      this.appearance.theme = theme === 'dark' ? 'dark' : 'light';
      this.applyAppearance();
      await this.persistPreferences();
    },
    async setFontSize(value) {
      this.appearance.fontSize = Math.min(24, Math.max(12, Number(value) || 16));
      this.applyAppearance();
      await this.persistPreferences();
    },
    async setLineHeight(value) {
      this.appearance.lineHeight = Math.min(36, Math.max(14, Number(value) || 22));
      this.applyAppearance();
      await this.persistPreferences();
    },
    async persistPreferences() {
      if (!root.user) return location.href = '/auth.html';
      const userPreferences = {
        notifications: this.notif, appearance: this.appearance, checkout: this.checkout,
        region: this.region, profile: this.profile
      };
      await Promise.all([
        saveUserSettings(root.user.uid, userPreferences),
        setDoc(doc(db, 'settings', root.user.uid), {
          id: root.user.uid, key: 'userPreferences', value: userPreferences, userPreferences, updatedAt: serverTimestamp()
        }, { merge: true })
      ]);
    },
    async uploadAvatar(event) {
      const input = event?.target;
      const file = input?.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        toast('Choose an image file.', 'error');
        input.value = '';
        return;
      }
      if (file.size > 3 * 1024 * 1024) {
        toast('Profile photos must be under 3 MB.', 'error');
        input.value = '';
        return;
      }
      if (!root.user) return location.href = '/auth.html';

      this.avatarUploading = true;
      try {
        const avatarRef = storageRef(storage, `profiles/${root.user.uid}/avatar`);
        await uploadBytes(avatarRef, file, { contentType: file.type });
        const photoURL = await getDownloadURL(avatarRef);
        await updateProfile(root.user, { photoURL });
        this.profile.photoURL = photoURL;
        await this.persistPreferences();
        toast('Profile photo updated.', 'success');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        this.avatarUploading = false;
        input.value = '';
      }
    },
    async loadTab(tab) {
      if (!root.user) return;
      try {
        if (tab === 'checkout' && this.checkout.paymentHistory && this.checkout.miniStatement) {
          this.miniStatement = await loadMiniStatement(root.user.uid);
        }
        if (tab === 'security') {
          this.sessions = await loadSessions(root.user.uid);
        }
      } catch (error) { toast(error.message, 'error'); }
    },
    async toggleEmail(key) {
      this.notif[key].email = !this.notif[key].email;
      await this.persistPreferences();
    },
    async toggleMethod(method) {
      this.checkout.methods[method] = !this.checkout.methods[method];
      await this.persistPreferences();
    },
    async toggleCheckout(key) {
      this.checkout[key] = !this.checkout[key];
      await this.persistPreferences();
      if (key === 'paymentHistory' || key === 'miniStatement') {
        if (this.checkout.paymentHistory && this.checkout.miniStatement) await this.loadTab('checkout');
        else this.miniStatement = [];
      }
    },
    async toggleSaveHistory() { return this.toggleCheckout('paymentHistory'); },
    async toggleReceipt(key) {
      this.checkout.receipt[key] = !this.checkout.receipt[key];
      await this.persistPreferences();
    },
    async endSession(sessionId) {
      try {
        await endUserSession(root.user.uid, sessionId);
        this.sessions = await loadSessions(root.user.uid);
      } catch (error) { toast(error.message, 'error'); }
    },
    async savePreferences() {
      try {
        this.applyAppearance();
        await this.persistPreferences();
      } catch (e) { toast(e.message, 'error'); }
    },
    async saveAll() {
      await this.savePreferences();
      if (this.tab === 'profile' && root.user) {
        const displayName = `${this.profile.firstName} ${this.profile.lastName}`.trim();
        await updateProfile(root.user, { displayName, photoURL: this.profile.photoURL || root.user.photoURL || null });
        root.userName = displayName || root.user.email || 'Customer';
      }
      if (root.isManager && this.tab === 'general') await this.saveSettings();
    },
    async clearHistory() {
      if (!root.isManager) return toast('Admin access required to clear payment history.', 'error');
      try {
        if (await archivePaymentHistory(root.user.uid)) this.miniStatement = [];
      } catch (e) { toast(e.message, 'error'); }
    },
    async saveSettings() {
      if (!root.isManager) return toast('Manager only', 'error');
      await backendRequest('/api/settings/general', 'PUT', this.settings);
      toast('Settings saved', 'success');
    }
  };
};

window.profileApp = function (root) {
  return {
    get root() { return root; },
    firstName: '', lastName: '', phone: '', gender: '', photoURL: '', saving: false,
    ordersServed: 0, monthlySales: 0,
    init() {
      const user = root.user;
      const names = (user?.displayName || '').split(' ');
      this.firstName = names[0] || '';
      this.lastName = names.slice(1).join(' ');
      this.phone = user?.phoneNumber || '';
      this.loadProfile();
      this.loadStats();
    },
    async loadProfile() {
      try {
        const snap = await getDoc(doc(db, 'userSettings', root.user.uid));
        if (snap.exists()) {
          const saved = snap.data();
          this.firstName = saved.firstName || this.firstName;
          this.lastName = saved.lastName || this.lastName;
          this.phone = saved.phone || this.phone;
          this.gender = saved.gender || '';
          this.photoURL = saved.photoURL || '';
        }
      } catch (e) { console.warn('Could not load profile', e); }
    },
    async uploadPhoto(file) {
      if (!file || !file.type.startsWith('image/')) return toast('Choose an image file.', 'error');
      if (file.size > 3 * 1024 * 1024) return toast('Profile photos must be under 3 MB.', 'error');
      try {
        const path = storageRef(storage, `profiles/${root.user.uid}/avatar`);
        await uploadBytes(path, file, { contentType: file.type });
        this.photoURL = await getDownloadURL(path);
        await setDoc(doc(db, 'userSettings', root.user.uid), { photoURL: this.photoURL }, { merge: true });
        toast('Profile photo updated.', 'success');
      } catch (e) { toast(e.message, 'error'); }
    },
    async loadStats() {
      if (root.role === 'customer') return;
      try {
        const snap = await getDocs(query(collection(db, 'orders'), where('waiterId', '==', root.user.uid)));
        const orders = snap.docs.map(d => d.data());
        const month = new Date();
        const paid = orders.filter(o => o.paymentStatus === 'paid' || o.status === 'paid');
        this.ordersServed = paid.length;
        this.monthlySales = paid.filter(o => {
          const date = asDate(o.createdAt);
          return date && date.getMonth() === month.getMonth() && date.getFullYear() === month.getFullYear();
        }).reduce((sum, o) => sum + (o.total || 0), 0);
      } catch (e) { console.warn('Could not load profile stats', e); }
    },
    async save() {
      this.saving = true;
      try {
        await setDoc(doc(db, 'userSettings', root.user.uid), {
          firstName: this.firstName, lastName: this.lastName, phone: this.phone,
          gender: this.gender, photoURL: this.photoURL
        }, { merge: true });
        const displayName = `${this.firstName} ${this.lastName}`.trim();
        await updateProfile(root.user, { displayName });
        await setDoc(doc(db, 'users', root.user.uid), {
          id: root.user.uid, name: displayName, email: root.user.email || '', updatedAt: new Date().toISOString()
        }, { merge: true });
        root.userName = root.user.displayName || root.user.email;
        await backendRequest('/api/profile', 'PATCH', { name: displayName, phone: this.phone, photoURL: this.photoURL || '' });
        toast('Profile saved', 'success');
      } catch (e) { toast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async changePassword() {
      if (!root.user?.email) return toast('This account does not use email/password sign-in.', 'error');
      try { await sendPasswordResetEmail(auth, root.user.email); toast('If that email is registered, a reset code has been sent.', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }
  };
};

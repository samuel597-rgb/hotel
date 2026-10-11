import { auth } from './supabase.js';
import {
  collection, doc, getDoc, getDocs, limit, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch,
  storageRef, uploadBytes, getDownloadURL
} from './supabase-data.js';
import { storage } from './supabase-data.js';
import { toast } from './receipt.js';

const DEFAULT_SETTINGS = {
  notifications: {
    'New messages': { push: true, email: false },
    'Weekly report': { push: false, email: true },
    'Payment success': { push: true, email: false },
    'Billing alert': { push: true, email: true },
    'New inventory': { push: false, email: true }
  },
  appearance: { theme: 'light', fontSize: 16, lineHeight: 22 },
  checkout: {
    paymentHistory: true,
    miniStatement: true,
    receipt: { enabled: true, autoPrint: false },
    methods: { cash: true, card: true, mpesa: true }
  },
  region: { location: 'Kenya', language: 'English', predictiveText: true },
  profile: { firstName: '', lastName: '', phone: '', gender: '', photoURL: '' }
};

const clone = value => JSON.parse(JSON.stringify(value));
const requireCurrentUser = uid => {
  if (!auth.currentUser || auth.currentUser.uid !== uid) throw new Error('Sign in as this user to change these settings.');
  return auth.currentUser;
};

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] || {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export async function loadSettings(uid) {
  requireCurrentUser(uid);
  const snapshot = await getDoc(doc(db, 'userSettings', uid));
  if (!snapshot.exists()) return clone(DEFAULT_SETTINGS);
  return deepMerge(clone(DEFAULT_SETTINGS), snapshot.data());
}

export async function saveSettings(uid, settings) {
  requireCurrentUser(uid);
  const allowed = {
    notifications: settings.notifications,
    appearance: settings.appearance,
    checkout: settings.checkout,
    region: settings.region,
    profile: settings.profile,
    updatedAt: serverTimestamp()
  };
  await setDoc(doc(db, 'userSettings', uid), allowed, { merge: true });
  toast('Settings saved.', 'success');
}

export function applyAppearance(settings) {
  const appearance = settings.appearance || {};
  const root = document.documentElement;
  const fontSize = typeof appearance.fontSize === 'number'
    ? Math.min(24, Math.max(12, appearance.fontSize))
    : ({ small: 14, medium: 16, large: 18 }[appearance.fontSize] || 16);
  const lineHeight = Math.min(36, Math.max(fontSize, Number(appearance.lineHeight) || 22));
  root.classList.toggle('dark', appearance.theme === 'dark');
  root.dataset.theme = appearance.theme === 'dark' ? 'dark' : 'light';
  root.dataset.fontSize = String(fontSize);
  root.style.setProperty('--base-font-size', `${fontSize}px`);
  root.style.setProperty('--base-line-height', `${lineHeight / fontSize}`);
  document.body.style.fontSize = `${fontSize}px`;
  document.body.style.lineHeight = String(lineHeight / fontSize);
}

export async function registerFcmToken(uid) {
  requireCurrentUser(uid);
  toast('Push notifications are not configured on this service.', 'error');
  return null;
}

export async function unregisterFcmToken(uid) {
  requireCurrentUser(uid);
  await setDoc(doc(null, 'userSettings', uid), { fcmToken: null }, { merge: true });
  toast('Push notifications disabled.', 'info');
}

export async function loadMiniStatement(uid, limitN = 10) {
  const user = requireCurrentUser(uid);
  const token = await user.getIdTokenResult();
  const role = token.claims.role || 'customer';
  const orders = collection(db, 'orders');
  let statementQuery;
  if (['manager', 'admin', 'supervisor'].includes(role)) {
    statementQuery = query(orders, orderBy('createdAt', 'desc'), limit(limitN));
  } else if (role === 'waiter') {
    statementQuery = query(orders, where('waiterId', '==', uid), orderBy('createdAt', 'desc'), limit(limitN));
  } else {
    statementQuery = query(orders, where('customerId', '==', uid), orderBy('createdAt', 'desc'), limit(limitN));
  }
  const snapshot = await getDocs(statementQuery);
  return snapshot.docs.map(order => ({ id: order.id, ...order.data() }))
    .filter(order => !order.archivedAt)
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, limitN);
}

export async function clearPaymentHistory(uid) {
  const user = requireCurrentUser(uid);
  const token = await user.getIdTokenResult();
  if (!['manager', 'admin'].includes(token.claims.role)) throw new Error('Manager access is required to clear active payment history.');
  if (!confirm('Archive all orders from the active payment history? Order records will be retained.')) return false;

  const snapshot = await getDocs(collection(db, 'orders'));
  const activeOrders = snapshot.docs.filter(order => !order.data().archivedAt);
  for (let offset = 0; offset < activeOrders.length; offset += 450) {
    const batch = writeBatch(db);
    activeOrders.slice(offset, offset + 450).forEach(order => {
      batch.update(order.ref, { archivedAt: serverTimestamp() });
    });
    await batch.commit();
  }
  toast('Payment history archived from the active list.', 'success');
  return true;
}

const TRANSLATIONS = {
  en: {
    welcomeBack: 'Welcome Back!', signIn: 'Sign in', forgotPassword: 'Forgot password?',
    dashboard: 'Dashboard', foodAndDrinks: 'Food & Drinks', messages: 'Messages',
    bills: 'Bills', settings: 'Settings', notifications: 'Notifications', support: 'Support',
    chargeCustomer: 'Charge customer'
  },
  sw: {
    welcomeBack: 'Karibu Tena!', signIn: 'Ingia', forgotPassword: 'Umesahau nenosiri?',
    dashboard: 'Dashibodi', foodAndDrinks: 'Chakula na Vinywaji', messages: 'Ujumbe',
    bills: 'Bili', settings: 'Mipangilio', notifications: 'Arifa', support: 'Msaada',
    chargeCustomer: 'Toza mteja'
  }
};

export function t(key, locale = 'en') {
  return TRANSLATIONS[locale]?.[key] || TRANSLATIONS.en[key] || key;
}

export async function registerSession(uid) {
  requireCurrentUser(uid);
  const sessionId = crypto.randomUUID();
  const userAgent = navigator.userAgent;
  const device = /Mobi|Android/i.test(userAgent) ? 'Mobile' : 'Desktop';
  await setDoc(doc(db, 'userSettings', uid, 'sessions', sessionId), {
    device, platform: navigator.platform || 'Unknown', userAgent,
    active: true, createdAt: serverTimestamp(), lastSeenAt: serverTimestamp()
  });
  return sessionId;
}

export async function loadSessions(uid) {
  requireCurrentUser(uid);
  const snapshot = await getDocs(collection(db, 'userSettings', uid, 'sessions'));
  return snapshot.docs.map(session => ({ id: session.id, ...session.data() }));
}

export async function endSession(uid, sessionId) {
  requireCurrentUser(uid);
  await updateDoc(doc(db, 'userSettings', uid, 'sessions', sessionId), {
    active: false, endedAt: serverTimestamp()
  });
  toast('Session ended.', 'success');
}

export async function uploadImage(file, path) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in before uploading an image.');
  if (!file) throw new Error('Choose an image first.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Images must be under 5 MB.');
  if (!file.type.startsWith('image/')) throw new Error('Only image files are allowed.');

  const userPath = `profiles/${user.uid}/avatar`;
  const reviewPrefix = `reviews/${user.uid}/`;
  const isProductPath = path.startsWith('products/');
  if (path !== userPath && !path.startsWith(reviewPrefix) && !isProductPath)
    throw new Error('This upload path is not allowed.');
  if (isProductPath) {
    const claims = await user.getIdTokenResult();
    if (!['manager', 'admin'].includes(claims.claims.role)) throw new Error('Manager access is required to upload product images.');
  }

  const imageRef = storageRef(storage, path.replace(/\/+$/, ''));
  await uploadBytes(imageRef, file, { contentType: file.type });
  return getDownloadURL(imageRef);
}

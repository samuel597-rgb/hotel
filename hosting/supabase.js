import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const response = await fetch('/runtime-config.json', { cache: 'no-store' });
if (!response.ok) throw new Error('Could not load the Supabase runtime configuration.');
const config = await response.json();
if (!config.supabaseUrl || !config.supabaseAnonKey) {
  throw new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to the Render service environment.');
}

export const apiBaseUrl = String(config.apiBaseUrl || '').replace(/\/$/, '');
const projectRef = new URL(config.supabaseUrl).hostname.split('.')[0];
const tokenStorageKey = `sb-${projectRef}-auth-token`;
const authStorage = {
  getItem(key) {
    const remember = localStorage.getItem('hotelPosRememberMe') === 'true';
    if (remember) return localStorage.getItem(key) ?? sessionStorage.getItem(key);
    const value = sessionStorage.getItem(key) ?? localStorage.getItem(key);
    if (value !== null) { sessionStorage.setItem(key, value); localStorage.removeItem(key); }
    return value;
  },
  setItem(key, value) {
    const target = localStorage.getItem('hotelPosRememberMe') === 'true' ? localStorage : sessionStorage;
    const other = target === localStorage ? sessionStorage : localStorage;
    target.setItem(key, value); other.removeItem(key);
  },
  removeItem(key) { localStorage.removeItem(key); sessionStorage.removeItem(key); }
};
export const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { autoRefreshToken: true, detectSessionInUrl: true, persistSession: true, storage: authStorage, storageKey: tokenStorageKey }
});

const asUser = (raw, accessToken) => raw && ({
  ...raw,
  uid: raw.id,
  displayName: raw.user_metadata?.full_name || raw.user_metadata?.name || '',
  phoneNumber: raw.phone || raw.user_metadata?.phone || '',
  photoURL: raw.user_metadata?.avatar_url || '',
  getIdToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || accessToken || '';
  },
  getIdTokenResult: async () => {
    const token = await rawToken();
    const result = await fetch(`${apiBaseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() : { role: 'customer' });
    return { token, claims: { role: result?.role || 'customer' } };
  }
});

async function rawToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || '';
}

export const auth = {
  get currentUser() {
    return authUserCache;
  }
};

let authUserCache = null;
supabase.auth.onAuthStateChange((_event, session) => {
  authUserCache = asUser(session?.user, session?.access_token) || null;
});

export function setSessionPersistence(remember) {
  const value = localStorage.getItem(tokenStorageKey) ?? sessionStorage.getItem(tokenStorageKey);
  localStorage.setItem('hotelPosRememberMe', String(Boolean(remember)));
  const target = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  if (value !== null) target.setItem(tokenStorageKey, value);
  other.removeItem(tokenStorageKey);
}

export function adaptUser(user) { authUserCache = asUser(user, null) || null; return authUserCache; }
export function getAccessToken() { return rawToken(); }

const API_BASE_URL = String(window.POS_API_BASE_URL || '').replace(/\/$/, '');
const TOKEN_KEY = 'hotelPosSessionToken';
let listeners = new Set();
let preferredStorage = localStorage.getItem('hotelPosRememberMe') === 'true' ? localStorage : sessionStorage;

function tokenStorage() {
  return localStorage.getItem('hotelPosRememberMe') === 'true' ? localStorage : sessionStorage;
}
function currentToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
}
function adaptUser(raw) {
  if (!raw) return null;
  return {
    ...raw,
    uid: raw.uid || raw.id,
    displayName: raw.displayName || raw.user_metadata?.full_name || raw.name || '',
    phoneNumber: raw.phoneNumber || raw.user_metadata?.phone || '',
    photoURL: raw.photoURL || raw.user_metadata?.avatar_url || '',
    getIdToken: async () => currentToken(),
    getIdTokenResult: async () => {
      const result = await apiRequest('/api/me');
      return { token: currentToken(), claims: { role: result.role || 'customer' } };
    }
  };
}
function emit(event) {
  for (const listener of listeners) listener(event, auth.currentUser);
}
export function setSession(token, rawUser) {
  const target = tokenStorage();
  const other = target === localStorage ? sessionStorage : localStorage;
  target.setItem(TOKEN_KEY, token);
  other.removeItem(TOKEN_KEY);
  auth.currentUser = adaptUser(rawUser);
  emit('SIGNED_IN');
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  auth.currentUser = null;
  emit('SIGNED_OUT');
}
export function setSessionPersistence(remember) {
  localStorage.setItem('hotelPosRememberMe', remember ? 'true' : 'false');
  const token = currentToken();
  preferredStorage = remember ? localStorage : sessionStorage;
  if (token) {
    preferredStorage.setItem(TOKEN_KEY, token);
    (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY);
  }
}
export async function apiRequest(path, options = {}) {
  const token = currentToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

export const apiBaseUrl = API_BASE_URL;
export const auth = {
  currentUser: null,
  onAuthStateChange(callback) {
    listeners.add(callback);
    callback('INITIAL_SESSION', this.currentUser);
    return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
  }
};

try {
  if (currentToken()) {
    const result = await apiRequest('/api/auth/session');
    auth.currentUser = adaptUser(result.user);
  }
} catch {
  clearSession();
}

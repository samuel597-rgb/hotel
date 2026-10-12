import { apiRequest, auth, clearSession, setSession } from './local-api.js';

export function onAuthStateChanged(_auth, callback) {
  const { data } = auth.onAuthStateChange((_event, user) => callback(user));
  return () => data.subscription.unsubscribe();
}

export async function signInWithEmailAndPassword(_auth, email, password) {
  const result = await apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  setSession(result.token, result.user);
  return { user: auth.currentUser };
}

export async function createUserWithEmailAndPassword(_auth, email, password) {
  const result = await apiRequest('/api/auth/signup', { method: 'POST', body: JSON.stringify({
    email, password, displayName: document.getElementById('fullName')?.value?.trim() || ''
  }) });
  setSession(result.token, result.user);
  return { user: auth.currentUser };
}

export async function updateProfile(_user, profile) {
  const result = await apiRequest('/api/profile', { method: 'PATCH', body: JSON.stringify({
    name: profile.displayName || auth.currentUser?.displayName,
    phone: profile.phoneNumber || auth.currentUser?.phoneNumber,
    photoURL: profile.photoURL || auth.currentUser?.photoURL
  }) });
  auth.currentUser = { ...auth.currentUser, ...result.user,
    displayName: result.user.displayName || result.user.user_metadata?.full_name || '' };
  return auth.currentUser;
}

export class GoogleAuthProvider { constructor() { this.providerId = 'google'; } }
export class FacebookAuthProvider { constructor() { this.providerId = 'facebook'; } }
export async function signInWithPopup() { throw new Error('Social sign-in is disabled in the local SQLite demo.'); }
export async function signInWithRedirect() { throw new Error('Social sign-in is disabled in the local SQLite demo.'); }
export async function getRedirectResult() { return null; }
export async function setPersistence() {}
export const browserLocalPersistence = 'local';
export const browserSessionPersistence = 'session';
export async function signInWithPhoneNumber() { throw new Error('Phone sign-in is disabled in the local SQLite demo.'); }
export async function signOut() {
  try { await apiRequest('/api/auth/logout', { method: 'POST' }); } finally { clearSession(); }
}
export async function sendPasswordResetEmail() {
  throw new Error('Email password reset is disabled in the local SQLite demo. Ask a manager to help reset this account.');
}

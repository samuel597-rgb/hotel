import { supabase, auth, adaptUser, apiBaseUrl } from './supabase.js';

const fail = result => { if (result?.error) throw result.error; return result?.data; };

export function onAuthStateChanged(_auth, callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(adaptUser(session?.user) || null);
  });
  return () => data.subscription.unsubscribe();
}

export async function signInWithEmailAndPassword(_auth, email, password) {
  const result = fail(await supabase.auth.signInWithPassword({ email, password }));
  return { user: adaptUser(result.user) };
}

export async function createUserWithEmailAndPassword(_auth, email, password) {
  const result = fail(await supabase.auth.signUp({ email, password }));
  if (!result.session) throw new Error('Check your email to confirm your account, then sign in.');
  return { user: adaptUser(result.user) };
}

export async function updateProfile(_user, profile) {
  const result = fail(await supabase.auth.updateUser({ data: {
    ...(profile.displayName ? { full_name: profile.displayName } : {}),
    ...(profile.photoURL ? { avatar_url: profile.photoURL } : {})
  } }));
  return adaptUser(result.user);
}

export class GoogleAuthProvider { constructor() { this.providerId = 'google'; } }
export class FacebookAuthProvider { constructor() { this.providerId = 'facebook'; } }

export async function signInWithPopup(_auth, provider) {
  return signInWithRedirect(_auth, provider);
}

export async function signInWithRedirect(_auth, provider) {
  const providerId = typeof provider === 'string' ? provider : provider.providerId;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: providerId,
    options: { redirectTo: `${location.origin}/auth.html`, skipBrowserRedirect: false }
  });
  if (error) throw error;
}

export async function getRedirectResult() { return null; }
export async function setPersistence() {}
export const browserLocalPersistence = 'local';
export const browserSessionPersistence = 'session';

export async function signInWithPhoneNumber(_auth, phone) {
  const { error } = await supabase.auth.signInWithOtp({ phone });
  if (error) throw error;
  return {
    confirm: async token => {
      const result = fail(await supabase.auth.verifyOtp({ phone, token: String(token), type: 'sms' }));
      return { user: adaptUser(result.user) };
    }
  };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function sendPasswordResetEmail(_auth, email) {
  const response = await fetch(`${apiBaseUrl}/api/request-password-reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Could not send a password reset code.');
  return result;
}

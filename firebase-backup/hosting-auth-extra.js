import { apiBaseUrl } from './supabase.js';
import { toast } from './receipt.js';

export async function forgotPassword(email) {
  try {
    const response = await fetch(`${apiBaseUrl}/api/request-password-reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not request a password reset.');
    toast('If that email is registered, a reset code has been sent.', 'success');
    return true;
  } catch (error) { toast(error.message, 'error'); return false; }
}

export function saveRememberedUser({ email, name }) {
  try {
    localStorage.setItem('hotelPosRememberMe', 'true');
    localStorage.setItem('hotelPosRememberedEmail', email || '');
    localStorage.setItem('hotelPosRememberedName', name || '');
  } catch {}
}
export function loadRememberedUser() {
  try {
    if (localStorage.getItem('hotelPosRememberMe') !== 'true') return null;
    return { email: localStorage.getItem('hotelPosRememberedEmail') || '', name: localStorage.getItem('hotelPosRememberedName') || '' };
  } catch { return null; }
}
export function clearRememberedUser() {
  try {
    localStorage.removeItem('hotelPosRememberMe');
    localStorage.removeItem('hotelPosRememberedEmail');
    localStorage.removeItem('hotelPosRememberedName');
  } catch {}
}

export function passkeySupported() { return false; }
export async function platformAuthenticatorAvailable() { return false; }
export async function createPasskeyAccount() { throw new Error('Passkey sign-in is not configured for Supabase.'); }
export async function loginWithPasskey() { throw new Error('Passkey sign-in is not configured for Supabase.'); }
export async function registerPasskey() { throw new Error('Passkey sign-in is not configured for Supabase.'); }
export async function listPasskeys() { return []; }
export async function deletePasskey() { throw new Error('Passkey sign-in is not configured for Supabase.'); }

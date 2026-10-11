import { auth, functions } from './firebase.js';
import { sendPasswordResetEmail, signInWithCustomToken }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { toast } from './receipt.js';

const rememberedEmailKey = 'hotelPosRememberedEmail';
const rememberedNameKey = 'hotelPosRememberedName';
const rememberEnabledKey = 'hotelPosRememberMe';

export async function forgotPassword(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    toast('Password reset email sent. Check your inbox.', 'success');
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}

export function saveRememberedUser({ email, name }) {
  try {
    localStorage.setItem(rememberEnabledKey, 'true');
    localStorage.setItem(rememberedEmailKey, email || '');
    localStorage.setItem(rememberedNameKey, name || '');
  } catch {}
}

export function loadRememberedUser() {
  try {
    if (localStorage.getItem(rememberEnabledKey) !== 'true') return null;
    return {
      email: localStorage.getItem(rememberedEmailKey) || '',
      name: localStorage.getItem(rememberedNameKey) || ''
    };
  } catch { return null; }
}

export function clearRememberedUser() {
  try {
    localStorage.removeItem(rememberEnabledKey);
    localStorage.removeItem(rememberedEmailKey);
    localStorage.removeItem(rememberedNameKey);
  } catch {}
}

const base64UrlToBytes = value => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
};

const bufferToBase64Url = value => {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const callable = name => httpsCallable(functions, name);

export function passkeySupported() {
  return typeof window.PublicKeyCredential !== 'undefined'
    && typeof navigator.credentials?.create === 'function'
    && typeof navigator.credentials?.get === 'function';
}

export async function platformAuthenticatorAvailable() {
  if (!passkeySupported() || typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
  try { return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}

export async function registerPasskey(user, displayName = '') {
  if (!user?.uid) throw new Error('Sign in before registering a passkey.');
  if (!passkeySupported()) throw new Error('Passkeys are not supported on this device.');

  const challengeResult = await callable('webauthnChallenge')({
    action: 'register', displayName: displayName || user.displayName || user.email
  });
  const { challengeId, ...options } = challengeResult.data;
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: base64UrlToBytes(options.challenge),
      user: { ...options.user, id: base64UrlToBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(item => ({
        ...item, id: base64UrlToBytes(item.id)
      }))
    }
  });
  if (!credential) throw new Error('Passkey registration was cancelled.');

  const response = credential.response;
  const result = await callable('webauthnRegister')({
    challengeId,
    name: displayName || user.displayName || user.email || 'Fingerprint / passkey',
    response: {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        attestationObject: bufferToBase64Url(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : []
      }
    }
  });
  toast('Fingerprint / passkey registered.', 'success');
  return result.data;
}

export async function loginWithPasskey(email) {
  if (!passkeySupported()) throw new Error('Passkeys are not supported on this device.');
  if (!email?.trim()) throw new Error('Enter your account email to use a passkey.');

  const challengeResult = await callable('webauthnChallenge')({
    action: 'authenticate', email: email.trim()
  });
  const { challengeId, ...options } = challengeResult.data;
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: base64UrlToBytes(options.challenge),
      allowCredentials: (options.allowCredentials || []).map(item => ({
        ...item, id: base64UrlToBytes(item.id)
      }))
    }
  });
  if (!assertion) throw new Error('Passkey sign-in was cancelled.');

  const response = assertion.response;
  const verification = await callable('webauthnVerify')({
    challengeId,
    response: {
      id: assertion.id,
      rawId: bufferToBase64Url(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        authenticatorData: bufferToBase64Url(response.authenticatorData),
        signature: bufferToBase64Url(response.signature),
        userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null
      }
    }
  });
  const credential = await signInWithCustomToken(auth, verification.data.customToken);
  toast('Signed in with passkey.', 'success');
  return credential.user;
}

export async function listPasskeys(uid = auth.currentUser?.uid) {
  if (!uid || uid !== auth.currentUser?.uid) throw new Error('Passkeys can only be listed for the signed-in user.');
  const result = await callable('webauthnListPasskeys')({});
  return result.data.passkeys || [];
}

export async function deletePasskey(uid, credentialId) {
  if (!uid || uid !== auth.currentUser?.uid) throw new Error('Passkeys can only be removed by their owner.');
  await callable('webauthnDeletePasskey')({ credentialId });
  toast('Passkey removed.', 'success');
}

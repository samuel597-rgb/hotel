import { auth, db, functions } from './firebase.js';
import {
  createUserWithEmailAndPassword as firebaseCreateUserWithEmailAndPassword,
  signInWithEmailAndPassword as firebaseSignInWithEmailAndPassword,
  updateProfile, onAuthStateChanged, GoogleAuthProvider, FacebookAuthProvider, signInWithPopup,
  signInWithRedirect, getRedirectResult,
  RecaptchaVerifier, signInWithPhoneNumber, setPersistence,
  browserLocalPersistence, browserSessionPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { createPasskeyAccount, loginWithPasskey, platformAuthenticatorAvailable } from './auth-extra.js';
import { registerSession } from './settings-behaviors.js';
import { getUserProfile, saveUserProfile } from './db-service.js';

const $ = id => document.getElementById(id);
let creating = false;
let finishing = false;
let phoneConfirmation = null;
let recaptcha = null;
let passkeysAvailable = false;
let nextAction = 'pos';
const rememberedEmailKey = 'hotelPosRememberedEmail';
const rememberedNameKey = 'hotelPosRememberedName';
const isLocalEmulator = new URLSearchParams(location.search).get('emulator') === 'true';

$('rememberMe').checked = localStorage.getItem('hotelPosRememberMe') === 'true';
if ($('rememberMe').checked) {
  $('email').value = localStorage.getItem(rememberedEmailKey) || '';
  $('fullName').value = localStorage.getItem(rememberedNameKey) || '';
}

async function configurePersistence() {
  await setPersistence(auth, $('rememberMe').checked ? browserLocalPersistence : browserSessionPersistence);
}

function showAuth(mode = 'signin', action = 'pos') {
  nextAction = action;
  $('welcomeState').classList.add('hidden');
  $('authPanel').classList.remove('hidden');
  creating = mode === 'create';
  $('nameFields').classList.toggle('hidden', !creating);
  $('fullName').required = creating;
  $('title').textContent = creating ? 'Create your account' : 'Welcome back';
  $('subtitle').textContent = creating ? 'Enter your name and contact details to get started.' : 'Sign in to continue.';
  $('submitEmail').textContent = creating ? 'Create account' : 'Sign in';
  $('toggleText').textContent = creating ? 'Already have an account? Sign in' : 'New here? Create an account';
  $('password').autocomplete = creating ? 'new-password' : 'current-password';
  $('passkeyCreate').classList.toggle('hidden', !passkeysAvailable || !creating);
  $('passkeyLogin').classList.toggle('hidden', !passkeysAvailable || creating);
}

export async function signInWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signInWithFacebook() {
  return signInWithPopup(auth, new FacebookAuthProvider());
}

export async function signInWithEmailPassword(email, password) {
  return firebaseSignInWithEmailAndPassword(auth, email, password);
}

export async function createUserWithEmailPassword(email, password) {
  return firebaseCreateUserWithEmailAndPassword(auth, email, password);
}

export async function signInWithPhone(phoneNumber) {
  if (!recaptcha) {
    recaptcha = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
    await recaptcha.render();
  }
  return signInWithPhoneNumber(auth, phoneNumber, recaptcha);
}

export async function signInWithPasskey() {
  return loginWithPasskey();
}

export async function createUserWithPasskey(name) {
  return createPasskeyAccount(name);
}

function saveRememberedIdentity(user) {
  if ($('rememberMe').checked) {
    localStorage.setItem('hotelPosRememberMe', 'true');
    localStorage.setItem(rememberedEmailKey, user.email || $('email').value.trim());
    localStorage.setItem(rememberedNameKey, user.displayName || $('fullName').value.trim());
  } else {
    localStorage.removeItem('hotelPosRememberMe');
    localStorage.removeItem(rememberedEmailKey);
    localStorage.removeItem(rememberedNameKey);
  }
}

$('rememberMe').addEventListener('change', () => {
  if (!$('rememberMe').checked) saveRememberedIdentity({});
});

$('togglePassword').addEventListener('click', () => {
  const visible = $('password').type === 'password';
  $('password').type = visible ? 'text' : 'password';
  $('togglePassword').textContent = visible ? '🙈' : '👁️';
  $('togglePassword').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  $('togglePassword').setAttribute('aria-pressed', String(visible));
});

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = `text-sm mt-5 ${error ? 'text-red-600' : 'text-emerald-700'}`;
}
async function finish(user, extra = {}) {
  if (finishing) return;
  finishing = true;
  try {
  saveRememberedIdentity(user);
  await setDoc(doc(db, 'userSettings', user.uid), {
    displayName: user.displayName || '', email: user.email || '', phone: user.phoneNumber || '',
    ...extra, updatedAt: new Date().toISOString()
  }, { merge: true });
  const token = await user.getIdTokenResult();
  await setDoc(doc(db, 'users', user.uid), {
    id: user.uid, name: user.displayName || user.email || 'Customer', email: user.email || '',
    role: token.claims.role || 'customer', status: 'active', updatedAt: new Date().toISOString()
  }, { merge: true });
  await saveUserProfile(user);
  const profile = await getUserProfile(user.uid);
  if (profile) console.info('Loaded profile settings for signed-in user.');
  const sessionId = await registerSession(user.uid);
  sessionStorage.setItem('hotelPosSessionId', sessionId);
  const staff = ['waiter', 'cashier', 'supervisor', 'manager', 'admin'].includes(token.claims.role);
  const emulator = isLocalEmulator ? '?emulator=true' : '';
  const requestedView = nextAction === 'messages' && staff ? 'messages' : (staff ? 'dashboard' : 'pos');
  location.replace(`/app/${emulator}#${requestedView}`);
  } catch (error) {
    finishing = false;
    throw error;
  }
}

onAuthStateChanged(auth, user => {
  if (user && !creating) finish(user).catch(error => status(error.message, true));
});

// Redirect sign-in avoids the Auth Emulator popup iframe relay, which can fail
// when the app and emulator are opened with different loopback hostnames.
getRedirectResult(auth).then(result => {
  if (result?.user) return finish(result.user, { accountType: 'customer' });
}).catch(error => status(error.message, true));

$('showSignIn').addEventListener('click', () => showAuth('signin'));
$('showCreate').addEventListener('click', () => showAuth('create'));
$('orderNow').addEventListener('click', () => showAuth('signin', 'pos'));
$('sendMessage').addEventListener('click', () => showAuth('signin', 'messages'));
$('backWelcome').addEventListener('click', () => {
  $('authPanel').classList.add('hidden');
  $('welcomeState').classList.remove('hidden');
  nextAction = 'pos';
});
$('toggleCreate').addEventListener('click', () => showAuth(creating ? 'signin' : 'create', nextAction));

$('emailForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('submitEmail').disabled = true;
  try {
    await configurePersistence();
    const email = $('email').value.trim();
    const password = $('password').value;
    if (creating) {
      const fullName = $('fullName').value.trim().replace(/\s+/g, ' ');
      if (fullName.split(' ').length < 2) throw new Error('Enter your first and last names.');
      const credential = await createUserWithEmailPassword(email, password);
      await updateProfile(credential.user, { displayName: fullName });
      await finish(credential.user, { displayName: fullName, phone: $('phone').value.trim(), accountType: 'customer' });
    } else {
      const credential = await signInWithEmailPassword(email, password);
      await finish(credential.user);
    }
  } catch (error) { status(error.message, true); }
  finally { $('submitEmail').disabled = false; }
});

const forgotModal = $('forgotModal');
$('forgot').addEventListener('click', () => {
  $('forgotEmail').value = $('email').value.trim();
  forgotModal.classList.remove('hidden');
  forgotModal.classList.add('flex');
  $('forgotEmail').focus();
});
$('forgotCancel').addEventListener('click', () => {
  forgotModal.classList.add('hidden');
  forgotModal.classList.remove('flex');
});
forgotModal.addEventListener('click', event => {
  if (event.target === forgotModal) $('forgotCancel').click();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !forgotModal.classList.contains('hidden')) $('forgotCancel').click();
});
$('forgotSubmit').addEventListener('click', async () => {
  const email = $('forgotEmail').value.trim();
  if (!email) return status('Enter your email address first.', true);
  $('forgotSubmit').disabled = true;
  try {
    await httpsCallable(functions, 'requestPasswordReset')({ email });
    $('forgotCancel').click();
    status('Password reset link sent. Check your inbox.');
  } catch (error) { status(error.message, true); }
  finally { $('forgotSubmit').disabled = false; }
});

platformAuthenticatorAvailable().then(available => {
  passkeysAvailable = available;
  $('passkeyLogin').classList.toggle('hidden', !available || creating);
  $('passkeyCreate').classList.toggle('hidden', !available || !creating);
}).catch(() => {
  $('passkeyLogin').classList.add('hidden');
  $('passkeyCreate').classList.add('hidden');
});

$('passkeyLogin').addEventListener('click', async () => {
  $('passkeyLogin').disabled = true;
  try {
    await configurePersistence();
    const user = await signInWithPasskey();
    await finish(user);
  } catch (error) { status(error.message, true); }
  finally { $('passkeyLogin').disabled = false; }
});

$('passkeyCreate').addEventListener('click', async () => {
  const name = $('fullName').value.trim().replace(/\s+/g, ' ');
  if (name.split(' ').length < 2) return status('Enter your first and last names to create a passkey account.', true);
  $('passkeyCreate').disabled = true;
  try {
    const user = await createUserWithPasskey(name);
    await finish(user, { displayName: name, accountType: 'customer' });
  } catch (error) { status(error.message, true); }
  finally { $('passkeyCreate').disabled = false; }
});

$('google').addEventListener('click', async () => {
  try {
    await configurePersistence();
    if (isLocalEmulator) return signInWithRedirect(auth, new GoogleAuthProvider());
    const result = await signInWithGoogle();
    await finish(result.user, { accountType: 'customer' });
  } catch (error) { status(error.message, true); }
});
$('facebook').addEventListener('click', async () => {
  try {
    await configurePersistence();
    if (isLocalEmulator) return signInWithRedirect(auth, new FacebookAuthProvider());
    const result = await signInWithFacebook();
    await finish(result.user, { accountType: 'customer' });
  } catch (error) { status(error.message, true); }
});

$('phoneToggle').addEventListener('click', () => $('phonePanel').classList.toggle('hidden'));
$('sendCode').addEventListener('click', async () => {
  try {
    await configurePersistence();
    phoneConfirmation = await signInWithPhone($('phoneNumber').value.trim());
    $('smsCode').classList.remove('hidden');
    $('verifyCode').classList.remove('hidden');
    status('Verification code sent by SMS.');
  } catch (error) { status(error.message, true); recaptcha?.clear(); recaptcha = null; }
});
$('verifyCode').addEventListener('click', async () => {
  if (!phoneConfirmation) return;
  try {
    const credential = await phoneConfirmation.confirm($('smsCode').value.trim());
    let displayName = credential.user.displayName;
    if (!displayName) {
      displayName = prompt('Enter your first and last names to finish creating your account:')?.trim();
      if (!displayName || displayName.split(/\s+/).length < 2) return status('Please provide your first and last names.', true);
      await updateProfile(credential.user, { displayName });
    }
    await finish(credential.user, { displayName, accountType: 'customer' });
  } catch (error) { status(error.message, true); }
});

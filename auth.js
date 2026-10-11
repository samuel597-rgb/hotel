import { auth, db } from './firebase.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail,
  updateProfile, onAuthStateChanged, GoogleAuthProvider, FacebookAuthProvider, signInWithPopup,
  signInWithRedirect, getRedirectResult,
  RecaptchaVerifier, signInWithPhoneNumber, setPersistence,
  browserLocalPersistence, browserSessionPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { loginWithPasskey, platformAuthenticatorAvailable } from './auth-extra.js';
import { registerSession } from './settings-behaviors.js';

const $ = id => document.getElementById(id);
let creating = false;
let finishing = false;
let phoneConfirmation = null;
let recaptcha = null;
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
  const sessionId = await registerSession(user.uid);
  sessionStorage.setItem('hotelPosSessionId', sessionId);
  const staff = ['waiter', 'cashier', 'supervisor', 'manager', 'admin'].includes(token.claims.role);
  const emulator = isLocalEmulator ? '?emulator=true' : '';
  location.replace(`/app/${emulator}#${staff ? 'dashboard' : 'pos'}`);
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

$('toggleCreate').addEventListener('click', () => {
  creating = !creating;
  $('nameFields').classList.toggle('hidden', !creating);
  $('fullName').required = creating;
  $('title').textContent = creating ? 'Create your account' : 'Welcome back';
  $('subtitle').textContent = creating ? 'Enter your name and contact details to get started.' : 'Sign in to continue to your order.';
  $('submitEmail').textContent = creating ? 'Create account' : 'Sign in';
  $('toggleText').textContent = creating ? 'Already have an account? Sign in' : 'New here? Create an account';
  $('password').autocomplete = creating ? 'new-password' : 'current-password';
});

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
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(credential.user, { displayName: fullName });
      await finish(credential.user, { displayName: fullName, phone: $('phone').value.trim(), accountType: 'customer' });
    } else {
      const credential = await signInWithEmailAndPassword(auth, email, password);
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
    await sendPasswordResetEmail(auth, email);
    $('forgotCancel').click();
    status('Password reset link sent. Check your inbox.');
  } catch (error) { status(error.message, true); }
  finally { $('forgotSubmit').disabled = false; }
});

platformAuthenticatorAvailable().then(available => {
  $('passkeyLogin').classList.toggle('hidden', !available);
}).catch(() => $('passkeyLogin').classList.add('hidden'));

$('passkeyLogin').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) return status('Enter your email first so we can find your passkey.', true);
  $('passkeyLogin').disabled = true;
  try {
    await configurePersistence();
    const user = await loginWithPasskey(email);
    await finish(user);
  } catch (error) { status(error.message, true); }
  finally { $('passkeyLogin').disabled = false; }
});

for (const [id, Provider] of [['google', GoogleAuthProvider], ['facebook', FacebookAuthProvider]]) {
  $(id).addEventListener('click', async () => {
    try {
      await configurePersistence();
      const provider = new Provider();
      if (isLocalEmulator) {
        await signInWithRedirect(auth, provider);
        return;
      }
      const result = await signInWithPopup(auth, provider);
      await finish(result.user, { accountType: 'customer' });
    } catch (error) { status(error.message, true); }
  });
}

$('phoneToggle').addEventListener('click', () => $('phonePanel').classList.toggle('hidden'));
$('sendCode').addEventListener('click', async () => {
  try {
    await configurePersistence();
    if (!recaptcha) {
      recaptcha = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
      await recaptcha.render();
    }
    phoneConfirmation = await signInWithPhoneNumber(auth, $('phoneNumber').value.trim(), recaptcha);
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

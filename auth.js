import { auth, setSessionPersistence } from './supabase.js';
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile,
  onAuthStateChanged, GoogleAuthProvider, FacebookAuthProvider, signInWithRedirect,
  signInWithPhoneNumber, signOut
} from './supabase-auth.js';
import { httpsCallable, doc, setDoc } from './supabase-data.js';
import { registerSession } from './settings-behaviors.js';
import { getUserProfile, saveUserProfile } from './db-service.js';

const $ = id => document.getElementById(id);
let creating = false;
let finishing = false;
let phoneConfirmation = null;
let nextAction = 'pos';
const rememberedEmailKey = 'hotelPosRememberedEmail';
const rememberedNameKey = 'hotelPosRememberedName';

$('rememberMe').checked = localStorage.getItem('hotelPosRememberMe') === 'true';
if ($('rememberMe').checked) {
  $('email').value = localStorage.getItem(rememberedEmailKey) || '';
  $('fullName').value = localStorage.getItem(rememberedNameKey) || '';
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
}

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = `text-sm mt-5 ${error ? 'text-red-600' : 'text-emerald-700'}`;
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
  setSessionPersistence($('rememberMe').checked);
  if (!$('rememberMe').checked) saveRememberedIdentity({});
});
$('togglePassword').addEventListener('click', () => {
  const visible = $('password').type === 'password';
  $('password').type = visible ? 'text' : 'password';
  $('togglePassword').textContent = visible ? '🙈' : '👁️';
  $('togglePassword').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  $('togglePassword').setAttribute('aria-pressed', String(visible));
});

async function finish(user, extra = {}) {
  if (finishing) return;
  finishing = true;
  try {
    saveRememberedIdentity(user);
    const name = user.displayName || extra.displayName || user.email || 'Customer';
    await setDoc(doc(null, 'userSettings', user.uid), {
      displayName: name, email: user.email || '', phone: user.phoneNumber || '',
      ...extra, updatedAt: new Date().toISOString()
    }, { merge: true });
    const { claims } = await user.getIdTokenResult();
    await setDoc(doc(null, 'users', user.uid), {
      id: user.uid, name, email: user.email || '', role: claims.role || 'customer',
      status: 'active', updatedAt: new Date().toISOString()
    }, { merge: true });
    await saveUserProfile(user);
    await getUserProfile(user.uid);
    const sessionId = await registerSession(user.uid);
    sessionStorage.setItem('hotelPosSessionId', sessionId);
    const staff = ['waiter', 'cashier', 'supervisor', 'manager', 'admin'].includes(claims.role);
    const requestedView = nextAction === 'messages' && staff ? 'messages' : (staff ? 'dashboard' : 'pos');
    location.replace(`/app/#${requestedView}`);
  } catch (error) {
    finishing = false;
    throw error;
  }
}

onAuthStateChanged(auth, user => {
  if (user && !creating) finish(user).catch(error => status(error.message, true));
});

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
forgotModal.addEventListener('click', event => { if (event.target === forgotModal) $('forgotCancel').click(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !forgotModal.classList.contains('hidden')) $('forgotCancel').click();
});
$('forgotSubmit').addEventListener('click', async () => {
  const email = $('forgotEmail').value.trim();
  if (!email) return status('Enter your email address first.', true);
  $('forgotSubmit').disabled = true;
  try {
    await httpsCallable(null, 'request-password-reset')({ email });
    $('forgotCancel').click();
    location.href = `/reset-password.html?email=${encodeURIComponent(email)}`;
  } catch (error) { status(error.message, true); }
  finally { $('forgotSubmit').disabled = false; }
});

$('google').addEventListener('click', async () => {
  try { await signInWithRedirect(auth, new GoogleAuthProvider()); }
  catch (error) { status(error.message, true); }
});
$('facebook').addEventListener('click', async () => {
  try { await signInWithRedirect(auth, new FacebookAuthProvider()); }
  catch (error) { status(error.message, true); }
});
$('phoneToggle').addEventListener('click', () => $('phonePanel').classList.toggle('hidden'));
$('sendCode').addEventListener('click', async () => {
  try {
    phoneConfirmation = await signInWithPhoneNumber(auth, $('phoneNumber').value.trim());
    $('smsCode').classList.remove('hidden');
    $('verifyCode').classList.remove('hidden');
    status('Verification code sent by SMS.');
  } catch (error) { status(error.message, true); }
});
$('verifyCode').addEventListener('click', async () => {
  if (!phoneConfirmation) return;
  creating = true;
  try {
    const credential = await phoneConfirmation.confirm($('smsCode').value.trim());
    let displayName = credential.user.displayName;
    if (!displayName) {
      displayName = prompt('Enter your first and last names to finish creating your account:')?.trim();
      if (!displayName || displayName.split(/\s+/).length < 2) {
        creating = false;
        await signOut();
        return status('Please provide your first and last names, then sign in again.', true);
      }
      await updateProfile(credential.user, { displayName });
    }
    creating = false;
    await finish(credential.user, { displayName, accountType: 'customer' });
  } catch (error) { creating = false; status(error.message, true); }
});

// Keep the existing public client names used by the onboarding page.
export { signInWithEmailAndPassword as signInWithEmailPassword, createUserWithEmailAndPassword as createUserWithEmailPassword };

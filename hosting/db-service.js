import { rtdb } from './firebase.js';
import { get, ref, serverTimestamp, update } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

// Profiles are scoped by the Firebase Authentication UID. The Realtime
// Database rules enforce that users can only read and write their own record.
export async function saveUserProfile(user) {
  if (!user?.uid) throw new Error('A signed-in user is required to save a profile.');
  try {
    await update(ref(rtdb, `users/${user.uid}`), {
      displayName: user.displayName || 'Anonymous Guest',
      email: user.email || null,
      lastLogin: serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('User profile write failed:', error);
    return false;
  }
}

export async function getUserProfile(uid) {
  if (!uid) throw new Error('A user UID is required to read a profile.');
  try {
    const snapshot = await get(ref(rtdb, `users/${uid}`));
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.error('User profile read failed:', error);
    return null;
  }
}

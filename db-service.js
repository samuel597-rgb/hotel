import { doc, getDoc, setDoc } from './local-data.js';

export async function saveUserProfile(user) {
  if (!user?.uid) throw new Error('A signed-in user is required to save a profile.');
  const profileRef = doc(null, 'users', user.uid);
  const previous = await getDoc(profileRef);
  await setDoc(profileRef, {
    ...(previous.exists() ? previous.data() : {}),
    id: user.uid,
    name: user.displayName || 'Anonymous Guest',
    email: user.email || null,
    lastLogin: new Date().toISOString()
  });
  return true;
}

export async function getUserProfile(uid) {
  if (!uid) throw new Error('A user ID is required to read a profile.');
  const snapshot = await getDoc(doc(null, 'users', uid));
  return snapshot.exists() ? snapshot.data() : null;
}

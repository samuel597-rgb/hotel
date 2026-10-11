const admin = require('firebase-admin');

const onEmulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (onEmulator) {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'hoteli-cd840' });
  console.log('[set-role] Using AUTH EMULATOR at', process.env.FIREBASE_AUTH_EMULATOR_HOST);
} else {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  console.log('[set-role] Using PRODUCTION credentials');
}

const [, , uid, role = 'manager'] = process.argv;
const allowedRoles = ['waiter', 'supervisor', 'manager', 'admin'];

if (!uid || uid.startsWith('<')) {
  console.error('Usage: node set-role.js <UID> <role>');
  console.error('Example: node set-role.js AbCdEf123 manager');
  process.exit(1);
}

if (!allowedRoles.includes(role)) {
  console.error(`Invalid role. Must be: ${allowedRoles.join(', ')}`);
  process.exit(1);
}

(async () => {
  try {
    const user = await admin.auth().getUser(uid);
    console.log(`[set-role] Found user: ${user.email || user.uid}`);

    // Preserve any other custom claims while changing the role.
    await admin.auth().setCustomUserClaims(uid, { ...user.customClaims, role });

    const updated = await admin.auth().getUser(uid);
    console.log(`[set-role] Role "${role}" set for ${updated.email || uid}`);
    console.log('[set-role] Custom claims:', JSON.stringify(updated.customClaims));
    console.log('[set-role] The user must sign out and back in to refresh the role claim.');
    process.exit(0);
  } catch (err) {
    console.error('[set-role] Failed:', err.message);
    if (err.code === 'auth/user-not-found') {
      console.error('[set-role] Check that the UID exists in the selected project.');
    }
    if (err.message.includes('Could not load the default credentials')) {
      console.error('[set-role] Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON file.');
    }
    process.exit(1);
  }
})();

'use strict';

// Usage: node set-user-role.js <email-or-uid> <waiter|cashier|supervisor|manager|admin>
require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');

const [account, role] = process.argv.slice(2);
const validRoles = new Set(['waiter', 'cashier', 'supervisor', 'manager', 'admin']);
if (!account || !validRoles.has(role)) {
  console.error('Usage: node set-user-role.js <email-or-uid> <waiter|cashier|supervisor|manager|admin>');
  process.exit(2);
}

try {
  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  } else {
    const serviceAccount = require(path.resolve(keyPath));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (error) {
  console.error('Could not load Firebase Admin credentials:', error.message);
  process.exit(1);
}

const userLookup = account.includes('@') ? admin.auth().getUserByEmail(account) : admin.auth().getUser(account);
userLookup
  .then(async user => {
    await admin.auth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), role });
    await admin.firestore().collection('users').doc(user.uid).set({
      id: user.uid, name: user.displayName || user.email || 'Staff', email: user.email || '',
      role, status: user.disabled ? 'disabled' : 'active', updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  })
  .then(() => console.log(`Assigned ${role} to Firebase user ${account}. The user must sign out and back in for the new role to apply.`))
  .catch(error => { console.error('Role assignment failed:', error.message); process.exitCode = 1; })
  .finally(() => admin.app().delete());

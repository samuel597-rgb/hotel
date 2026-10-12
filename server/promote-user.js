import { db } from './sqlite.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const role = String(process.argv[3] || 'manager').trim().toLowerCase();
const allowed = new Set(['waiter','cashier','supervisor','manager','admin']);
if (!email || !allowed.has(role)) {
  console.error('Usage: npm run promote -- <account-email> [waiter|cashier|supervisor|manager|admin]');
  process.exitCode = 2;
} else {
  const result = db.prepare('UPDATE auth_users SET role=? WHERE email=? COLLATE NOCASE').run(role, email);
  if (!result.changes) {
    console.error('No local account found for that email. Create the account first.');
    process.exitCode = 1;
  } else console.log(`Updated ${email} to role ${role}.`);
}

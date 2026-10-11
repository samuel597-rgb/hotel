const admin = require('firebase-admin');
const readline = require('node:readline');

const uid = process.argv[2];
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

if (!uid) {
  console.error('Usage: node auth-emulator-adduser.js <uid> [email]');
  process.exit(1);
}
if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(authHost)) {
  console.error('Refusing to connect to non-local Auth host:', authHost);
  process.exit(1);
}

process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
const projectId = process.env.GCLOUD_PROJECT || 'hoteli-cd840';
admin.initializeApp({ projectId });
const auth = admin.auth();

function promptEmail() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Email: ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword() {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Run this script in an interactive terminal to enter the password safely.'));
      return;
    }

    const password = [];
    output.write('Password (hidden): ');
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
    };
    const onData = chunk => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (byte === 10 || byte === 13) {
          cleanup();
          resolve(Buffer.from(password).toString('utf8'));
          return;
        }
        if (byte === 8 || byte === 127) {
          password.pop();
        } else {
          password.push(byte);
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function addUser() {
  const email = (process.argv[3] || await promptEmail()).trim();
  if (!email) throw new Error('Email is required.');

  const password = await promptPassword();
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');

  let user;
  try {
    user = await auth.getUser(uid);
    if (user.email?.toLowerCase() !== email.toLowerCase()) {
      throw new Error(`UID already exists with a different email: ${user.email || '(none)'}`);
    }
    user = await auth.updateUser(uid, { password, emailVerified: true });
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    user = await auth.createUser({ uid, email, password, emailVerified: true });
  }

  await auth.setCustomUserClaims(uid, { ...user.customClaims, role: 'manager' });
  console.log(`Auth emulator user ready: ${uid} (${email}), role=manager`);
}

addUser()
  .catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => admin.app().delete());

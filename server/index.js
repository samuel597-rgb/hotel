import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { db, deleteRecord, deleteSession, findUserByToken, issueSession, readRecords, writeRecord } from './sqlite.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../hosting');
const allowedOrigins = new Set([
  'http://localhost:3000', 'http://localhost:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
]);
const scrypt = promisify(crypto.scrypt);
const safeEmail = value => String(value || '').trim().toLowerCase();
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const validRecordId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : crypto.randomUUID();
const jsonResponse = (res, status, payload) => res.status(status).json(payload);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin(origin, done) {
  if (!origin || allowedOrigins.has(origin)) return done(null, true);
  return done(new Error('Origin is not allowed by CORS.'));
} }));
app.use(express.json({ limit: '1mb' }));

function bearerToken(req) { return /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1] || ''; }
function requireAuth(req, res, next) {
  req.user = bearerToken(req) ? findUserByToken(bearerToken(req)) : null;
  if (!req.user) return jsonResponse(res, 401, { error: 'Your sign-in session is invalid or expired.' });
  return next();
}
function optionalAuth(req, _res, next) {
  req.user = bearerToken(req) ? findUserByToken(bearerToken(req)) : null;
  return next();
}
function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next()
    : jsonResponse(res, 403, { error: 'You do not have permission to perform this action.' });
}
function userSummary(user) {
  const name = user.name || user.user_metadata?.full_name || '';
  return { id: user.id, uid: user.id, email: user.email, role: user.role,
    displayName: name, phoneNumber: user.phone || user.user_metadata?.phone || '', photoURL: user.photo_url || user.user_metadata?.avatar_url || '',
    user_metadata: { full_name: name, phone: user.phone || user.user_metadata?.phone || '', avatar_url: user.photo_url || user.user_metadata?.avatar_url || '' } };
}
async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
async function ensureDemoStaffAccounts() {
  const accounts = [
    { email: 'demo-admin@hoteli.local', name: 'Admin 1', password: 'admin@1234', role: 'admin' },
    { email: 'demo-employee@hoteli.local', name: 'Employee 1', password: 'emplo@1234', role: 'waiter' }
  ];
  for (const account of accounts) {
    const passwordHash = await createPasswordHash(account.password);
    db.prepare(`INSERT INTO auth_users(id,email,name,password_hash,role) VALUES(?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role=excluded.role`)
      .run(`demo-${account.role}`, account.email, account.name, passwordHash, account.role);
  }
}
async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const candidate = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function getStoredUser(email) { return db.prepare('SELECT * FROM auth_users WHERE email = ? COLLATE NOCASE').get(email); }
function publicPath(pathname, id) {
  return pathname === 'products' || pathname === 'categories' || (pathname === 'settings' && id === 'general');
}
function pathOwner(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (['users', 'userSettings', 'settings'].includes(parts[0]) && parts[1]) return parts[1];
  return null;
}
function recordOwner(pathname, id) {
  return pathOwner(pathname) || (id && ['users', 'userSettings', 'settings'].includes(pathname) ? id : null);
}
function checkRecordRead(req, res, pathname, id) {
  if (publicPath(pathname, id)) return true;
  if (!req.user) return jsonResponse(res, 401, { error: 'Sign in to access this data.' }), false;
  const owner = recordOwner(pathname, id);
  if (['users', 'userSettings', 'settings'].includes(pathname) && !id) return jsonResponse(res, 403, { error: 'A specific account record is required.' }), false;
  if (owner && owner !== req.user.id) return jsonResponse(res, 403, { error: 'You cannot access another user’s data.' }), false;
  if (['messages', 'typing', 'mpesa_payments'].includes(pathname)
      && !['waiter','cashier','supervisor','manager','admin'].includes(req.user.role)) {
    return jsonResponse(res, 403, { error: 'This record collection is limited to staff accounts.' }), false;
  }
  return true;
}

const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/auth/signup', loginLimiter, asyncRoute(async (req, res) => {
  const email = safeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const name = String(req.body?.displayName || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128 || name.length < 2) {
    return jsonResponse(res, 400, { error: 'Enter a valid email, a name, and a password of at least 8 characters.' });
  }
  if (getStoredUser(email)) return jsonResponse(res, 409, { error: 'An account with this email already exists.' });
  const id = crypto.randomUUID();
  const passwordHash = await createPasswordHash(password);
  try {
    db.prepare('INSERT INTO auth_users(id,email,name,password_hash,role) VALUES(?,?,?,?,?)')
      .run(id, email, name, passwordHash, 'customer');
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return jsonResponse(res, 409, { error: 'An account with this email already exists.' });
    throw error;
  }
  const row = db.prepare('SELECT * FROM auth_users WHERE id=?').get(id);
  const token = issueSession(id);
  writeRecord('users', id, { id, name, email, role: 'customer', status: 'active', updatedAt: new Date().toISOString() }, id);
  return jsonResponse(res, 201, { token, user: userSummary(row) });
}));

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const identifier = safeEmail(req.body?.username || req.body?.email);
  const demoAccounts = { 'admin 1': 'demo-admin@hoteli.local', 'employee 1': 'demo-employee@hoteli.local' };
  const email = demoAccounts[identifier] || identifier;
  const password = String(req.body?.password || '');
  const row = getStoredUser(email);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return jsonResponse(res, 401, { error: 'Email or password is incorrect.' });
  }
  const token = issueSession(row.id);
  return jsonResponse(res, 200, { token, user: userSummary(row) });
}));

app.get('/api/auth/session', requireAuth, (req, res) => jsonResponse(res, 200, { user: userSummary(req.user) }));
app.post('/api/auth/logout', (req, res) => {
  const token = bearerToken(req);
  if (token) deleteSession(token);
  return res.json({ success: true });
});
app.post(['/api/request-password-reset', '/api/complete-password-reset'], (_req, res) =>
  jsonResponse(res, 501, { error: 'Email password reset is not available in the local SQLite demo.' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', database: 'sqlite' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'sqlite' }));
app.get('/runtime-config.json', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ database: 'sqlite', apiBaseUrl: process.env.PUBLIC_API_URL || '' });
});
app.get('/api/me', requireAuth, (req, res) => {
  const profile = readRecords('users', { id: req.user.id, ownerId: req.user.id })[0]?.data || null;
  return res.json({ user: userSummary(req.user), role: req.user.role, profile });
});

app.get('/api/products', (req, res) => {
  const rows = readRecords('products');
  return res.json(rows.map(row => ({ id: row.id, ...row.data })).filter(item => item.isAvailable !== false));
});

app.get('/api/records', (req, res) => {
  const token = bearerToken(req);
  req.user = token ? findUserByToken(token) : null;
  const pathname = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
  const id = req.query.id ? String(req.query.id) : null;
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,4}$/.test(pathname)) return jsonResponse(res, 400, { error: 'Invalid record path.' });
  if (!checkRecordRead(req, res, pathname, id)) return;
  const privateCollection = ['users', 'userSettings'].includes(pathname.split('/')[0]);
  let rows = readRecords(pathname, { id, ownerId: privateCollection ? req.user?.id : undefined });
  if (pathname === 'orders' && req.user) {
    if (req.user.role === 'customer') rows = rows.filter(row => row.data.customerId === req.user.id);
    if (req.user.role === 'waiter') rows = rows.filter(row => row.data.waiterId === req.user.id);
    if (['cashier','supervisor'].includes(req.user.role)) rows = rows.filter(row => row.data.paymentStatus === 'pending');
  }
  return res.json({ records: rows });
});

app.post('/api/records', requireAuth, (req, res) => {
  const pathname = String(req.body?.path || '');
  const id = String(req.body?.id || '');
  const data = req.body?.data;
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,4}$/.test(pathname) || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !data || typeof data !== 'object' || Array.isArray(data)) {
    return jsonResponse(res, 400, { error: 'Invalid record.' });
  }
  if ((pathname === 'products' || (pathname === 'settings' && id === 'general'))
      && !['manager','admin'].includes(req.user.role)) return jsonResponse(res, 403, { error: 'Manager access is required.' });
  const owner = recordOwner(pathname, id);
  if (owner && owner !== req.user.id) return jsonResponse(res, 403, { error: 'You cannot edit another user’s data.' });
  if (['orders','messages','mpesa_payments'].includes(pathname)) return jsonResponse(res, 400, { error: 'Use the POS API endpoint for this record type.' });
  if (pathname === 'users') {
    if (id !== req.user.id) return jsonResponse(res, 403, { error: 'You cannot edit another user’s profile.' });
    data.role = req.user.role;
  }
  if (pathname === 'userSettings' && id !== req.user.id) return jsonResponse(res, 403, { error: 'You cannot edit another user’s settings.' });
  writeRecord(pathname, id, data, owner || req.user.id);
  return jsonResponse(res, 200, { success: true, id });
});
app.delete('/api/records', requireAuth, (req, res) => {
  const pathname = String(req.query.path || '');
  const id = String(req.query.id || '');
  const owner = recordOwner(pathname, id);
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,4}$/.test(pathname) || !id) return jsonResponse(res, 400, { error: 'Invalid record.' });
  if (pathname === 'products' || (pathname === 'settings' && id === 'general')) {
    if (!['manager','admin'].includes(req.user.role)) return jsonResponse(res, 403, { error: 'Manager access is required.' });
  }
  if (owner && owner !== req.user.id) return jsonResponse(res, 403, { error: 'You cannot delete another user’s data.' });
  deleteRecord(pathname, id);
  return res.json({ success: true });
});

app.get('/api/orders', requireAuth, (req, res) => {
  let rows = readRecords('orders');
  if (req.user.role === 'customer') rows = rows.filter(row => row.data.customerId === req.user.id);
  if (req.user.role === 'waiter') rows = rows.filter(row => row.data.waiterId === req.user.id);
  if (['cashier','supervisor'].includes(req.user.role)) rows = rows.filter(row => row.data.paymentStatus === 'pending');
  return res.json(rows.map(row => ({ id: row.id, ...row.data })).filter(order => !order.archivedAt)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)));
});
app.post('/api/orders', optionalAuth, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 100) return jsonResponse(res, 400, { error: 'An order must contain between 1 and 100 items.' });
  const lines = [];
  let subtotal = 0;
  for (const item of items) {
    const productId = String(item.productId || item.id || '');
    const quantity = Number(item.qty ?? item.quantity);
    const product = readRecords('products', { id: productId })[0]?.data;
    if (!productId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1000 || !product || product.isAvailable === false) {
      return jsonResponse(res, 400, { error: 'An order item, quantity, or availability is invalid.' });
    }
    const price = Number(product.price);
    const lineTotal = price * quantity;
    subtotal += lineTotal;
    lines.push({ id: crypto.randomUUID(), productId, name: product.name, qty: quantity, quantity, price, subtotal: lineTotal });
  }
  const settings = readRecords('settings', { id: 'general' })[0]?.data || {};
  const tax = subtotal * Math.max(0, Number(settings.taxRate) || 0) / 100;
  const tip = Math.max(0, Number(req.body.tip) || 0);
  const id = validRecordId(req.body.clientWriteId);
  const role = req.user?.role || 'customer';
  const order = { id, table: String(req.body.table || '').slice(0, 40), guests: Math.max(1, Math.min(100, Number(req.body.guests || 1))),
    customer: String(req.body.customer || (req.user?.user_metadata.full_name || '')).slice(0, 120), customerId: role === 'customer' ? req.user?.id || null : null,
    waiterId: role === 'customer' ? null : req.user.id,
    waiterName: String(req.user?.user_metadata.full_name || req.user?.email || 'Guest customer').slice(0, 120),
    status: 'pending', paymentStatus: 'pending', paymentMethod: ['cash','card','mpesa','stripe'].includes(req.body.paymentMethod) ? req.body.paymentMethod : 'cash',
    subtotal, tax, tip, total: subtotal + tax + tip, currency: 'KES', rating: Math.max(0, Math.min(5, Number(req.body.rating) || 0)),
    feedback: String(req.body.feedback || '').slice(0, 2000), feedbackImageUrl: String(req.body.feedbackImageUrl || '').slice(0, 2000),
    createdAt: new Date().toISOString(), lines };
  writeRecord('orders', id, order, req.user?.id || null);
  return jsonResponse(res, 201, { success: true, id, orderId: id, order, lines, synced: true });
});
app.patch('/api/orders/:id/payment', requireAuth, allowRoles('cashier','supervisor','manager','admin'), (req, res) => {
  const row = readRecords('orders', { id: req.params.id })[0];
  if (!row) return jsonResponse(res, 404, { error: 'Order not found.' });
  if (row.data.paymentStatus === 'paid') return jsonResponse(res, 409, { error: 'This order is already paid.' });
  writeRecord('orders', req.params.id, { ...row.data, status: 'paid', paymentStatus: 'paid', paymentMethod: req.body?.paymentMethod || 'cash', paidAt: new Date().toISOString() }, row.owner_id);
  return res.json({ success: true });
});
app.patch('/api/orders/:id/archive', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const row = readRecords('orders', { id: req.params.id })[0];
  if (!row) return jsonResponse(res, 404, { error: 'Order not found.' });
  writeRecord('orders', req.params.id, { ...row.data, archivedAt: new Date().toISOString() }, row.owner_id);
  return res.json({ success: true });
});
app.post('/api/messages', requireAuth, allowRoles('waiter','cashier','supervisor','manager','admin'), (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 4000) return jsonResponse(res, 400, { error: 'Message must contain 1 to 4000 characters.' });
  const id = validRecordId(req.body?.clientWriteId);
  const data = { id, team: String(req.body?.team || 'Front of House').slice(0, 80), text, message: text,
    read: false, fromUid: req.user.id, fromName: String(req.user.user_metadata.full_name || req.user.email || 'Staff').slice(0, 120), createdAt: new Date().toISOString() };
  writeRecord('messages', id, data, req.user.id);
  return jsonResponse(res, 201, { success: true, id, data });
});
app.post('/api/products', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const name = String(req.body?.name || '').trim(), price = Number(req.body?.price), categoryId = String(req.body?.categoryId || '');
  if (!name || !categoryId || !Number.isFinite(price) || price < 0) return jsonResponse(res, 400, { error: 'Name, category, and a non-negative price are required.' });
  const id = validRecordId(req.body.clientWriteId);
  writeRecord('products', id, { ...req.body, id, name, price, categoryId, isAvailable: req.body.isAvailable !== false, createdAt: new Date().toISOString() }, req.user.id);
  return jsonResponse(res, 201, { success: true, id });
});
app.put('/api/products/:id', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const previous = readRecords('products', { id: req.params.id })[0];
  if (!previous) return jsonResponse(res, 404, { error: 'Product not found.' });
  writeRecord('products', req.params.id, { ...previous.data, ...req.body, id: req.params.id }, null);
  return res.json({ success: true, id: req.params.id });
});
app.put('/api/settings/general', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const data = { id: 'general', hotelName: String(req.body?.hotelName || 'HOTELI POA').slice(0, 120), currency: 'KES', taxRate: Math.max(0, Math.min(100, Number(req.body?.taxRate) || 0)) };
  writeRecord('settings', 'general', data);
  return res.json({ success: true });
});
app.patch('/api/profile', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!name) return jsonResponse(res, 400, { error: 'A profile name is required.' });
  const phone = String(req.body?.phone || '').slice(0, 40), photoURL = String(req.body?.photoURL || '').slice(0, 2000);
  db.prepare('UPDATE auth_users SET name=?, phone=?, photo_url=? WHERE id=?').run(name, phone, photoURL, req.user.id);
  const updated = db.prepare('SELECT * FROM auth_users WHERE id=?').get(req.user.id);
  const user = userSummary(updated);
  const profile = { id: req.user.id, name, email: req.user.email, phone, photoURL, role: req.user.role, status: 'active', updatedAt: new Date().toISOString() };
  writeRecord('users', req.user.id, profile, req.user.id);
  return res.json({ success: true, user, profile });
});

app.post(['/api/createStripeCheckoutSession', '/api/initiateMpesaPayment'], (_req, res) =>
  jsonResponse(res, 501, { error: 'External payments are disabled in the free SQLite demo.' }));

// TODO: Re-enable Firebase only behind an explicit feature flag after the SQLite demo.
if (process.env.USE_FIREBASE === 'true') console.warn('USE_FIREBASE is ignored; Firebase has no active adapter.');

await ensureDemoStaffAccounts();

app.get(['/','/index.html','/auth.html'], (_req, res) => res.sendFile(path.join(webRoot, 'app/index.html')));
app.get(['/app','/app/'], (_req, res) => res.sendFile(path.join(webRoot, 'app/index.html')));
app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
app.use((error, _req, res, _next) => {
  console.error('Request failed:', error?.message || error);
  if (res.headersSent) return;
  return res.status(error.status || 500).json({ error: error.status ? error.message : 'The request could not be completed.' });
});

app.listen(port, () => console.log(`HOTELI POA SQLite demo listening on ${port}; database ${process.env.DB_PATH || './hoteli_poa.db'}`));

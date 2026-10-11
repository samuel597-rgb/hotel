import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import axios from 'axios';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../hosting');
const allowedOrigins = new Set([
  'http://localhost:3000', 'http://localhost:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  process.env.SITE_URL
].filter(Boolean));
const service = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin(origin, done) {
  if (!origin || allowedOrigins.has(origin)) return done(null, true);
  return done(new Error('Origin is not allowed by CORS.'));
} }));
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook is not configured.');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('Invalid webhook signature.'); }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data.object;
    const orderId = session.metadata?.orderId || session.client_reference_id;
    if (orderId && session.payment_status === 'paid') {
      const rows = await readRecords('orders', { id: orderId });
      if (rows.length) await writeRecord('orders', orderId, { ...rows[0].data, status: 'paid', paymentStatus: 'paid',
        paymentMethod: 'card', paidAt: new Date().toISOString(), stripeSessionId: session.id }, rows[0].owner_id);
    }
  }
  return res.json({ received: true });
}));
app.use(express.json({ limit: '1mb' }));

const resetLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const completeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });

function requireService(_req, res, next) {
  if (!service) return res.status(503).json({ error: 'The Supabase service is not configured.' });
  next();
}

async function resolveUser(req) {
  const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
  if (!token || !service) return null;
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: role } = await service.from('user_roles').select('role').eq('user_id', data.user.id).maybeSingle();
  return { ...data.user, role: role?.role || 'customer' };
}

async function requireAuth(req, res, next) {
  try {
    req.user = await resolveUser(req);
    if (!req.user) return res.status(401).json({ error: 'Your sign-in session is invalid or expired.' });
    next();
  } catch (error) { next(error); }
}

function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'You do not have permission to perform this action.' });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validRecordId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value : crypto.randomUUID();
}

async function readRecords(collectionPath, { ownerId, id } = {}) {
  let request = service.from('app_records').select('id,owner_id,data').eq('collection_path', collectionPath);
  if (id) request = request.eq('id', id);
  if (ownerId) request = request.eq('owner_id', ownerId);
  const { data, error } = await request;
  if (error) throw error;
  return data || [];
}

async function writeRecord(collectionPath, id, data, ownerId = null) {
  const { error } = await service.from('app_records').upsert({
    collection_path: collectionPath, id, owner_id: ownerId, data,
    updated_at: new Date().toISOString()
  }, { onConflict: 'collection_path,id' });
  if (error) throw error;
}

function hasMailerConfig() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}

const transporter = hasMailerConfig() ? nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.resend.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

const resetHash = (salt, code) => crypto.createHmac('sha256', process.env.RESET_CODE_PEPPER || '')
  .update(`${salt}:${code}`).digest('hex');

async function findUserByEmail(email) {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find(item => item.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 1000) return null;
  }
  throw new Error('User lookup reached the configured page limit.');
}

app.get('/health', (_req, res) => {
  const configured = Boolean(service && process.env.SUPABASE_ANON_KEY);
  return res.status(configured ? 200 : 503).json({ status: configured ? 'ok' : 'configuration-required', timestamp: new Date().toISOString() });
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: Boolean(service) }));

// Public Supabase anon values are served at runtime so no credentials enter Git.
app.get('/runtime-config.json', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    apiBaseUrl: ''
  });
});

app.post('/api/request-password-reset', requireService, resetLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!transporter || !process.env.RESET_CODE_PEPPER) {
    return res.status(503).json({ error: 'Password reset email is not configured.' });
  }

  const user = await findUserByEmail(email);
  // Use the same response for registered and unregistered addresses.
  if (!user) return res.json({ message: 'If that email is registered, a reset code has been sent.' });

  const code = String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  const { error: saveError } = await service.from('password_resets').upsert({
    email, user_id: user.id, code_hash: resetHash(salt, code), code_salt: salt, expires_at: expiresAt
  }, { onConflict: 'email' });
  if (saveError) throw saveError;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'HOTELI POA POS — Password reset code',
      text: `Your password reset code is ${code}. It expires in 1 minute. If you did not request this, ignore this email.`,
      html: `<h2>Password reset</h2><p>Your reset code is <strong>${code}</strong>.</p><p>It expires in 1 minute. If you did not request this, ignore this email.</p>`
    });
  } catch (error) {
    console.error('Password reset email could not be sent:', error.message);
    await service.from('password_resets').delete().eq('email', email);
  }
  return res.json({ message: 'If that email is registered, a reset code has been sent.' });
}));

app.post('/api/complete-password-reset', requireService, completeLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const newPassword = String(req.body?.newPassword || '');
  if (!email || !/^\d{6}$/.test(code) || newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'Enter your email, six-digit code, and a password of at least 8 characters.' });
  }

  const { data: reset, error: readError } = await service.from('password_resets')
    .select('email,user_id,code_hash,code_salt,expires_at').eq('email', email).maybeSingle();
  if (readError) throw readError;
  const expected = reset && resetHash(reset.code_salt, code);
  const validHash = expected && Buffer.from(expected, 'hex').length === Buffer.from(reset.code_hash, 'hex').length
    && crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(reset.code_hash, 'hex'));
  if (!reset || !validHash) return res.status(400).json({ error: 'Invalid or expired reset code.' });
  if (Date.parse(reset.expires_at) <= Date.now()) {
    await service.from('password_resets').delete().eq('email', email);
    return res.status(400).json({ error: 'Invalid or expired reset code.' });
  }

  const { error: updateError } = await service.auth.admin.updateUserById(reset.user_id, { password: newPassword });
  if (updateError) throw updateError;
  const { error: deleteError } = await service.from('password_resets').delete().eq('email', email);
  if (deleteError) throw deleteError;
  return res.json({ message: 'Password updated successfully.' });
}));

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  const { data: profile } = await service.from('app_records').select('data')
    .eq('collection_path', 'users').eq('id', req.user.id).maybeSingle();
  return res.json({ user: req.user, role: req.user.role, profile: profile?.data || null });
}));

// Generic list endpoints used by POS views. RLS remains enabled for browser reads.
app.get('/api/products', requireService, asyncRoute(async (_req, res) => {
  const rows = await readRecords('products');
  return res.json(rows.map(row => ({ id: row.id, ...row.data })).filter(item => item.isAvailable !== false));
}));

app.get('/api/orders', requireAuth, asyncRoute(async (req, res) => {
  let rows = await readRecords('orders');
  if (req.user.role === 'customer') rows = rows.filter(row => row.data.customerId === req.user.id);
  if (req.user.role === 'waiter') rows = rows.filter(row => row.data.waiterId === req.user.id);
  if (['cashier', 'supervisor'].includes(req.user.role)) rows = rows.filter(row => row.data.paymentStatus === 'pending');
  if (!['customer','waiter','cashier','supervisor','manager','admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have permission to view orders.' });
  }
  return res.json(rows.map(row => ({ id: row.id, ...row.data })).filter(order => !order.archivedAt)
    .sort((a,b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)));
}));

app.post('/api/orders', requireAuth, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 100) return res.status(400).json({ error: 'An order must contain between 1 and 100 items.' });
  const lines = [];
  let subtotal = 0;
  for (const item of items) {
    const productId = String(item.productId || item.id || '');
    const quantity = Number(item.qty ?? item.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1000) {
      return res.status(400).json({ error: 'Order item or quantity is invalid.' });
    }
    const rows = await readRecords('products', { id: productId });
    const product = rows[0]?.data;
    if (!product || product.isAvailable === false) return res.status(400).json({ error: 'An item is no longer available.' });
    const price = Number(product.price);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'An item has an invalid price.' });
    const lineTotal = price * quantity;
    subtotal += lineTotal;
    lines.push({ id: crypto.randomUUID(), productId, name: product.name, qty: quantity, quantity, price, subtotal: lineTotal });
  }
  const settings = await readRecords('settings', { id: 'general' });
  const taxRate = Math.max(0, Number(settings[0]?.data?.taxRate || 0));
  const tax = subtotal * taxRate / 100;
  const tip = Math.max(0, Number(req.body.tip) || 0);
  const orderId = validRecordId(req.body.clientWriteId);
  const order = {
    id: orderId, table: String(req.body.table || '').slice(0, 40),
    guests: Math.max(1, Math.min(100, Number(req.body.guests || 1))),
    customer: String(req.body.customer || '').slice(0, 120), customerId: req.user.role === 'customer' ? req.user.id : null,
    waiterId: req.user.role === 'customer' ? null : req.user.id,
    waiterName: String(req.user.user_metadata?.full_name || req.user.email || '').slice(0, 120),
    status: 'pending', paymentStatus: 'pending',
    paymentMethod: ['cash','card','mpesa','stripe'].includes(req.body.paymentMethod) ? req.body.paymentMethod : 'cash',
    subtotal, tax, tip, total: subtotal + tax + tip, currency: 'KES',
    rating: Math.max(0, Math.min(5, Number(req.body.rating) || 0)),
    feedback: String(req.body.feedback || '').slice(0, 2000),
    feedbackImageUrl: String(req.body.feedbackImageUrl || '').slice(0, 2000),
    createdAt: new Date().toISOString(), lines
  };
  await writeRecord('orders', orderId, order, req.user.id);
  return res.status(201).json({ success: true, id: orderId, orderId, order, lines, synced: true });
}));

app.patch('/api/orders/:id/payment', requireAuth, allowRoles('cashier','supervisor','manager','admin'), asyncRoute(async (req, res) => {
  const rows = await readRecords('orders', { id: req.params.id });
  if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
  if (rows[0].data.paymentStatus === 'paid') return res.status(409).json({ error: 'This order is already paid.' });
  await writeRecord('orders', req.params.id, { ...rows[0].data, status: 'paid', paymentStatus: 'paid',
    paymentMethod: req.body?.paymentMethod || 'cash', paidAt: new Date().toISOString() }, rows[0].owner_id);
  return res.json({ success: true });
}));

app.patch('/api/orders/:id/archive', requireAuth, allowRoles('manager','admin'), asyncRoute(async (req, res) => {
  const rows = await readRecords('orders', { id: req.params.id });
  if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
  await writeRecord('orders', req.params.id, { ...rows[0].data, archivedAt: new Date().toISOString() }, rows[0].owner_id);
  return res.json({ success: true });
}));

app.post('/api/messages', requireAuth, allowRoles('waiter','cashier','supervisor','manager','admin'), asyncRoute(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 4000) return res.status(400).json({ error: 'Message must contain 1 to 4000 characters.' });
  const id = validRecordId(req.body?.clientWriteId);
  const team = String(req.body?.team || 'Front of House').slice(0, 80);
  const data = { id, team, text, message: text, read: false, fromUid: req.user.id,
    fromName: String(req.user.user_metadata?.full_name || req.user.email || 'Staff').slice(0, 120), createdAt: new Date().toISOString() };
  await writeRecord('messages', id, data, req.user.id);
  return res.status(201).json({ success: true, id, data });
}));

app.post('/api/products', requireAuth, allowRoles('manager','admin'), asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const price = Number(req.body?.price);
  const categoryId = String(req.body?.categoryId || '');
  if (!name || !categoryId || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Name, category, and a non-negative price are required.' });
  const id = validRecordId(req.body?.clientWriteId);
  const data = { ...req.body, id, name, price, categoryId, isAvailable: req.body.isAvailable !== false,
    createdAt: new Date().toISOString() };
  await writeRecord('products', id, data, req.user.id);
  return res.status(201).json({ success: true, id });
}));
app.put('/api/products/:id', requireAuth, allowRoles('manager','admin'), asyncRoute(async (req, res) => {
  const rows = await readRecords('products', { id: req.params.id });
  if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
  await writeRecord('products', req.params.id, { ...rows[0].data, ...req.body, id: req.params.id }, rows[0].owner_id);
  return res.json({ success: true, id: req.params.id });
}));
app.delete('/api/products/:id', requireAuth, allowRoles('manager','admin'), asyncRoute(async (req, res) => {
  const { error } = await service.from('app_records').delete().eq('collection_path', 'products').eq('id', req.params.id);
  if (error) throw error;
  return res.json({ success: true });
}));

app.put('/api/settings/general', requireAuth, allowRoles('manager','admin'), asyncRoute(async (req, res) => {
  const data = { id: 'general', hotelName: String(req.body?.hotelName || 'HOTELI POA').slice(0, 120), currency: 'KES',
    taxRate: Math.max(0, Math.min(100, Number(req.body?.taxRate) || 0)) };
  await writeRecord('settings', 'general', data);
  return res.json({ success: true });
}));
app.patch('/api/profile', requireAuth, asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!name) return res.status(400).json({ error: 'A profile name is required.' });
  const { error: authError } = await service.auth.admin.updateUserById(req.user.id, {
    user_metadata: { ...req.user.user_metadata, full_name: name, phone: String(req.body.phone || '').slice(0, 40),
      avatar_url: String(req.body.photoURL || '').slice(0, 2000) }
  });
  if (authError) throw authError;
  const data = { id: req.user.id, name, email: req.user.email || '', phone: req.body.phone || '',
    photoURL: req.body.photoURL || '', role: req.user.role, status: 'active', updatedAt: new Date().toISOString() };
  await writeRecord('users', req.user.id, data, req.user.id);
  return res.json({ success: true, profile: data });
}));

app.post('/api/createStripeCheckoutSession', requireAuth, asyncRoute(async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });
  const orderId = String(req.body?.orderId || '');
  const rows = await readRecords('orders', { id: orderId });
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  const staff = ['waiter','cashier','supervisor','manager','admin'].includes(req.user.role);
  if (!staff && row.data.customerId !== req.user.id) return res.status(403).json({ error: 'This order does not belong to you.' });
  if (row.data.paymentStatus === 'paid' || Number(row.data.total) <= 0) return res.status(400).json({ error: 'Order is not payable.' });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = String(process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', line_items: [{ price_data: { currency: 'kes', unit_amount: Math.round(Number(row.data.total) * 100),
      product_data: { name: `HOTELI POA order ${orderId.slice(0, 8)}` } }, quantity: 1 }],
    client_reference_id: orderId, metadata: { orderId, userId: req.user.id },
    success_url: `${siteUrl}/app/#orders`, cancel_url: `${siteUrl}/app/#pos`
  }, { idempotencyKey: `hotel-pos-${orderId}` });
  await writeRecord('orders', orderId, { ...row.data, stripeSessionId: session.id }, row.owner_id);
  return res.json({ url: session.url });
}));

const mpesaSettings = {
  shortcode: process.env.MPESA_SHORTCODE || '174379',
  environment: process.env.MPESA_ENV || 'sandbox'
};
function mpesaHost() { return mpesaSettings.environment === 'sandbox' ? 'sandbox' : 'api'; }
async function getMpesaToken() {
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET) throw new Error('M-Pesa credentials are not configured.');
  const credentials = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get(`https://${mpesaHost()}.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }, timeout: 15000
  });
  return data.access_token;
}
app.post('/api/initiateMpesaPayment', requireAuth, asyncRoute(async (req, res) => {
  if (!process.env.MPESA_PASSKEY) return res.status(503).json({ error: 'M-Pesa is not configured.' });
  const phoneNumber = String(req.body?.phoneNumber || '');
  const orderId = String(req.body?.orderId || '');
  if (!/^2547\d{8}$/.test(phoneNumber) || !orderId) return res.status(400).json({ error: 'Valid phone number and order ID required.' });
  const rows = await readRecords('orders', { id: orderId });
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  const staff = ['waiter','cashier','supervisor','manager','admin'].includes(req.user.role);
  if (!staff && row.data.customerId !== req.user.id) return res.status(403).json({ error: 'This order does not belong to you.' });
  const amount = Math.round(Number(row.data.total));
  if (!Number.isInteger(amount) || amount <= 0 || row.data.paymentStatus === 'paid') return res.status(400).json({ error: 'Order is not payable.' });
  const token = await getMpesaToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${mpesaSettings.shortcode}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  const base = `https://${mpesaHost()}.safaricom.co.ke/mpesa/stkpush/v1/processrequest`;
  const callback = `${String(process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/api/mpesa-callback`;
  const { data } = await axios.post(base, {
    BusinessShortCode: mpesaSettings.shortcode, Password: password, Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline', Amount: amount, PartyA: phoneNumber,
    PartyB: mpesaSettings.shortcode, PhoneNumber: phoneNumber, CallBackURL: callback,
    AccountReference: orderId.slice(0, 12), TransactionDesc: 'HOTELI POA'
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
  const payment = { orderId, userId: req.user.id, checkoutRequestId: data.CheckoutRequestID,
    status: 'pending', createdAt: new Date().toISOString() };
  await writeRecord('mpesa_payments', crypto.randomUUID(), payment, req.user.id);
  return res.json({ success: true, message: 'STK Push sent. Check your phone.' });
}));
app.post('/api/mpesa-callback', asyncRoute(async (req, res) => {
  const callback = req.body?.Body?.stkCallback;
  if (!callback?.CheckoutRequestID) return res.status(400).send('Invalid callback.');
  const { data: payment, error } = await service.from('app_records').select('id,owner_id,data')
    .eq('collection_path', 'mpesa_payments').eq('data->>checkoutRequestId', callback.CheckoutRequestID).maybeSingle();
  if (error) throw error;
  if (!payment) return res.status(404).send('Payment not found.');
  const paid = Number(callback.ResultCode) === 0;
  await writeRecord('mpesa_payments', payment.id, { ...payment.data, status: paid ? 'paid' : 'failed', resultCode: callback.ResultCode }, payment.owner_id);
  if (paid) {
    const orders = await readRecords('orders', { id: payment.data.orderId });
    if (orders.length) await writeRecord('orders', payment.data.orderId, { ...orders[0].data,
      status: 'paid', paymentStatus: 'paid', paymentMethod: 'mpesa', paidAt: new Date().toISOString() }, orders[0].owner_id);
  }
  return res.status(200).send('OK');
}));

// Render serves the POS pages and API from one origin.
app.get(['/','/index.html','/auth.html'], (_req, res) => res.sendFile(path.join(webRoot, 'auth.html')));
app.get(['/app','/app/'], (_req, res) => res.sendFile(path.join(webRoot, 'app/index.html')));
app.use(express.static(webRoot, { index: false, maxAge: '1h' }));

app.use((error, _req, res, _next) => {
  console.error('Request failed:', error?.message || error);
  if (res.headersSent) return;
  res.status(error.status || 500).json({ error: error.status ? error.message : 'The request could not be completed.' });
});

app.listen(port, () => console.log(`HOTELI POA Supabase service listening on ${port}`));

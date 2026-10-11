'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');
const db = require('./database');
const { seed: seedFirestoreDefaults } = require('./seed');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by CORS.'));
} }));
app.use(express.json({ limit: '1mb' }));

let firestore = null;
try {
  if (!admin.apps.length) {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    } else if (serviceAccountPath) {
      admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(serviceAccountPath))) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  }
  if (admin.apps.length) firestore = admin.firestore();
} catch (error) {
  console.error('Firebase Admin initialization failed:', error.message);
}

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
  if (error) reject(error); else resolve({ lastID: this.lastID, changes: this.changes });
}));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

function roleOf(user) { return String(user.role || user.token?.role || 'customer').toLowerCase(); }
function requestedDocumentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : crypto.randomUUID();
}
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Sign in is required.' });
  if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin is not configured on this server.' });
  admin.auth().verifyIdToken(token, true).then(decoded => {
    req.user = decoded;
    req.role = roleOf(decoded);
    next();
  }).catch(() => res.status(401).json({ error: 'Your sign-in session is invalid or expired.' }));
}
function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.role) ? next() : res.status(403).json({ error: 'You do not have permission to perform this action.' });
}
function requireFirestore(req, res, next) {
  if (!firestore) return res.status(503).json({ error: 'Firebase is unavailable; the write will need to be retried.' });
  next();
}
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function firestoreTimestamp() { return new Date(); }

async function backupRecord(collectionName, documentId, payload) {
  await run(`INSERT INTO local_records (collection_name, document_id, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(collection_name, document_id) DO UPDATE SET payload=excluded.payload, updated_at=CURRENT_TIMESTAMP`,
  [collectionName, documentId, JSON.stringify(payload)]);
  if (collectionName !== 'products') return;
  if (!payload || payload.__delete === true || payload.isAvailable === false) {
    await run('UPDATE products SET is_available = 0 WHERE firestore_id = ?', [documentId]);
    return;
  }
  const name = String(payload.name || '').trim();
  if (!name) return;
  const existing = await all('SELECT id FROM products WHERE firestore_id = ? OR name = ? COLLATE NOCASE LIMIT 1', [documentId, name]);
  const values = [name, Number(payload.price) || 0, payload.department || payload.category || 'food',
    payload.sub_category || '', payload.image_url || payload.imageUrl || '', documentId];
  if (existing.length) {
    await run('UPDATE products SET name=?, price=?, category=?, sub_category=?, image_url=?, firestore_id=?, is_available=1 WHERE id=?', [...values, existing[0].id]);
  } else {
    await run('INSERT INTO products (name, price, category, sub_category, image_url, firestore_id, is_available) VALUES (?, ?, ?, ?, ?, ?, 1)', values);
  }
}
async function queueWrite(collectionName, documentId, payload, error) {
  if (collectionName === 'orders' && payload?.data && Array.isArray(payload.lines)) {
    await backupOrder({ id: documentId, ...payload.data }, payload.lines);
  } else await backupRecord(collectionName, documentId, payload);
  await run('INSERT INTO sync_queue (collection_name, document_id, payload, last_error) VALUES (?, ?, ?, ?)',
    [collectionName, documentId, JSON.stringify(payload), String(error?.message || error).slice(0, 1000)]);
}
function reviveFirestoreDates(value) {
  if (Array.isArray(value)) return value.map(reviveFirestoreDates);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['createdAt', 'updatedAt', 'paidAt', 'archivedAt'].includes(key) && typeof entry === 'string') {
      const date = new Date(entry);
      result[key] = Number.isNaN(date.getTime()) ? entry : admin.firestore.Timestamp.fromDate(date);
    } else result[key] = reviveFirestoreDates(entry);
  }
  return result;
}
async function backupOrder(order, lines) {
  const existing = await all('SELECT payload FROM local_records WHERE collection_name = ? AND document_id = ? LIMIT 1', ['orders', order.id]);
  let sqliteId = null;
  if (existing.length) {
    try { sqliteId = JSON.parse(existing[0].payload).sqliteId || null; } catch {}
  }
  const alreadyInRelationalTables = Boolean(sqliteId);
  if (sqliteId) await run('UPDATE orders SET table_name=?, total_amount=?, status=?, customer_name=? WHERE id=?',
    [order.table || order.table_name || 'Online', order.total ?? order.total_amount ?? 0, order.paymentStatus || order.status || 'pending', order.customer || order.customer_name || null, sqliteId]);
  else sqliteId = (await run('INSERT INTO orders (table_name, total_amount, status, customer_name) VALUES (?, ?, ?, ?)',
    [order.table || order.table_name || 'Online', order.total ?? order.total_amount ?? 0, order.paymentStatus || order.status || 'pending', order.customer || order.customer_name || null]));
  if (typeof sqliteId === 'object') sqliteId = sqliteId.lastID;
  if (!alreadyInRelationalTables) for (const line of lines) {
    const productRows = await all('SELECT id FROM products WHERE firestore_id = ? OR name = ? COLLATE NOCASE LIMIT 1', [line.productId, line.name || '']);
    await run('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
      [sqliteId, productRows[0]?.id ?? null, line.qty || line.quantity, line.price]);
  }
  let savedLines = lines;
  if (!savedLines.length && existing.length) {
    try { savedLines = JSON.parse(existing[0].payload).lines || []; } catch {}
  }
  await backupRecord('orders', order.id, { ...order, id: order.id, lines: savedLines, sqliteId });
}
async function writeRecord(collectionName, documentId, data, res, options = {}) {
  const payload = options.payload || data;
  try {
    if (options.orderLines) {
      const batch = firestore.batch();
      batch.set(firestore.collection('orders').doc(documentId), data);
      for (const line of options.orderLines) {
        const lineId = line.id || crypto.randomUUID();
        batch.set(firestore.collection('orders').doc(documentId).collection('lines').doc(lineId), line);
        batch.set(firestore.collection('order_items').doc(`${documentId}_${lineId}`), {
          id: `${documentId}_${lineId}`, order_id: documentId, orderId: documentId,
          product_id: line.productId, productId: line.productId,
          quantity: line.quantity || line.qty, price: line.price, name: line.name || 'Item'
        });
      }
      await batch.commit();
    } else if (options.delete) {
      await firestore.collection(collectionName).doc(documentId).delete();
    } else {
      await firestore.collection(collectionName).doc(documentId).set(data, { merge: true });
    }
    if (collectionName === 'orders' && options.orderLines) await backupOrder(data, options.orderLines);
    else if (collectionName === 'orders') {
      const savedOrder = await firestore.collection('orders').doc(documentId).get();
      if (savedOrder.exists) await backupOrder({ id: documentId, ...savedOrder.data() }, []);
    }
    else await backupRecord(collectionName, documentId, data);
    return res.status(200).json({
      success: true, id: documentId, synced: true,
      ...(options.orderLines ? { orderId: documentId } : {}),
      ...(options.orderLines ? { order: { id: documentId, ...data }, lines: options.orderLines } : {})
    });
  } catch (error) {
    try {
      await queueWrite(collectionName, documentId, options.orderLines ? { data, lines: options.orderLines } : payload, error);
      return res.status(202).json({
        success: true, id: documentId, synced: false, queued: true,
        message: 'Saved locally and queued for Firestore sync.',
        ...(options.orderLines ? { orderId: documentId } : {}),
        ...(options.orderLines ? { order: { id: documentId, ...data }, lines: options.orderLines } : {})
      });
    } catch (queueError) {
      console.error('Could not persist fallback write:', queueError.message);
      throw new Error('The write could not be saved to Firestore or the local backup.');
    }
  }
}

async function flushQueue() {
  if (!firestore) return;
  const pending = await all('SELECT * FROM sync_queue ORDER BY id ASC LIMIT 100');
  for (const row of pending) {
    try {
      const payload = reviveFirestoreDates(JSON.parse(row.payload));
      if (row.collection_name === 'orders' && payload.data && Array.isArray(payload.lines)) {
        const batch = firestore.batch();
        batch.set(firestore.collection('orders').doc(row.document_id), payload.data);
        for (const line of payload.lines || []) {
          const lineId = line.id || crypto.randomUUID();
          batch.set(firestore.collection('orders').doc(row.document_id).collection('lines').doc(lineId), line);
          batch.set(firestore.collection('order_items').doc(`${row.document_id}_${lineId}`), {
            id: `${row.document_id}_${lineId}`, order_id: row.document_id, orderId: row.document_id,
            product_id: line.productId, productId: line.productId,
            quantity: line.quantity || line.qty, price: line.price, name: line.name || 'Item'
          });
        }
        await batch.commit();
      } else if (payload.__delete === true) {
        await firestore.collection(row.collection_name).doc(row.document_id).delete();
      } else {
        await firestore.collection(row.collection_name).doc(row.document_id).set(payload, { merge: true });
      }
      await run('DELETE FROM sync_queue WHERE id = ?', [row.id]);
    } catch (error) {
      await run('UPDATE sync_queue SET attempts=attempts+1, last_error=? WHERE id=?', [String(error.message).slice(0, 1000), row.id]);
    }
  }
}
const queueTimer = setInterval(() => flushQueue().catch(error => console.error('Sync retry failed:', error.message)), 5 * 60 * 1000);
queueTimer.unref();

app.get('/api/health', (_req, res) => res.json({ ok: true, firebase: Boolean(firestore) }));

// Read-only REST endpoints for clients that need a snapshot. The SPA continues
// to use Firestore onSnapshot for live updates. SQLite supplies a read fallback
// when the API is online but Firestore is temporarily unreachable.
app.get('/api/products', asyncRoute(async (_req, res) => {
  if (firestore) {
    try {
      const snapshot = await firestore.collection('products').get();
      return res.json(snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .filter(item => item.isAvailable !== false));
    } catch (error) {
      console.warn('Firestore product read failed; trying the SQLite catalog:', error.message);
    }
  }
  const products = await all('SELECT id, name, price, category, sub_category, image_url, firestore_id FROM products WHERE is_available = 1 ORDER BY name');
  const byId = new Map(products.map(item => {
    const product = {
    ...item, id: item.firestore_id || String(item.id), categoryId: String(item.sub_category || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    department: item.category, imageUrl: item.image_url || ''
    };
    return [product.id, product];
  }));
  const cached = await all('SELECT document_id, payload FROM local_records WHERE collection_name = ? ORDER BY document_id', ['products']);
  for (const row of cached) {
    let item;
    try { item = JSON.parse(row.payload); } catch { continue; }
    if (!item || item.__delete === true || item.isAvailable === false) byId.delete(row.document_id);
    else byId.set(row.document_id, { ...item, id: row.document_id });
  }
  return res.json([...byId.values()]);
}));

app.get('/api/orders', requireAuth, asyncRoute(async (req, res) => {
  const role = req.role;
  if (!['manager', 'admin', 'cashier', 'supervisor', 'waiter', 'customer'].includes(role)) {
    return res.status(403).json({ error: 'You do not have permission to view orders.' });
  }
  let orders = [];
  let firestoreReadSucceeded = false;
  if (firestore) {
    try {
      let query = firestore.collection('orders');
      if (['cashier', 'supervisor'].includes(role)) query = query.where('paymentStatus', '==', 'pending');
      else if (role === 'waiter') query = query.where('waiterId', '==', req.user.uid);
      else if (role === 'customer') query = query.where('customerId', '==', req.user.uid);
      const snapshot = await query.get();
      orders = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      firestoreReadSucceeded = true;
    } catch (error) {
      console.warn('Firestore order read failed; trying the SQLite backup:', error.message);
    }
  }
  if (!firestoreReadSucceeded) {
    const rows = await all('SELECT payload FROM local_records WHERE collection_name = ?', ['orders']);
    orders = rows.map(row => { try { return JSON.parse(row.payload); } catch { return null; } }).filter(Boolean);
    if (['cashier', 'supervisor'].includes(role)) orders = orders.filter(order => order.paymentStatus === 'pending' || order.status === 'pending');
    else if (role === 'waiter') orders = orders.filter(order => order.waiterId === req.user.uid);
    else if (role === 'customer') orders = orders.filter(order => order.customerId === req.user.uid);
  }
  orders = orders.filter(order => !order.archivedAt).sort((left, right) => {
    const stamp = value => value?.toMillis?.() || (value instanceof Date ? value.getTime() : Date.parse(value || '') || 0);
    return stamp(right.createdAt || right.created_at) - stamp(left.createdAt || left.created_at);
  });
  return res.json(orders);
}));

app.get('/api/messages', requireAuth, allowRoles('waiter', 'cashier', 'supervisor', 'manager', 'admin'), asyncRoute(async (_req, res) => {
  if (firestore) {
    try {
      const snapshot = await firestore.collection('messages').orderBy('createdAt', 'asc').limit(500).get();
      return res.json(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
    } catch (error) {
      console.warn('Firestore message read failed; trying the SQLite backup:', error.message);
    }
  }
  const rows = await all('SELECT payload FROM local_records WHERE collection_name = ?', ['messages']);
  const messages = rows.map(row => { try { return JSON.parse(row.payload); } catch { return null; } }).filter(Boolean);
  messages.sort((left, right) => String(left.createdAt || left.created_at || '').localeCompare(String(right.createdAt || right.created_at || '')));
  return res.json(messages.slice(-500));
}));

app.get('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  const result = {};
  if (firestore) {
    try {
      const general = await firestore.collection('settings').doc('general').get();
      if (general.exists) result.general = general.data();
      const personal = await firestore.collection('settings').doc(req.user.uid).get();
      if (personal.exists) result.preferences = personal.data().userPreferences || {};
      return res.json(result);
    } catch (error) {
      console.warn('Firestore settings read failed; trying the SQLite backup:', error.message);
    }
  }
  const [general, personal, defaults] = await Promise.all([
    all('SELECT payload FROM local_records WHERE collection_name = ? AND document_id = ?', ['settings', 'general']),
    all('SELECT payload FROM local_records WHERE collection_name = ? AND document_id = ?', ['settings', req.user.uid]),
    all('SELECT key, value FROM settings')
  ]);
  if (general[0]) { try { result.general = JSON.parse(general[0].payload); } catch {} }
  if (personal[0]) { try { result.preferences = JSON.parse(personal[0].payload).userPreferences || {}; } catch {} }
  if (!result.general) result.defaults = Object.fromEntries(defaults.map(setting => [setting.key, setting.value]));
  return res.json(result);
}));

app.post('/api/settings', requireAuth, allowRoles('manager', 'admin'), asyncRoute(async (req, res) => {
  const input = req.body || {};
  const hotelName = String(input.hotelName || 'HOTELI POA').trim().slice(0, 120);
  const taxRate = Math.max(0, Math.min(100, Number(input.taxRate) || 0));
  const data = { id: 'general', key: 'general', hotelName, currency: 'KES', taxRate,
    value: { hotelName, currency: 'KES', taxRate } };
  await writeRecord('settings', 'general', data, res);
}));

// Firebase Auth owns login and password handling. Never authenticate against SQLite.
app.post('/api/orders', requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const rawLines = Array.isArray(body.items) ? body.items : Array.isArray(body.lines) ? body.lines : [];
  if (!rawLines.length || rawLines.length > 100) return res.status(400).json({ error: 'An order must contain between 1 and 100 items.' });
  if (req.role === 'customer' && !req.user.uid) return res.status(403).json({ error: 'A customer account is required.' });

  const lines = [];
  let subtotal = 0;
  for (const item of rawLines) {
    const productId = String(item.productId || item.id || '');
    const quantity = Number(item.qty ?? item.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1000) return res.status(400).json({ error: 'Order item or quantity is invalid.' });
    let product = null;
    if (firestore) {
      try {
        const productSnapshot = await firestore.collection('products').doc(productId).get();
        if (!productSnapshot.exists || productSnapshot.data().isAvailable === false) return res.status(400).json({ error: 'An item is no longer available.' });
        product = productSnapshot.data();
      } catch (error) {
        console.warn('Firestore product lookup failed; validating against the SQLite menu:', error.message);
      }
    }
    if (!product) {
      const localProducts = await all('SELECT name, price, category, sub_category, image_url, is_available FROM products WHERE firestore_id = ? LIMIT 1', [productId]);
      const localProduct = localProducts[0];
      if (!localProduct || Number(localProduct.is_available) === 0) return res.status(firestore ? 503 : 400).json({ error: 'An item is unavailable in the current catalog.' });
      product = { name: localProduct.name, price: localProduct.price, category: localProduct.category,
        sub_category: localProduct.sub_category, imageUrl: localProduct.image_url || '' };
    }
    const price = Number(product.price ?? product.lst_price);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: `The price for ${product.name || 'an item'} is invalid.` });
    const lineTotal = price * quantity;
    subtotal += lineTotal;
    const lineId = crypto.createHash('sha256').update(`${productId}:${lines.length}`).digest('hex');
    lines.push({ id: lineId, productId, name: product.name || item.name || 'Item', qty: quantity, quantity,
      price, unit: product.unit || product.unit_label || '', subtotal: lineTotal });
  }

  const orderId = requestedDocumentId(body.clientWriteId);
  let taxRate = 0;
  if (firestore) {
    try {
      const settingsSnapshot = await firestore.collection('settings').doc('general').get();
      taxRate = Math.max(0, Number(settingsSnapshot.data()?.taxRate || 0));
    } catch (error) {
      const localSettings = await all('SELECT payload FROM local_records WHERE collection_name = ? AND document_id = ?', ['settings', 'general']);
      if (localSettings[0]) {
        try { taxRate = Math.max(0, Number(JSON.parse(localSettings[0].payload).taxRate || 0)); } catch {}
      }
      console.warn('Using the SQLite tax settings fallback:', error.message);
    }
  } else {
    const localSettings = await all('SELECT payload FROM local_records WHERE collection_name = ? AND document_id = ?', ['settings', 'general']);
    if (localSettings[0]) {
      try { taxRate = Math.max(0, Number(JSON.parse(localSettings[0].payload).taxRate || 0)); } catch {}
    }
  }
  const tax = subtotal * taxRate / 100;
  const tip = Math.max(0, Number(body.tip) || 0);
  const customerOrder = req.role === 'customer';
  const paymentMethod = ['cash', 'card', 'mpesa', 'stripe'].includes(body.paymentMethod) ? body.paymentMethod : 'cash';
  // Every sale starts unpaid. A cashier or verified payment callback settles it.
  const pending = true;
  const order = {
    table: String(body.table || body.table_name || '').slice(0, 40),
    guests: Math.max(1, Math.min(100, Number(body.guests || 1))),
    customer: String(body.customer || body.customer_name || '').slice(0, 120),
    customerId: customerOrder ? req.user.uid : null,
    waiterId: customerOrder ? null : req.user.uid,
    waiterName: String(body.waiterName || req.user.name || req.user.email || ''),
    status: pending ? 'pending' : 'paid', paymentStatus: pending ? 'pending' : 'paid', paymentMethod,
    subtotal, tax, tip, rating: Math.max(0, Math.min(5, Number(body.rating) || 0)),
    feedback: String(body.feedback || '').slice(0, 2000), feedbackImageUrl: String(body.feedbackImageUrl || '').slice(0, 2000),
    total: subtotal + tax + tip, currency: 'KES', createdAt: new Date()
  };
  order.table_name = order.table;
  order.id = orderId;
  order.total_amount = order.total;
  order.customer_name = order.customer;
  order.created_at = order.createdAt;
  const result = await writeRecord('orders', orderId, order, res, { orderLines: lines, payload: { data: order, lines } });
  return result;
}));

app.patch('/api/orders/:id/payment', requireAuth, allowRoles('cashier', 'supervisor', 'manager', 'admin'), requireFirestore, asyncRoute(async (req, res) => {
  const method = ['cash', 'card', 'mpesa', 'stripe'].includes(req.body?.paymentMethod) ? req.body.paymentMethod : 'cash';
  const data = { status: 'paid', paymentStatus: 'paid', paymentMethod: method, paidAt: firestoreTimestamp() };
  const ref = firestore.collection('orders').doc(req.params.id);
  const order = await ref.get();
  if (!order.exists) return res.status(404).json({ error: 'Order not found.' });
  if (order.data().paymentStatus === 'paid' || order.data().status === 'paid') return res.status(409).json({ error: 'This order is already paid.' });
  await writeRecord('orders', req.params.id, data, res);
}));
app.patch('/api/orders/:id/archive', requireAuth, allowRoles('manager', 'admin'), requireFirestore, asyncRoute(async (req, res) => {
  const ref = firestore.collection('orders').doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Order not found.' });
  await writeRecord('orders', req.params.id, { archivedAt: firestoreTimestamp() }, res);
}));

app.post('/api/messages', requireAuth, allowRoles('waiter', 'cashier', 'supervisor', 'manager', 'admin'), asyncRoute(async (req, res) => {
  const text = String(req.body?.text || req.body?.message || '').trim();
  if (!text || text.length > 4000) return res.status(400).json({ error: 'Message must contain 1 to 4000 characters.' });
  const id = requestedDocumentId(req.body?.clientWriteId);
  const fromName = String(req.user.name || req.user.email || 'Staff').slice(0, 120);
  const recipient = String(req.body?.team || req.body?.receiver || 'Front of House').slice(0, 80);
  const data = { team: recipient, text, message: text,
    sender: fromName, receiver: recipient, read: false,
    fromUid: req.user.uid, fromName, createdAt: firestoreTimestamp(), created_at: firestoreTimestamp() };
  data.id = id;
  await writeRecord('messages', id, data, res);
}));

app.post('/api/products', requireAuth, allowRoles('manager', 'admin'), asyncRoute(async (req, res) => {
  const { name, unit } = req.body || {};
  const categoryId = String(req.body?.categoryId || String(req.body?.sub_category || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  const price = Number(req.body?.price);
  if (!String(name || '').trim() || !String(categoryId || '').trim() || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Name, category, and a non-negative price are required.' });
  const id = requestedDocumentId(req.body?.clientWriteId);
  let categoryInfo = {};
  if (firestore) {
    try { categoryInfo = (await firestore.collection('categories').doc(categoryId).get()).data() || {}; }
    catch (error) { console.warn('Could not resolve product category metadata:', error.message); }
  }
  const department = String(req.body?.department || req.body?.category || categoryInfo.department || 'food').toLowerCase();
  if (!['food', 'drinks', 'beverage'].includes(department)) return res.status(400).json({ error: 'Category must be food or drinks.' });
  const subCategory = String(req.body?.sub_category || categoryInfo.name || '').trim().slice(0, 80);
  const data = { id, name: String(name).trim().slice(0, 120), categoryId, category: department, department,
    sub_category: subCategory, price,
    unit: String(unit || '').slice(0, 32), isAvailable: req.body?.isAvailable !== false,
    imageUrl: String(req.body?.image_url || req.body?.imageUrl || '').slice(0, 2000),
    image_url: String(req.body?.image_url || req.body?.imageUrl || '').slice(0, 2000), createdAt: firestoreTimestamp() };
  await writeRecord('products', id, data, res);
}));
app.put('/api/products/:id', requireAuth, allowRoles('manager', 'admin'), asyncRoute(async (req, res) => {
  const { name, unit } = req.body || {};
  const categoryId = String(req.body?.categoryId || String(req.body?.sub_category || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  const price = Number(req.body?.price);
  if (!String(name || '').trim() || !String(categoryId || '').trim() || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Name, category, and a non-negative price are required.' });
  let categoryInfo = {};
  if (firestore) {
    try { categoryInfo = (await firestore.collection('categories').doc(categoryId).get()).data() || {}; }
    catch (error) { console.warn('Could not resolve product category metadata:', error.message); }
  }
  const department = String(req.body?.department || req.body?.category || categoryInfo.department || 'food').toLowerCase();
  if (!['food', 'drinks', 'beverage'].includes(department)) return res.status(400).json({ error: 'Category must be food or drinks.' });
  const subCategory = String(req.body?.sub_category || categoryInfo.name || '').trim().slice(0, 80);
  const data = { id: req.params.id, name: String(name).trim().slice(0, 120), categoryId, category: department, department,
    sub_category: subCategory, price,
    unit: String(unit || '').slice(0, 32), imageUrl: String(req.body?.image_url || req.body?.imageUrl || '').slice(0, 2000),
    image_url: String(req.body?.image_url || req.body?.imageUrl || '').slice(0, 2000) };
  await writeRecord('products', req.params.id, data, res);
}));
app.delete('/api/products/:id', requireAuth, allowRoles('manager', 'admin'), asyncRoute(async (req, res) => {
  if (firestore) {
    try {
      const snapshot = await firestore.collection('products').doc(req.params.id).get();
      if (!snapshot.exists) return res.status(404).json({ error: 'Product not found.' });
    } catch (error) {
      console.warn('Could not verify product deletion online; it will be queued:', error.message);
    }
  }
  await writeRecord('products', req.params.id, null, res, { delete: true, payload: { __delete: true } });
}));
app.put('/api/settings/general', requireAuth, allowRoles('manager', 'admin'), asyncRoute(async (req, res) => {
  const input = req.body || {};
  const data = {
    id: 'general', key: 'general', hotelName: String(input.hotelName || 'HOTELI POA').slice(0, 120), currency: 'KES',
    taxRate: Math.max(0, Math.min(100, Number(input.taxRate) || 0))
  };
  data.value = { hotelName: data.hotelName, currency: data.currency, taxRate: data.taxRate };
  await writeRecord('settings', 'general', data, res);
}));

app.patch('/api/profile', requireAuth, asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const phone = String(req.body?.phone || '').trim().slice(0, 40);
  const photoURL = String(req.body?.photoURL || '').trim().slice(0, 2000);
  if (!name) return res.status(400).json({ error: 'A profile name is required.' });
  const user = await admin.auth().getUser(req.user.uid);
  await admin.auth().updateUser(req.user.uid, { displayName: name, ...(photoURL ? { photoURL } : {}) });
  const data = { id: req.user.uid, name, email: user.email || '', phone, photoURL, role: req.role, status: user.disabled ? 'disabled' : 'active', updatedAt: firestoreTimestamp() };
  await writeRecord('users', req.user.uid, data, res);
}));

// Only explicitly public frontend files are served. Source, database, and config files stay private.
const publicFiles = new Set(['index.html', 'app.js', 'firebase.js', 'auth.html', 'auth.js', 'auth-extra.js',
  'settings-behaviors.js', 'receipt.js', 'styles.css', 'manifest.json', 'sw.js']);
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'auth.html')));
app.get(['/app', '/app/'], (_req, res) => res.sendFile(path.join(__dirname, 'app', 'index.html')));
app.get('/runtime-config.js', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`window.POS_API_BASE_URL = ${JSON.stringify(process.env.POS_API_BASE_URL || '')};`);
});
app.get('/:asset', (req, res, next) => {
  if (!publicFiles.has(req.params.asset)) return next();
  const file = req.params.asset === 'index.html' ? path.join(__dirname, 'app', 'index.html') : path.join(__dirname, req.params.asset);
  if (!fs.existsSync(file)) return res.status(404).end();
  return res.sendFile(file);
});
app.use((error, _req, res, _next) => {
  console.error('Request failed:', error.message);
  if (res.headersSent) return;
  res.status(error.status || 500).json({ error: error.status ? error.message : 'The request could not be completed.' });
});

const server = app.listen(PORT, () => {
  console.log(`HOTELI POA POS available at http://localhost:${PORT}`);
  console.log(firestore ? 'Firebase Admin connected; queued writes retry every 5 minutes.' : 'Firebase Admin is not configured. Add server credentials before using authenticated APIs.');
  if (firestore) seedFirestoreDefaults(firestore, admin).catch(error => console.error('Default menu seed failed:', error.message));
  flushQueue().catch(error => console.error('Initial sync failed:', error.message));
});
function shutdown() { clearInterval(queueTimer); server.close(() => db.close()); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

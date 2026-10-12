// server/auth.js — customer and staff authentication for the SQLite demo.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { db, tokenDigest, findUserByToken, deleteSession, withTransaction } from './sqlite.js';
import { logAction } from './audit.js';

const scrypt = promisify(crypto.scrypt);
const router = express.Router();
const safeText = value => String(value ?? '').trim();
const normalizePhone = value => safeText(value).replace(/[^+\d]/g, '').slice(0, 20);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const attempts = new Map();
function authRateLimit(req,res,next) {
  const now=Date.now(),ip=String(req.ip||req.socket.remoteAddress||'unknown');
  const current=attempts.get(ip);
  if(!current||now-current.startedAt>=10*60*1000)attempts.set(ip,{startedAt:now,count:1});
  else if(current.count>=10)return res.status(429).json({error:'Too many attempts. Try again in 10 minutes.'});
  else current.count++;
  if(attempts.size>5000)for(const [key,value] of attempts)if(now-value.startedAt>=10*60*1000)attempts.delete(key);
  return next();
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(String(password), salt, 64);
  return { salt, hash: hash.toString('hex'), stored: `scrypt$${salt}$${hash.toString('hex')}` };
}

async function verifyPassword(password, stored, salt = '') {
  let parts = String(stored || '').split('$');
  if (parts[0] === 'scrypt' && parts.length === 3) [, salt, stored] = parts;
  if (!salt || !/^[a-f\d]{128}$/i.test(String(stored || ''))) return false;
  const actual = await scrypt(String(password), salt, 64);
  const expected = Buffer.from(stored, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function getToken(req) {
  return String(req.get('x-auth-token') || /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1] || '');
}

export function requireCustomer(req, res, next) {
  const token = getToken(req);
  const customer = token && db.prepare(`SELECT c.* FROM customer_sessions s JOIN customers c ON c.id=s.customer_id
    WHERE s.token_hash=? AND s.expires_at>? AND c.active=1`).get(tokenDigest(token), Date.now());
  if (!customer) return res.status(401).json({ error: 'Customer sign-in required.' });
  const page = String(req.get('x-current-page') || '').slice(0, 160);
  withTransaction(()=>db.prepare('UPDATE customers SET last_seen=?,last_page=? WHERE id=?').run(Date.now(), page, customer.id));
  req.customer = customer;
  req.actor = { id: customer.id, role: 'customer', type: 'customer' };
  return next();
}

export function requireStaff(req, res, next) {
  const token = getToken(req);
  let staff = token && db.prepare(`SELECT s.* FROM staff_sessions ss JOIN staff s ON s.id=ss.staff_id
    WHERE ss.token_hash=? AND ss.expires_at>? AND s.active=1`).get(tokenDigest(token), Date.now());
  // Keep the current staff sign-in page working while it transitions to the separate staff session API.
  if (!staff && token) {
    const user = findUserByToken(token);
    if (user && user.role !== 'customer') staff = db.prepare('SELECT * FROM staff WHERE auth_user_id=? AND active=1').get(user.id);
    if (staff) req.legacyStaffSession = true;
  }
  if (!staff) return res.status(401).json({ error: 'Staff sign-in required.' });
  const page = String(req.get('x-current-page') || '').slice(0, 160);
  withTransaction(()=>db.prepare('UPDATE staff SET last_seen=?,last_page=? WHERE id=?').run(Date.now(), page, staff.id));
  req.staff = staff;
  req.actor = { id: String(staff.id), role: staff.role, type: 'staff' };
  return next();
}

export function requireRole(roles) {
  const allowed = new Set(Array.isArray(roles) ? roles : [roles]);
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: 'Staff sign-in required.' });
    if (!allowed.has(req.staff.role)) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    return next();
  };
}

export async function ensureSuperAdmin() {
  if (db.prepare("SELECT id FROM staff WHERE role='super_admin' LIMIT 1").get()) return;
  const hash = await hashPassword('0000');
  withTransaction(()=>db.prepare(`INSERT INTO staff(name,role,pin_hash,phone,force_password_change)
    VALUES('Super Admin','super_admin',?,'0700000000',1)`).run(hash.stored));
  console.warn('Super admin created: phone=0700000000, pin=0000. Change the password after first login.');
}

router.post('/customer/register', authRateLimit, async (req, res, next) => {
  try {
    const name = safeText(req.body?.name).replace(/\s+/g, ' ').slice(0, 120);
    const phone = normalizePhone(req.body?.phone);
    const email = safeText(req.body?.email).toLowerCase().slice(0, 254);
    const password = String(req.body?.password || '');
    const address = safeText(req.body?.address).slice(0, 1000);
    const landmark = safeText(req.body?.landmark).slice(0, 300);
    if (name.length < 2 || phone.replace(/\D/g, '').length < 7 || !emailPattern.test(email) || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Enter a name, valid phone and email, and a password of at least 8 characters.' });
    }
    const hash = await hashPassword(password);
    const id = crypto.randomUUID();
    try {
      withTransaction(()=>db.prepare('INSERT INTO customers(id,name,phone,email,password_hash,salt,address,landmark) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, name, phone, email, hash.hash, hash.salt, address, landmark));
    } catch (error) {
      if (String(error.code).startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed: customers\.(phone|email)/i.test(String(error.message))) return res.status(409).json({ error: 'That phone number or email is already registered.' });
      throw error;
    }
    const token = crypto.randomBytes(24).toString('hex');
    withTransaction(()=>{
      db.prepare('INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES(?,?,?)').run(tokenDigest(token), id, Date.now() + 30 * 24 * 60 * 60 * 1000);
      logAction(db, { actorId: id, actorRole: 'customer', action: 'register', targetType: 'customer', targetId: id });
    });
    return res.status(201).json({ token, user: { id, name, phone, email, address, landmark, role: 'customer' } });
  } catch (error) { return next(error); }
});

router.post('/customer/login', authRateLimit, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone || req.body?.username);
    const customer = db.prepare('SELECT * FROM customers WHERE phone=? AND active=1').get(phone);
    if (!customer || !(await verifyPassword(req.body?.password, customer.password_hash, customer.salt))) {
      return res.status(401).json({ error: 'Phone number or password is incorrect.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    withTransaction(()=>{
      db.prepare('INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES(?,?,?)').run(tokenDigest(token), customer.id, Date.now() + 30 * 24 * 60 * 60 * 1000);
      db.prepare('UPDATE customers SET last_seen=? WHERE id=?').run(Date.now(),customer.id);
      logAction(db, { actorId: customer.id, actorRole: 'customer', action: 'login', targetType: 'customer', targetId: customer.id });
    });
    return res.json({ token, user: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, address: customer.address, landmark: customer.landmark, role: 'customer' } });
  } catch (error) { return next(error); }
});

router.post('/customer/forgot-password', authRateLimit, (req, res) => {
  const phone=normalizePhone(req.body?.phone);
  const email = safeText(req.body?.email).toLowerCase();
  if (!emailPattern.test(email)&&phone.replace(/\D/g,'').length<7) return res.status(400).json({ error: 'Enter a valid phone number or email address.' });
  return res.json({ sent: false, reason: 'demo', message: 'In demo mode, password reset is not available. Contact front desk on WhatsApp 07XX...' });
});

router.get('/customer/me', requireCustomer, (req, res) => {
  const { id, name, phone, email, address, landmark } = req.customer;
  return res.json({ user: { id, name, phone, email, address, landmark, role: 'customer' } });
});

router.post('/customer/logout', requireCustomer, (req, res) => {
  const token = getToken(req);
  withTransaction(()=>{
    db.prepare('DELETE FROM customer_sessions WHERE token_hash=?').run(tokenDigest(token));
    logAction(db, { actorId: req.customer.id, actorRole: 'customer', action: 'logout', targetType: 'customer', targetId: req.customer.id });
  });
  return res.status(204).end();
});

router.post('/staff/login', authRateLimit, async (req, res, next) => {
  try {
    const identifier = safeText(req.body?.phone || req.body?.username || req.body?.name).toLowerCase();
    const phone = normalizePhone(identifier);
    let staff = db.prepare(`SELECT * FROM staff WHERE active=1 AND
      (phone=? OR name=? COLLATE NOCASE OR auth_user_id IN (SELECT id FROM auth_users WHERE email=? COLLATE NOCASE)) LIMIT 1`)
      .get(phone, identifier, identifier.includes('@') ? identifier : `${identifier}@staff.hoteli.local`);
    // Preserve the demo username/password accounts already used by the employee UI.
    if (!staff && identifier === 'admin 1') staff = db.prepare('SELECT * FROM staff WHERE auth_user_id=? AND active=1').get('demo-admin');
    if (!staff && identifier === 'employee 1') staff = db.prepare('SELECT * FROM staff WHERE auth_user_id=? AND active=1').get('demo-waiter');
    let valid = staff && await verifyPassword(req.body?.password ?? req.body?.pin, staff.pin_hash);
    if (!valid && staff?.auth_user_id) {
      const user = db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get(staff.auth_user_id);
      if (user) valid = await verifyPassword(req.body?.password ?? req.body?.pin, user.password_hash);
    }
    if (!staff || !valid) return res.status(401).json({ error: 'Username, phone, or password is incorrect.' });
    const token = crypto.randomBytes(24).toString('hex');
    withTransaction(()=>{
      db.prepare('INSERT INTO staff_sessions(token_hash,staff_id,expires_at) VALUES(?,?,?)').run(tokenDigest(token), staff.id, Date.now() + 12 * 60 * 60 * 1000);
      logAction(db, { actorId: String(staff.id), actorRole: staff.role, action: 'login', targetType: 'staff', targetId: staff.id });
    });
    return res.json({ token, role: staff.role, forcePasswordChange: Boolean(staff.force_password_change), user: { id: staff.id, name: staff.name, phone: staff.phone, role: staff.role } });
  } catch (error) { return next(error); }
});

router.post('/staff/logout', requireStaff, (req, res) => {
  const token = getToken(req);
  db.prepare('DELETE FROM staff_sessions WHERE token_hash=?').run(tokenDigest(token));
  if (req.legacyStaffSession) deleteSession(token);
  logAction(db, { actorId: String(req.staff.id), actorRole: req.staff.role, action: 'logout', targetType: 'staff', targetId: req.staff.id });
  return res.status(204).end();
});

router.get('/staff/me', requireStaff, (req, res) => res.json({
  user: { id: req.staff.id, name: req.staff.name, phone: req.staff.phone, role: req.staff.role },
  forcePasswordChange: Boolean(req.staff.force_password_change)
}));

router.patch('/staff/password', requireStaff, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const hash = await hashPassword(password);
    withTransaction(()=>{
      db.prepare('UPDATE staff SET pin_hash=?,force_password_change=0 WHERE id=?').run(hash.stored, req.staff.id);
      if (req.staff.auth_user_id) db.prepare('UPDATE auth_users SET password_hash=? WHERE id=?').run(hash.stored, req.staff.auth_user_id);
      logAction(db, { actorId: String(req.staff.id), actorRole: req.staff.role, action: 'password_change', targetType: 'staff', targetId: req.staff.id });
    });
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

export default router;

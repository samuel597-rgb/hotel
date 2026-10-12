import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import QRCode from 'qrcode';
import { db, deleteRecord, deleteSession, findUserByToken, issueSession, readRecords, writeRecord, tokenDigest } from './sqlite.js';
import authRoutes, { ensureSuperAdmin } from './auth.js';
import orderRoutes from './orders.js';
import messageRoutes from './messages.js';
import adminRoutes from './admin.js';
import profileRoutes from './profile.js';
import favoriteRoutes from './customer-favorites.js';
import streamRoutes from './stream.js';
import { calculateQuote } from './orders.js';
import { withTransaction } from './sqlite.js';
import { logAction } from './audit.js';
import { toCents, fromCents } from './money.js';
import { publish } from './events.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../hosting');
const uploadsDir = path.resolve(process.env.UPLOAD_DIR || path.join(here, '../uploads'));
fs.mkdirSync(uploadsDir, { recursive: true });
const imageExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const productUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => done(null, uploadsDir),
    filename: (_req, file, done) => done(null, `${Date.now()}-${crypto.randomUUID()}${imageExtensions[file.mimetype] || ''}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => imageExtensions[file.mimetype]
    ? done(null, true) : done(new Error('Only JPG, PNG, or WEBP product images are accepted.'))
});
const liveClients = new Map();
function publishPos(event, data, tableId = null) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [response, clientTableId] of liveClients) if (tableId && String(clientTableId) === String(tableId)) response.write(message);
}
const staticOrigins = [
  'https://hoteli-pos-api.onrender.com',
  'https://hotel1-cf53.onrender.com',
  'https://hotel-c5f3.onrender.com',
  'https://hoteli-poa.co.ke',
  'https://www.hoteli-poa.co.ke',
  'http://localhost:3000',
  'http://localhost:5173'
];
const extraOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const allowedOrigins = new Set([...staticOrigins, ...extraOrigins]);
const corsOptions = {
  origin(origin, done) {
    if (!origin || allowedOrigins.has(origin)) return done(null, true);
    return done(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-auth-token']
};
const scrypt = promisify(crypto.scrypt);
const safeEmail = value => String(value || '').trim().toLowerCase();
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const validRecordId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : crypto.randomUUID();
const jsonResponse = (res, status, payload) => res.status(status).json(payload);

app.disable('x-powered-by');
app.set('trust proxy', 1);
const crossOriginCors = cors(corsOptions);
function isSameOrigin(req) {
  const origin=req.get('Origin');
  return !origin || origin===`${req.protocol}://${req.get('host')}`;
}
app.use((req,res,next) => {
  // Same-origin requests do not require CORS, regardless of Render's generated hostname.
  if (isSameOrigin(req)) return next();
  return crossOriginCors(req,res,next);
});
app.options('*',(req,res,next) => isSameOrigin(req) ? res.sendStatus(204) : crossOriginCors(req,res,next));
app.use(express.json({ limit: '1mb' }));
app.use(streamRoutes);
app.use(authRoutes);
app.use(orderRoutes);
app.use(messageRoutes);
app.use(adminRoutes);
app.use(profileRoutes);
app.use(favoriteRoutes);

function bearerToken(req) { return /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1] || ''; }
function requireAuth(req, res, next) {
  const token=bearerToken(req)||String(req.get('x-auth-token')||'');
  req.user=token?findUserByToken(token):null;
  if(!req.user&&token){
    const staff=db.prepare(`SELECT s.id,s.auth_user_id,s.name,s.role FROM staff_sessions ss JOIN staff s ON s.id=ss.staff_id
      WHERE ss.token_hash=? AND ss.expires_at>? AND s.active=1`).get(tokenDigest(token),Date.now());
    if(staff)req.user={id:staff.auth_user_id||String(staff.id),uid:staff.auth_user_id||String(staff.id),email:'',role:staff.role,user_metadata:{full_name:staff.name,phone:'',avatar_url:''}};
  }
  if (!req.user) return jsonResponse(res, 401, { error: 'Your sign-in session is invalid or expired.' });
  return next();
}
function optionalAuth(req, _res, next) {
  const token=bearerToken(req)||String(req.get('x-auth-token')||'');
  req.user=token?findUserByToken(token):null;
  if(!req.user&&token){
    const staff=db.prepare(`SELECT s.id,s.auth_user_id,s.name,s.role FROM staff_sessions ss JOIN staff s ON s.id=ss.staff_id
      WHERE ss.token_hash=? AND ss.expires_at>? AND s.active=1`).get(tokenDigest(token),Date.now());
    if(staff)req.user={id:staff.auth_user_id||String(staff.id),uid:staff.auth_user_id||String(staff.id),email:'',role:staff.role,user_metadata:{full_name:staff.name,phone:'',avatar_url:''}};
  }
  return next();
}
function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next()
    : jsonResponse(res, 403, { error: 'You do not have permission to perform this action.' });
}
function userSummary(user) {
  const role = db.prepare('SELECT role FROM staff WHERE auth_user_id=?').get(user.id)?.role || user.role;
  const name = user.name || user.user_metadata?.full_name || '';
  return { id: user.id, uid: user.id, email: user.email, role,
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
    const user = db.prepare('SELECT id FROM auth_users WHERE email=?').get(account.email);
    db.prepare(`INSERT INTO staff(auth_user_id,name,role,pin_hash) VALUES(?,?,?,?)
      ON CONFLICT(auth_user_id) DO UPDATE SET name=excluded.name,role=excluded.role,pin_hash=excluded.pin_hash`)
      .run(user.id, account.name, account.role, passwordHash);
  }
}
async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const candidate = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function awardLoyaltyStamp(value) {
  const phone=String(value||'').replace(/[^+0-9]/g,'').slice(0,20);
  if(phone.length<7)return null;
  db.prepare(`INSERT INTO loyalty_accounts(phone,stamps) VALUES(?,1)
    ON CONFLICT(phone) DO UPDATE SET stamps=stamps+1,updated_at=CURRENT_TIMESTAMP`).run(phone);
  const account=db.prepare('SELECT phone,stamps,updated_at AS updatedAt FROM loyalty_accounts WHERE phone=?').get(phone);
  return {...account,rewardAvailable:account.stamps>=10};
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
  if (pathname.split('/')[0] === 'orders' && req.user.role === 'admin') return jsonResponse(res,403,{error:'Administrators can view order counts only.'}), false;
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

const handleLogin = asyncRoute(async (req, res) => {
  const identifier = safeEmail(req.body?.username || req.body?.email);
  const demoAccounts = { 'admin 1': 'demo-admin@hoteli.local', 'employee 1': 'demo-employee@hoteli.local' };
  const email = demoAccounts[identifier] || (identifier.includes('@') ? identifier : `${identifier}@staff.hoteli.local`);
  const password = String(req.body?.password || '');
  const row = getStoredUser(email);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return jsonResponse(res, 401, { error: 'Email or password is incorrect.' });
  }
  const token = issueSession(row.id);
  const user = userSummary(row);
  return jsonResponse(res, 200, req.path === '/api/login'
    ? { token, role: user.role, user }
    : { token, user });
});
app.post(['/api/auth/login', '/api/login'], loginLimiter, handleLogin);

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

app.use('/uploads', express.static(uploadsDir, { maxAge: '1d', immutable: true }));
app.get('/api/settings', (_req, res) => {
  const general = readRecords('settings', { id:'general' })[0]?.data || {};
  return res.json(general);
});
app.put('/api/settings', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const general = { ...(readRecords('settings', { id: 'general' })[0]?.data || {}), ...incoming };
  general.hotelName = String(general.hotelName || 'HOTELI POA').slice(0, 120);
  general.currency = 'KES';
  general.taxRate = Math.max(0, Math.min(100, Number(general.taxRate) || 0));
  general.taxMode = general.taxMode === 'excluded' ? 'excluded' : 'included';
  writeRecord('settings', 'general', general);
  for (const [key, value] of Object.entries(incoming)) {
    if (key !== 'general') writeRecord('settings', key, value);
  }
  return res.json({ success: true, settings: general });
});
app.get('/api/tables', (_req, res) => res.json(db.prepare('SELECT id,floor,number,status FROM tables ORDER BY floor,number').all()));
app.get('/api/admin/overview', requireAuth, allowRoles('manager','admin'), (_req,res) => {
  const orders = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN date(created_at)=date('now','localtime') THEN 1 ELSE 0 END) AS today,
    SUM(CASE WHEN status IN ('new','pending') THEN 1 ELSE 0 END) AS placed,
    SUM(CASE WHEN status='preparing' THEN 1 ELSE 0 END) AS preparing,
    SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready
    FROM orders WHERE COALESCE(status,'')!='cancelled'`).get();
  const staff = db.prepare(`SELECT s.id,s.name,s.role,COALESCE(p.last_seen,0) AS lastSeen
    FROM staff s LEFT JOIN staff_presence p ON p.user_id=s.auth_user_id
    ORDER BY s.role,s.name COLLATE NOCASE`).all().map(person => ({
      id:person.id,name:person.name,role:person.role,lastSeen:person.lastSeen,
      active:person.lastSeen > Date.now()-90000
    }));
  return res.json({ orders, staff });
});
app.post('/api/staff/presence', requireAuth, allowRoles('waiter','cashier','supervisor','manager','admin','kitchen'), (req,res) => {
  db.prepare(`INSERT INTO staff_presence(user_id,last_seen) VALUES(?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen`).run(req.user.id,Date.now());
  return res.json({ success:true });
});
app.get('/api/tables/:id/display', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const table = db.prepare('SELECT id,floor,number,display_token FROM tables WHERE id=?').get(Number(req.params.id));
  if (!table) return jsonResponse(res,404,{error:'Table not found.'});
  const displayUrl = `/display?table=${encodeURIComponent(`${table.floor} ${table.number}`)}&token=${encodeURIComponent(table.display_token)}`;
  return res.json({url:displayUrl,token:table.display_token,qrUrl:`/api/tables/${table.id}/qr.svg?token=${encodeURIComponent(table.display_token)}`});
});
app.get('/api/tables/:id/qr.svg', asyncRoute(async (req,res) => {
  const table=db.prepare('SELECT id,floor,number,display_token FROM tables WHERE id=? AND display_token=?').get(Number(req.params.id),String(req.query.token||''));
  if (!table) return jsonResponse(res,401,{error:'A valid table display token is required.'});
  const displayUrl=new URL(`/display?table=${encodeURIComponent(`${table.floor} ${table.number}`)}&token=${encodeURIComponent(table.display_token)}`,`${req.protocol}://${req.get('host')}`).href;
  const svg=await QRCode.toString(displayUrl,{type:'svg',margin:1,width:256,color:{dark:'#0A2540',light:'#FFFFFF'}});
  return res.type('image/svg+xml').set('Cache-Control','private, no-store').send(svg);
}));
app.post('/api/tables', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const floor = String(req.body?.floor || 'Main Floor').trim().slice(0, 60);
  const number = Number(req.body?.number);
  if (!floor || !Number.isInteger(number) || number < 1) return jsonResponse(res, 400, { error: 'Floor and a positive table number are required.' });
  try {
    const info = db.prepare('INSERT INTO tables(floor,number,status) VALUES(?,?,?)').run(floor, number, 'available');
    return jsonResponse(res, 201, db.prepare('SELECT * FROM tables WHERE id=?').get(info.lastInsertRowid));
  } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return jsonResponse(res, 409, { error: 'That table already exists on this floor.' }); throw error; }
});
app.put('/api/tables/:id/status', requireAuth, allowRoles('waiter','cashier','supervisor','manager','admin'), (req, res) => {
  const status = String(req.body?.status || '');
  if (!['available','occupied','reserved','cleaning'].includes(status)) return jsonResponse(res, 400, { error: 'Invalid table status.' });
  const result = db.prepare('UPDATE tables SET status=? WHERE id=?').run(status, Number(req.params.id));
  if (!result.changes) return jsonResponse(res, 404, { error: 'Table not found.' });
  return res.json(db.prepare('SELECT * FROM tables WHERE id=?').get(Number(req.params.id)));
});
app.delete('/api/tables/:id', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const result = db.prepare('DELETE FROM tables WHERE id=?').run(Number(req.params.id));
  if (!result.changes) return jsonResponse(res, 404, { error: 'Table not found.' });
  return res.status(204).end();
});
app.get('/api/staff', requireAuth, allowRoles('manager','admin'), (_req, res) => res.json(db.prepare(`
  SELECT s.id,s.name,s.role,s.auth_user_id AS userId,u.email FROM staff s LEFT JOIN auth_users u ON u.id=s.auth_user_id ORDER BY s.name COLLATE NOCASE
`).all()));
app.post('/api/staff', requireAuth, allowRoles('manager','admin'), asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 60);
  const role = ['waiter','cashier','supervisor','manager','kitchen'].includes(req.body?.role) ? req.body.role : 'waiter';
  const password = String(req.body?.password || '');
  if (name.length < 2 || !/^[a-z0-9._-]{2,60}$/.test(username) || password.length < 8) return jsonResponse(res, 400, { error: 'Enter a name, username, and password of at least 8 characters.' });
  const email = `${username}@staff.hoteli.local`, id = crypto.randomUUID(), hash = await createPasswordHash(password);
  try {
    db.prepare('INSERT INTO auth_users(id,email,name,password_hash,role) VALUES(?,?,?,?,?)').run(id,email,name,hash,role === 'kitchen' ? 'waiter' : role);
    db.prepare('INSERT INTO staff(auth_user_id,name,role,pin_hash) VALUES(?,?,?,?)').run(id,name,role,hash);
  } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return jsonResponse(res,409,{error:'That username already exists.'}); throw error; }
  return jsonResponse(res,201,{id,userId:id,name,username,role});
}));
app.put('/api/staff/:id', requireAuth, allowRoles('manager','admin'), asyncRoute(async (req, res) => {
  const member = db.prepare('SELECT * FROM staff WHERE id=?').get(Number(req.params.id));
  if (!member) return jsonResponse(res,404,{error:'Staff member not found.'});
  const name = String(req.body?.name ?? member.name).trim().slice(0,120);
  const role = ['waiter','cashier','supervisor','manager','kitchen'].includes(req.body?.role) ? req.body.role : member.role;
  db.prepare('UPDATE staff SET name=?,role=? WHERE id=?').run(name,role,member.id);
  if (member.auth_user_id) {
    const password = String(req.body?.password || '');
    const authRole = role === 'kitchen' ? 'waiter' : role;
    if (password.length >= 8) db.prepare('UPDATE auth_users SET name=?,role=?,password_hash=? WHERE id=?').run(name,authRole,await createPasswordHash(password),member.auth_user_id);
    else db.prepare('UPDATE auth_users SET name=?,role=? WHERE id=?').run(name,authRole,member.auth_user_id);
  }
  return res.json({id:member.id,name,role});
}));
app.delete('/api/staff/:id', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const member = db.prepare('SELECT * FROM staff WHERE id=?').get(Number(req.params.id));
  if (!member) return jsonResponse(res,404,{error:'Staff member not found.'});
  if (member.auth_user_id?.startsWith('demo-')) return jsonResponse(res,409,{error:'Built-in demo accounts cannot be deleted.'});
  db.prepare('DELETE FROM staff WHERE id=?').run(member.id);
  if (member.auth_user_id) db.prepare('DELETE FROM auth_users WHERE id=?').run(member.auth_user_id);
  return res.status(204).end();
});
app.get('/api/register/current',requireAuth,allowRoles('cashier','supervisor','manager','admin'),(_req,res)=>res.json(db.prepare("SELECT * FROM register_sessions WHERE status='open' ORDER BY id DESC LIMIT 1").get()||null));
app.post('/api/register/open',requireAuth,allowRoles('cashier','supervisor','manager','admin'),(req,res)=>{
  const staffId=db.prepare('SELECT id FROM staff WHERE auth_user_id=?').get(req.user.id)?.id||null;
  const current=db.prepare("SELECT id FROM register_sessions WHERE status='open' LIMIT 1").get();
  if(current) return jsonResponse(res,409,{error:'A register is already open.',id:current.id});
  const openingCash=Math.max(0,Number(req.body?.openingCash)||0),openingNote=String(req.body?.openingNote||'').slice(0,500);
  const result=db.prepare('INSERT INTO register_sessions(status,opening_cash,opening_note,staff_id) VALUES(?,?,?,?)').run('open',openingCash,openingNote,staffId);
  return jsonResponse(res,201,db.prepare('SELECT * FROM register_sessions WHERE id=?').get(result.lastInsertRowid));
});
app.post('/api/register/close',requireAuth,allowRoles('cashier','supervisor','manager','admin'),(req,res)=>{
  const current=db.prepare("SELECT * FROM register_sessions WHERE status='open' ORDER BY id DESC LIMIT 1").get();
  if(!current) return jsonResponse(res,404,{error:'No register is open.'});
  db.prepare("UPDATE register_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?").run(current.id);
  return res.json({success:true,id:current.id});
});
app.get('/api/loyalty/:phone',requireAuth,allowRoles('waiter','cashier','supervisor','manager','admin'),(req,res)=>{
  const phone=String(req.params.phone||'').replace(/[^+0-9]/g,'').slice(0,20);
  const account=db.prepare('SELECT phone,stamps,updated_at AS updatedAt FROM loyalty_accounts WHERE phone=?').get(phone)||{phone,stamps:0};
  return res.json({...account,rewardAvailable:account.stamps>=10});
});
app.post('/api/loyalty/stamp',requireAuth,allowRoles('waiter','cashier','supervisor','manager','admin'),(req,res)=>{
  const phone=String(req.body?.phone||'').replace(/[^+0-9]/g,'').slice(0,20);
  if(phone.length<7) return jsonResponse(res,400,{error:'Enter a valid phone number.'});
  return res.json(awardLoyaltyStamp(phone));
});
app.post('/api/loyalty/redeem',requireAuth,allowRoles('cashier','supervisor','manager','admin'),(req,res)=>{
  const phone=String(req.body?.phone||'').replace(/[^+0-9]/g,'').slice(0,20);
  const account=db.prepare('SELECT phone,stamps FROM loyalty_accounts WHERE phone=?').get(phone);
  if(!account||account.stamps<10)return jsonResponse(res,409,{error:'Ten paid-order stamps are needed for a free item.'});
  db.prepare('UPDATE loyalty_accounts SET stamps=stamps-10,updated_at=CURRENT_TIMESTAMP WHERE phone=?').run(phone);
  return res.json({...db.prepare('SELECT phone,stamps,updated_at AS updatedAt FROM loyalty_accounts WHERE phone=?').get(phone),redeemed:true});
});
app.get(['/api/stream','/api/pos/stream'], (req, res) => {
  const displayToken = String(req.query.token || '');
  const table = displayToken ? db.prepare('SELECT id,floor,number FROM tables WHERE display_token=?').get(displayToken) : null;
  if (!table) return jsonResponse(res,401,{error:'A valid table display token is required.'});
  res.set({ 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache, no-transform', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
  res.flushHeaders?.();
  liveClients.set(res,table.id);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ table:`${table.floor} ${table.number}`, items:[] })}\n\n`);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', () => { clearInterval(keepAlive); liveClients.delete(res); });
});
app.post('/api/pos/cart', optionalAuth, (req, res) => {
  const tableId=Number(req.body?.tableId);
  if (!Number.isInteger(tableId) || !db.prepare('SELECT id FROM tables WHERE id=?').get(tableId)) return res.status(204).end();
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0,100).map(item => ({
    productId:String(item.productId || '').slice(0,128), name:String(item.name || '').slice(0,120), qty:Math.max(1,Math.min(1000,Number(item.qty)||1)), price:Math.max(0,Number(item.price)||0)
  })) : [];
  publishPos('cart', { table:String(req.body?.table || '').slice(0,40), channel:String(req.body?.channel || 'takeout'), items },tableId);
  return res.status(204).end();
});
app.get('/api/products', (req, res) => {
  const rows = readRecords('products');
  return res.json(rows.map(row => ({ id: row.id, ...row.data })).filter(item => item.isAvailable !== false));
});

const categoryLookup = value => db.prepare('SELECT * FROM categories WHERE CAST(id AS TEXT)=? OR name=? COLLATE NOCASE').get(String(value ?? ''), String(value ?? ''));
function productRowById(value) {
  return db.prepare('SELECT * FROM products WHERE CAST(id AS TEXT)=? OR firestore_id=?').get(String(value), String(value));
}
function respondProduct(res, row, status = 200) {
  if (!row) return jsonResponse(res, 404, { error: 'Product not found.' });
  const record = readRecords('products', { id: String(row.id) })[0];
  return jsonResponse(res, status, { id: record?.id || String(row.id), ...record?.data });
}
function removeProductUpload(value) {
  const prefix='/uploads/';
  if (!value || !String(value).startsWith(prefix)) return;
  const filename=path.basename(String(value).slice(prefix.length));
  const target=path.resolve(uploadsDir,filename);
  if (path.dirname(target)===uploadsDir) fs.rm(target,{force:true},()=>{});
}
app.post('/api/products', requireAuth, allowRoles('manager','admin'), productUpload.single('image'), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  let priceCents;
  try { priceCents=toCents(req.body?.price); } catch { return jsonResponse(res,400,{error:'Enter a valid non-negative price.'}); }
  const price=Number(fromCents(priceCents));
  const category = categoryLookup(req.body?.category_id || req.body?.categoryId);
  const discount = Math.max(0,Math.min(100,Number(req.body?.discount_percent)||0));
  if (!name || !Number.isFinite(price) || price < 0 || !category) return jsonResponse(res, 400, { error: 'Name, category, and a non-negative price are required.' });
  const imagePath = req.file ? `/uploads/${req.file.filename}` : '';
  const info = withTransaction(()=>{
    const result=db.prepare(`INSERT INTO products(name,price,price_cents,category,category_id,sub_category,description,discount_percent,image_path,image_url,is_available,active)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`).run(name, price,priceCents, category.name.toLowerCase() === 'drinks' ? 'drinks' : 'food', category.id, category.name,
      String(req.body?.description || '').slice(0, 2000), discount, imagePath || null, imagePath);
    db.prepare('UPDATE categories SET active=1 WHERE id=?').run(category.id);
    logAction(db,{actorId:req.user.id,actorRole:req.user.role,action:'product.create',targetType:'product',targetId:result.lastInsertRowid});
    return result;
  });
  return respondProduct(res, db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid), 201);
});
app.put('/api/products/:id', requireAuth, allowRoles('manager','admin'), productUpload.single('image'), (req, res) => {
  const existing = productRowById(req.params.id);
  if (!existing) return jsonResponse(res, 404, { error: 'Product not found.' });
  const name = String(req.body?.name ?? existing.name).trim().slice(0, 120);
  let priceCents=Number(existing.price_cents)||toCents(existing.price||0);
  if(req.body?.price!=null){try{priceCents=toCents(req.body.price);}catch{return jsonResponse(res,400,{error:'Enter a valid non-negative price.'});}}
  const price=Number(fromCents(priceCents));
  const category = req.body?.category_id || req.body?.categoryId ? categoryLookup(req.body.category_id || req.body.categoryId)
    : db.prepare('SELECT * FROM categories WHERE id=?').get(existing.category_id);
  const discount = req.body?.discount_percent == null ? Number(existing.discount_percent)||0 : Math.max(0,Math.min(100,Number(req.body.discount_percent)||0));
  if (!name || !Number.isFinite(price) || price < 0 || !category) return jsonResponse(res, 400, { error: 'Name, category, and a non-negative price are required.' });
  const imagePath = req.file ? `/uploads/${req.file.filename}` : (String(req.body?.removeImage)==='true' ? '' : (existing.image_path || ''));
  if (req.file || String(req.body?.removeImage)==='true') removeProductUpload(existing.image_path);
  withTransaction(()=>{
    db.prepare(`UPDATE products SET name=?,price=?,price_cents=?,category=?,category_id=?,sub_category=?,description=?,discount_percent=?,image_path=?,image_url=?,active=1,is_available=1 WHERE id=?`)
      .run(name, price,priceCents, category.name.toLowerCase() === 'drinks' ? 'drinks' : 'food', category.id, category.name,
        String(req.body?.description ?? existing.description ?? '').slice(0, 2000), discount, imagePath || null, imagePath, existing.id);
    db.prepare('UPDATE categories SET active=1 WHERE id=?').run(category.id);
    logAction(db,{actorId:req.user.id,actorRole:req.user.role,action:'product.update',targetType:'product',targetId:existing.id});
  });
  return respondProduct(res, db.prepare('SELECT * FROM products WHERE id=?').get(existing.id));
});
app.delete('/api/products/:id', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const product = productRowById(req.params.id);
  if (!product) return jsonResponse(res, 404, { error: 'Product not found.' });
  withTransaction(()=>{
    db.prepare('UPDATE products SET active=0,is_available=0 WHERE id=?').run(product.id);
    if (product.category_id) db.prepare(`UPDATE categories SET active=0 WHERE id=? AND NOT EXISTS (
      SELECT 1 FROM products WHERE category_id=? AND active=1 AND is_available=1
    )`).run(product.category_id, product.category_id);
    logAction(db,{actorId:req.user.id,actorRole:req.user.role,action:'product.delete',targetType:'product',targetId:product.id});
  });
  return res.status(204).end();
});
app.post('/api/products/import-legacy', requireAuth, allowRoles('manager','admin'), (req, res) => {
  if (db.prepare("SELECT type FROM sqlite_master WHERE name='product'").get()?.type !== 'table') return jsonResponse(res,404,{error:'No physical product table is available to import.'});
  const rows=db.prepare('SELECT * FROM product').all();
  let imported=0,skipped=0;
  const insert=db.prepare(`INSERT INTO products(name,price,category,category_id,sub_category,description,image_path,image_url,firestore_id,is_available,active)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    const externalId=String(row.firestore_id ?? row.id ?? '');
    if (externalId && db.prepare('SELECT id FROM products WHERE firestore_id=? OR CAST(id AS TEXT)=?').get(externalId,externalId)) { skipped++; continue; }
    const name=String(row.name || row.product_name || '').trim();
    if (!name || db.prepare('SELECT id FROM products WHERE name=? COLLATE NOCASE').get(name)) { skipped++; continue; }
    const categoryName=String(row.sub_category || row.categoryId || row.category || 'Food').trim();
    let category=categoryLookup(categoryName);
    if (!category) { const info=db.prepare('INSERT INTO categories(name,icon,sort_order) VALUES(?,?,?)').run(categoryName,'🍽️',Number(db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM categories').get().n)); category=db.prepare('SELECT * FROM categories WHERE id=?').get(info.lastInsertRowid); }
    const image=String(row.image_path || row.image_url || row.imageUrl || '');
    const active=row.active===0 || row.is_available===0 || row.isAvailable===false ? 0 : 1;
    insert.run(name,Number(row.price)||0,String(row.department || row.category || 'food'),category.id,category.name,String(row.description||''),image||null,image,externalId||null,active,active);
    imported++;
  }
  return res.json({success:true,imported,skipped});
});

app.get('/api/categories', (_req, res) => res.json(db.prepare(`SELECT c.id,c.name,c.icon,c.sort_order FROM categories c
  WHERE c.active=1 AND EXISTS (SELECT 1 FROM products p WHERE p.category_id=c.id AND p.active=1 AND p.is_available=1)
  ORDER BY c.sort_order,c.name COLLATE NOCASE`).all()));
app.post('/api/categories', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return jsonResponse(res, 400, { error: 'Category name is required.' });
  try {
    db.prepare(`INSERT INTO categories(name,icon,sort_order,active) VALUES(?,?,?,1)
      ON CONFLICT(name) DO UPDATE SET icon=excluded.icon,sort_order=excluded.sort_order,active=1`)
      .run(name, String(req.body?.icon || ''), Number(req.body?.sort_order) || 0);
    return jsonResponse(res, 201, db.prepare('SELECT * FROM categories WHERE name=? COLLATE NOCASE').get(name));
  } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return jsonResponse(res, 409, { error: 'That category already exists.' }); throw error; }
});
app.put('/api/categories/:id', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const current = db.prepare('SELECT * FROM categories WHERE id=?').get(Number(req.params.id));
  if (!current) return jsonResponse(res, 404, { error: 'Category not found.' });
  const name = String(req.body?.name ?? current.name).trim().slice(0, 80);
  db.prepare('UPDATE categories SET name=?,icon=?,sort_order=? WHERE id=?').run(name, String(req.body?.icon ?? current.icon), Number(req.body?.sort_order ?? current.sort_order), current.id);
  db.prepare('UPDATE products SET sub_category=? WHERE category_id=?').run(name, current.id);
  return res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(current.id));
});
app.delete('/api/categories/:id', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM categories WHERE id=?').get(id)) return jsonResponse(res, 404, { error: 'Category not found.' });
  const used = db.prepare('SELECT COUNT(*) AS count FROM products WHERE category_id=? AND active=1').get(id).count;
  if (used) return jsonResponse(res, 409, { error: 'Move or remove products in this category first.' });
  db.prepare('UPDATE categories SET active=0 WHERE id=?').run(id);
  return res.status(204).end();
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
  if (req.user.role === 'admin') return jsonResponse(res, 403, { error:'Administrators can view order counts only.' });
  let rows = readRecords('orders');
  if (req.user.role === 'customer') rows = rows.filter(row => row.data.customerId === req.user.id);
  if (req.user.role === 'waiter') rows = rows.filter(row => row.data.waiterId === req.user.id);
  if (['cashier','supervisor'].includes(req.user.role)) rows = rows.filter(row => row.data.paymentStatus === 'pending');
  return res.json(rows.map(row => ({ id: row.id, ...row.data })).filter(order => !order.archivedAt)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)));
});
app.get('/api/orders/:id', requireAuth, (req, res) => {
  if (req.user.role === 'admin') return jsonResponse(res,403,{error:'Administrators can view order counts only.'});
  const row = readRecords('orders', { id: req.params.id })[0];
  if (!row) return jsonResponse(res,404,{error:'Order not found.'});
  if (row.data.customerId !== req.user.id && !['waiter','cashier','supervisor','manager','admin'].includes(req.user.role)) return jsonResponse(res,403,{error:'You cannot view this order.'});
  return res.json({ id: row.id, ...row.data });
});
app.post('/api/orders', optionalAuth, (req, res) => {
  const body=req.body||{};
  if(['subtotal','subtotalCents','tax','taxCents','tip','tipCents','total','totalCents'].some(key=>key in body))
    return jsonResponse(res,400,{error:'Send product IDs and quantities only. Prices and totals are calculated by the server.'});
  const channel=['dine_in','takeout','delivery'].includes(body.channel)?body.channel:(body.table?'dine_in':'takeout');
  let quote;
  try{quote=calculateQuote(body.items,channel,body.tipPercent);}catch(error){return jsonResponse(res,400,{error:error.message});}
  const id=crypto.randomUUID(), role=req.user?.role||'customer';
  const lines=quote.lines.map(line=>({id:crypto.randomUUID(),productId:String(line.productId),name:line.name,qty:line.qty,quantity:line.qty,price:line.priceCents/100,priceCentsSnapshot:line.priceCents,notes:line.notes}));
  const tableId=channel==='dine_in'?Number(body.tableId)||null:null;
  const order={id,table:String(body.table||'').slice(0,60),tableId,channel,
    customer:String(body.customer||(req.user?.user_metadata.full_name||'')).slice(0,120),
    customerId:role==='customer'?req.user?.id||null:null,
    waiterId:role==='customer'?null:req.user?.id||null,waiterName:String(req.user?.user_metadata.full_name||req.user?.email||'Staff').slice(0,120),
    status:'placed',paymentStatus:'pending',paymentMethod:channel==='delivery'?'cash_on_delivery':'pay_at_counter',
    subtotal:quote.subtotalCents/100,tax:quote.taxCents/100,taxMode:quote.taxMode,taxRate:quote.taxRate,tip:quote.tipCents/100,
    total:quote.totalCents/100,currency:'KES',notes:String(body.notes||'').slice(0,1000),riderName:'',riderPhone:'',createdAt:new Date().toISOString(),lines};
  if(channel==='delivery'&&String(body.address||'').trim().length<4)return jsonResponse(res,400,{error:'Enter the delivery address.'});
  withTransaction(()=>{
    writeRecord('orders',id,order,req.user?.id||null);
    const row=db.prepare('SELECT id FROM orders WHERE legacy_order_id=?').get(id);
    db.prepare('INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,?,?,?)').run(row.id,'placed',req.user?.id||null,'Order submitted');
    if(channel==='delivery')db.prepare('INSERT INTO delivery_details(order_id,address_text,landmark,notes) VALUES(?,?,?,?)')
      .run(row.id,String(body.address||'').slice(0,1000),String(body.landmark||'').slice(0,300),String(body.riderNotes||'').slice(0,500));
    if(tableId)db.prepare("UPDATE tables SET status='occupied' WHERE id=?").run(tableId);
    logAction(db,{actorId:req.user?.id||null,actorRole:role,action:'order.create',targetType:'order',targetId:id,meta:{channel,totalCents:quote.totalCents}});
  });
  publishPos('order',{id,status:order.status,total:order.total,table:order.table,channel},tableId);
  return jsonResponse(res,201,{success:true,id,orderId:id,order,lines,synced:true});
});
app.put('/api/orders/:id/status', requireAuth, allowRoles('waiter','cashier','supervisor','manager','kitchen'), (req, res) => {
  const nextStatus = String(req.body?.status || '');
  const allowedFrom={new:['confirmed','cancelled'],placed:['confirmed','cancelled'],confirmed:['preparing','cancelled'],preparing:['ready','cancelled'],ready:['delivered','out_for_delivery','cancelled'],out_for_delivery:['delivered','cancelled'],delivered:['paid'],paid:[],cancelled:[]};
  if (!Object.hasOwn(allowedFrom,nextStatus)) return jsonResponse(res,400,{error:'Invalid order status.'});
  const row = readRecords('orders',{id:req.params.id})[0];
  if (!row) return jsonResponse(res,404,{error:'Order not found.'});
  if(!allowedFrom[row.data.status]?.includes(nextStatus))return jsonResponse(res,400,{error:`Order cannot move from ${row.data.status} to ${nextStatus}.`});
  const order = { ...row.data, status: nextStatus, paymentStatus: nextStatus === 'paid' ? 'paid' : row.data.paymentStatus };
  withTransaction(()=>{
    writeRecord('orders',req.params.id,order,row.owner_id);
    const normalized=db.prepare('SELECT id,customer_id FROM orders WHERE legacy_order_id=?').get(String(req.params.id));
    if(normalized)db.prepare('INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,?,?,?)').run(normalized.id,nextStatus,String(req.user.id),'Updated from staff workspace');
    logAction(db,{actorId:String(req.user.id),actorRole:req.user.role,action:'order.status.change',targetType:'order',targetId:req.params.id,meta:{from:row.data.status,to:nextStatus}});
  });
  const normalized=db.prepare('SELECT customer_id FROM orders WHERE legacy_order_id=?').get(String(req.params.id));
  if(normalized?.customer_id)publish(`customer:${normalized.customer_id}`,'order.status',{scope:`customer:${normalized.customer_id}`,order:{id:req.params.id,status:nextStatus}});
  publish('presence','order.status',{id:req.params.id,status:nextStatus});publish('kitchen','order.status',{id:req.params.id,status:nextStatus});publish('admin','order.status',{id:req.params.id,status:nextStatus});
  publishPos('order', { id:req.params.id, status:order.status, total:order.total, table:order.table, channel:order.channel }, order.tableId);
  return res.json({id:req.params.id,...order});
});
app.post('/api/orders/:id/split',requireAuth,allowRoles('cashier','supervisor','manager'),(req,res)=>{
  const source=readRecords('orders',{id:req.params.id})[0];
  if(!source)return jsonResponse(res,404,{error:'Order not found.'});
  if(source.data.paymentStatus==='paid')return jsonResponse(res,409,{error:'Paid orders cannot be split.'});
  const requested=Array.isArray(req.body?.lines)?req.body.lines:[];
  if(!requested.length)return jsonResponse(res,400,{error:'Select at least one order line to split.'});
  const remaining=[...source.data.lines],splitLines=[];
  for(const selection of requested){
    const index=remaining.findIndex(line=>String(line.id)===String(selection.id));
    if(index<0)continue;
    const line=remaining[index],qty=Math.min(Number(line.qty||line.quantity),Math.max(0,Number(selection.qty)||0));
    if(!qty)continue;
    splitLines.push({...line,qty,quantity:qty,subtotal:Number(line.price)*qty});
    const left=Number(line.qty||line.quantity)-qty;
    if(left)remaining[index]={...line,qty:left,quantity:left,subtotal:Number(line.price)*left};else remaining.splice(index,1);
  }
  if(!splitLines.length||!remaining.length)return jsonResponse(res,400,{error:'A split must leave at least one item on each order.'});
  const sourceSubtotal=remaining.reduce((sum,line)=>sum+Number(line.price)*Number(line.qty||line.quantity),0);
  const splitSubtotal=splitLines.reduce((sum,line)=>sum+Number(line.price)*Number(line.qty||line.quantity),0);
  const ratio=Number(source.data.subtotal)>0?splitSubtotal/Number(source.data.subtotal):0;
  const newId=crypto.randomUUID();
  const splitOrder={...source.data,id:newId,lines:splitLines,subtotal:splitSubtotal,tax:Number(source.data.tax||0)*ratio,tip:Number(source.data.tip||0)*ratio,total:splitSubtotal+((source.data.taxMode==='excluded')?Number(source.data.tax||0)*ratio:0)+Number(source.data.tip||0)*ratio,createdAt:new Date().toISOString()};
  const remainingOrder={...source.data,lines:remaining,subtotal:sourceSubtotal,tax:Number(source.data.tax||0)*(1-ratio),tip:Number(source.data.tip||0)*(1-ratio),total:sourceSubtotal+((source.data.taxMode==='excluded')?Number(source.data.tax||0)*(1-ratio):0)+Number(source.data.tip||0)*(1-ratio)};
  writeRecord('orders',req.params.id,remainingOrder,source.owner_id);writeRecord('orders',newId,splitOrder,source.owner_id);
  return jsonResponse(res,201,{success:true,source:remainingOrder,split:splitOrder});
});
app.post('/api/orders/merge',requireAuth,allowRoles('cashier','supervisor','manager'),(req,res)=>{
  const ids=Array.isArray(req.body?.orderIds)?[...new Set(req.body.orderIds.map(String))]:[];
  if(ids.length<2||ids.length>10)return jsonResponse(res,400,{error:'Choose 2 to 10 orders to merge.'});
  const orders=ids.map(id=>readRecords('orders',{id})[0]);
  if(orders.some(order=>!order))return jsonResponse(res,404,{error:'One or more orders were not found.'});
  if(orders.some(order=>order.data.paymentStatus==='paid'))return jsonResponse(res,409,{error:'Paid orders cannot be merged.'});
  const primary=orders[0],lines=orders.flatMap(order=>order.data.lines||[]),subtotal=orders.reduce((sum,order)=>sum+Number(order.data.subtotal||0),0),tax=orders.reduce((sum,order)=>sum+Number(order.data.tax||0),0),tip=orders.reduce((sum,order)=>sum+Number(order.data.tip||0),0);
  const merged={...primary.data,lines,subtotal,tax,tip,total:orders.reduce((sum,order)=>sum+Number(order.data.total||0),0),mergedOrderIds:ids.slice(1)};
  writeRecord('orders',primary.id,merged,primary.owner_id);
  for(const source of orders.slice(1))writeRecord('orders',source.id,{...source.data,archivedAt:new Date().toISOString(),mergedInto:primary.id},source.owner_id);
  return res.json({success:true,order:merged});
});
app.patch('/api/orders/:id/payment', requireAuth, allowRoles('cashier','supervisor','manager'), (req, res) => {
  const row = readRecords('orders', { id: req.params.id })[0];
  if (!row) return jsonResponse(res, 404, { error: 'Order not found.' });
  if(row.data.status!=='delivered')return jsonResponse(res,400,{error:'An order can be marked paid only after it is delivered.'});
  if (row.data.paymentStatus === 'paid') return jsonResponse(res, 409, { error: 'This order is already paid.' });
  withTransaction(()=>{
    writeRecord('orders', req.params.id, { ...row.data, status: 'paid', paymentStatus: 'paid', paymentMethod: req.body?.paymentMethod || 'cash', paidAt: new Date().toISOString() }, row.owner_id);
    const normalized=db.prepare('SELECT id,customer_id FROM orders WHERE legacy_order_id=?').get(String(req.params.id));
    if(normalized){db.prepare("INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,'paid',?,'Payment received')").run(normalized.id,String(req.user.id));logAction(db,{actorId:String(req.user.id),actorRole:req.user.role,action:'order.paid',targetType:'order',targetId:req.params.id});}
  });
  const loyalty=row.data.customerPhone?awardLoyaltyStamp(row.data.customerPhone):null;
  return res.json({ success: true, loyalty });
});
app.patch('/api/orders/:id/archive', requireAuth, allowRoles('manager'), (req, res) => {
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
  publish(`team:${data.team}`,'message',{scope:`team:${data.team}`,message:{id,senderId:data.fromUid,senderName:data.fromName,senderRole:req.user.role,body:text,createdAt:data.createdAt}});
  return jsonResponse(res, 201, { success: true, id, data });
});
app.put('/api/settings/general', requireAuth, allowRoles('manager','admin'), (req, res) => {
  const data = { ...(readRecords('settings', { id: 'general' })[0]?.data || {}), ...req.body,
    id: 'general', hotelName: String(req.body?.hotelName || 'HOTELI POA').slice(0, 120), currency: 'KES',
    taxRate: Math.max(0, Math.min(100, Number(req.body?.taxRate) || 0)), taxMode: req.body?.taxMode === 'excluded' ? 'excluded' : 'included' };
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
await ensureSuperAdmin();

app.get(['/portal','/portal/'], (_req,res)=>res.sendFile(path.join(webRoot,'portal/index.html')));
app.get(['/staff','/staff/','/staff/login','/staff/login/','/staff/login.html','/admin','/admin/','/admin/login','/admin/login/','/admin/login.html','/manager','/kitchen','/waiter'], (_req,res)=>res.redirect(308,'/portal'));
app.get(['/admin/staff.html','/admin/audit.html','/admin/settings.html'], (_req,res)=>res.sendFile(path.join(webRoot,'admin/dashboard.html')));
app.get('/employee', (_req, res) => res.redirect('/app/#pos'));
app.get('/display', (_req, res) => res.sendFile(path.join(webRoot, 'display.html')));
app.get(['/','/index.html','/auth.html'], (_req, res) => res.sendFile(path.join(webRoot, 'app/index.html')));
app.get(['/app','/app/'], (_req, res) => res.sendFile(path.join(webRoot, 'app/index.html')));
app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
app.use('/uploads',express.static(uploadsDir,{maxAge:'1d',immutable:true}));
app.use((error, _req, res, _next) => {
  console.error('Request failed:', error?.message || error);
  if (res.headersSent) return;
  if (error.message?.startsWith('CORS blocked origin:')) return res.status(403).json({ error: error.message });
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Image must be 2 MB or smaller.' : error.message });
  if (error.message?.startsWith('Only JPG')) return res.status(400).json({ error: error.message });
  return res.status(error.status || 500).json({ error: error.status ? error.message : 'The request could not be completed.' });
});

app.listen(port, () => console.log(`HOTELI POA SQLite demo listening on ${port}; database ${process.env.DB_PATH || './hoteli_poa.db'}`));

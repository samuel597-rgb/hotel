import express from 'express';
import { db, tokenDigest } from './sqlite.js';
import { subscribe, unsubscribe } from './events.js';

const router = express.Router();
const staffRoles = ['super_admin', 'admin', 'manager', 'front_desk', 'kitchen', 'employee', 'waiter', 'cashier', 'supervisor'];

function resolveActor(token) {
  if (!token) return null;
  const digest = tokenDigest(token);
  const customer = db.prepare(`SELECT c.id,c.name,'customer' AS role FROM customer_sessions s
    JOIN customers c ON c.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>? AND c.active=1`).get(digest, Date.now());
  if (customer) return { ...customer, type: 'customer' };
  const staff = db.prepare(`SELECT s.id,s.name,s.role FROM staff_sessions ss JOIN staff s ON s.id=ss.staff_id
    WHERE ss.token_hash=? AND ss.expires_at>? AND s.active=1`).get(digest, Date.now());
  return staff && staffRoles.includes(staff.role) ? { ...staff, type: 'staff' } : null;
}

function canSubscribe(actor, scope) {
  if (scope === 'presence') return actor.type === 'staff' && ['super_admin','admin','manager','front_desk'].includes(actor.role);
  if (scope === 'admin') return actor.type === 'staff' && ['super_admin','admin','manager'].includes(actor.role);
  if (scope === 'kitchen') return actor.type === 'staff' && ['super_admin','admin','manager','kitchen'].includes(actor.role);
  if (/^team:[\w -]{1,60}$/.test(scope)) return actor.type==='staff' && staffRoles.includes(actor.role);
  const role= /^role:([\w-]+)$/.exec(scope);
  if(role)return actor.type==='staff'&&actor.role===role[1];
  const customer = /^customer:([\w-]+)$/.exec(scope);
  if (customer) return actor.type === 'customer' && actor.id === customer[1]
    || actor.type === 'staff' && ['super_admin','admin','manager','front_desk'].includes(actor.role);
  const thread = /^thread:(\d+)$/.exec(scope);
  if (thread && actor.type === 'staff') {
    const row = db.prepare('SELECT thread_type FROM staff_threads WHERE id=?').get(Number(thread[1]));
    if (!row) return false;
    if (row.thread_type === 'kitchen') return ['super_admin','admin','manager','kitchen','front_desk','waiter','cashier','supervisor'].includes(actor.role);
    return ['super_admin','admin','manager','front_desk'].includes(actor.role);
  }
  return false;
}

function presencePayload() {
  const since = Date.now() - 120000;
  return {
    staff: db.prepare('SELECT id,name,role,last_seen AS lastSeen,last_page AS currentPage FROM staff WHERE active=1 AND last_seen>? ORDER BY name').all(since),
    customers: db.prepare('SELECT id,name,last_seen AS lastSeen,last_page AS currentPage FROM customers WHERE active=1 AND last_seen>? ORDER BY name').all(since),
    orders: db.prepare("SELECT legacy_order_id AS id,status,channel,table_name AS table,updated_at AS updatedAt FROM orders WHERE status='preparing' ORDER BY created_at").all()
  };
}

router.get('/api/stream', (req, res) => {
  const actor = resolveActor(String(req.query.token || '').slice(0, 256));
  const scope = String(req.query.scope || '').slice(0, 100);
  if (!actor) return res.status(401).json({ error: 'A valid session is required.' });
  if (!canSubscribe(actor, scope)) return res.status(403).json({ error: 'You cannot subscribe to this stream.' });

  res.status(200);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ scope })}\n\n`);
  subscribe(scope, res);
  const ping = setInterval(() => {
    if (scope === 'presence') res.write(`event: presence\ndata: ${JSON.stringify(presencePayload())}\n\n`);
    else res.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }, scope === 'presence' ? 15000 : 20000);
  const cleanup = () => { clearInterval(ping); unsubscribe(scope, res); };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

export default router;

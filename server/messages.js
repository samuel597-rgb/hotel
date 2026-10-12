// server/messages.js — persistent customer/front-desk and staff chat.
import crypto from 'node:crypto';
import express from 'express';
import { db, withTransaction, tokenDigest } from './sqlite.js';
import { requireCustomer, requireStaff, requireRole } from './auth.js';
import { logAction } from './audit.js';
import { publish } from './events.js';

const router = express.Router();
const staffRoles = ['super_admin','admin','manager','front_desk','kitchen','employee','waiter','cashier','supervisor'];
const clean = (value, max=2000) => String(value ?? '').trim().slice(0,max);
function actorFromRequest(req) {
  const token=String(req.get('x-auth-token')||/^Bearer\s+(.+)$/i.exec(req.get('authorization')||'')?.[1]||'');
  if(!token)return null;
  const digest=tokenDigest(token);
  const customer=db.prepare(`SELECT id,name FROM customers WHERE id=(SELECT customer_id FROM customer_sessions WHERE token_hash=? AND expires_at>?) AND active=1`).get(digest,Date.now());
  if(customer)return {type:'customer',customer};
  const staff=db.prepare(`SELECT s.* FROM staff_sessions ss JOIN staff s ON s.id=ss.staff_id WHERE ss.token_hash=? AND ss.expires_at>? AND s.active=1`).get(digest,Date.now());
  return staff?{type:'staff',staff}:null;
}

router.get('/api/customer/messages', requireCustomer, (req,res) => {
  const messages = db.prepare(`SELECT id,sender_type AS senderType,sender_id AS senderId,sender_name AS senderName,body,created_at AS createdAt
    FROM customer_messages WHERE customer_id=? ORDER BY created_at,id LIMIT 500`).all(req.customer.id);
  withTransaction(() => db.prepare('UPDATE customer_messages SET read_by_customer=1 WHERE customer_id=? AND sender_type<>\'customer\'').run(req.customer.id));
  return res.json(messages);
});

router.post('/api/customer/messages', requireCustomer, (req,res) => {
  const body = clean(req.body?.body || req.body?.text);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const id = crypto.randomUUID();
  withTransaction(() => {
    db.prepare('INSERT INTO customer_messages(id,customer_id,sender_type,sender_id,sender_name,body) VALUES(?,?,?,?,?,?)')
      .run(id,req.customer.id,'customer',req.customer.id,req.customer.name,body);
    logAction(db,{actorId:req.customer.id,actorRole:'customer',action:'message_send',targetType:'customer_message',targetId:id});
  });
  const message={id,senderType:'customer',senderId:req.customer.id,senderName:req.customer.name,body,createdAt:new Date().toISOString()};
  publish(`customer:${req.customer.id}`,'message',{scope:`customer:${req.customer.id}`,message});
  publish('admin','message',{scope:'admin',message});publish('presence','inbox.update',{scope:'presence'});
  return res.status(201).json(message);
});

router.get('/api/staff/messages/:threadType/:threadId', requireStaff, requireRole(staffRoles), (req,res) => {
  const { threadType, threadId } = req.params;
  if (threadType === 'customer') {
    if (!['super_admin','admin','manager','front_desk'].includes(req.staff.role)) return res.status(403).json({error:'Front desk messaging access is required.'});
    const messages=db.prepare(`SELECT id,sender_type AS senderType,sender_id AS senderId,body,created_at AS createdAt
      FROM customer_messages WHERE customer_id=? ORDER BY created_at,id LIMIT 500`).all(threadId);
    return res.json(messages);
  }
  if (threadType === 'order') {
    if (!db.prepare('SELECT id FROM orders WHERE legacy_order_id=? OR CAST(id AS TEXT)=?').get(threadId,threadId)) return res.status(404).json({error:'Order thread not found.'});
    const messages=db.prepare(`SELECT id,sender_id AS senderId,sender_role AS senderRole,body,created_at AS createdAt
      FROM staff_messages WHERE thread_type='order' AND thread_id=? ORDER BY created_at,id LIMIT 500`).all(threadId);
    return res.json(messages);
  }
  if (threadType === 'broadcast' && req.staff.role !== 'super_admin' && req.staff.role !== 'admin') return res.status(403).json({error:'Admin messaging access is required.'});
  return res.json(db.prepare(`SELECT id,sender_id AS senderId,sender_role AS senderRole,body,created_at AS createdAt
    FROM staff_messages WHERE thread_type=? AND thread_id=? ORDER BY created_at,id LIMIT 500`).all(threadType,threadId));
});

router.post('/api/staff/messages', requireStaff, requireRole(staffRoles), (req,res) => {
  const body=clean(req.body?.body || req.body?.text);
  const threadType=clean(req.body?.threadType || 'team',40);
  const threadId=clean(req.body?.threadId || 'front-desk',128);
  if (!body) return res.status(400).json({error:'Message cannot be empty.'});
  if (threadType === 'customer') {
    if (!['super_admin','admin','manager','front_desk'].includes(req.staff.role)) return res.status(403).json({error:'Front desk messaging access is required.'});
    const customer=db.prepare('SELECT id FROM customers WHERE id=? AND active=1').get(threadId);
    if (!customer) return res.status(404).json({error:'Customer not found.'});
    const id=crypto.randomUUID();
    withTransaction(() => {
      db.prepare('INSERT INTO customer_messages(id,customer_id,sender_type,sender_id,sender_name,body) VALUES(?,?,?,?,?,?)')
        .run(id,threadId,req.staff.role==='admin'||req.staff.role==='super_admin'?'admin':'staff',String(req.staff.id),req.staff.name,body);
      db.prepare('UPDATE customer_messages SET read_by_staff=1 WHERE customer_id=?').run(threadId);
    });
    logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'message_send',targetType:'customer_message',targetId:id});
    const message={id,senderType:'staff',senderId:String(req.staff.id),senderName:req.staff.name,body,createdAt:new Date().toISOString()};
    publish(`customer:${threadId}`,'message',{scope:`customer:${threadId}`,message});
  publish('admin','message',{scope:'admin',message});publish('presence','inbox.update',{scope:'presence'});
    return res.status(201).json(message);
  }
  if (threadType === 'broadcast' && !['super_admin','admin'].includes(req.staff.role)) return res.status(403).json({error:'Only admins can broadcast messages.'});
  if (threadType === 'order' && !db.prepare('SELECT id FROM orders WHERE legacy_order_id=? OR CAST(id AS TEXT)=?').get(threadId,threadId)) return res.status(404).json({error:'Order thread not found.'});
  const id=crypto.randomUUID();
  withTransaction(() => {
    db.prepare(`INSERT INTO staff_messages(id,thread_type,thread_id,sender_id,sender_role,body)
      VALUES(?,?,?,?,?,?)`).run(id,threadType,threadId,String(req.staff.id),req.staff.role,body);
    logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'message_send',targetType:'staff_message',targetId:id});
  });
  const message={id,senderId:String(req.staff.id),senderRole:req.staff.role,senderName:req.staff.name,body,createdAt:new Date().toISOString()};
  if(threadType==='thread')publish(`thread:${threadId}`,'message',{scope:`thread:${threadId}`,message});
  if(threadType==='team')publish(`team:${threadId}`,'message',{scope:`team:${threadId}`,message});
  publish('admin','message',{scope:'admin',message});publish('presence','inbox.update',{scope:'presence'});
  return res.status(201).json(message);
});

// Phase B API paths. The earlier /api/customer/messages and /api/staff/messages
// routes remain available to keep existing clients working.
router.get('/api/messages/customer', (req,res,next) => {
  const actor=actorFromRequest(req);if(!actor)return res.status(401).json({error:'Sign in is required.'});
  if(actor.type==='customer')return res.json(db.prepare(`SELECT id,sender_type AS senderType,sender_id AS senderId,sender_name AS senderName,body,created_at AS createdAt
    FROM customer_messages WHERE customer_id=? ORDER BY id LIMIT 500`).all(actor.customer.id));
  const staff=actor.staff;
    if(!['super_admin','admin','manager','front_desk'].includes(staff.role))return res.status(403).json({error:'Front desk messaging access is required.'});
    const customerId=String(req.query.customer_id||'');
    if(customerId)return res.json(db.prepare(`SELECT id,sender_type AS senderType,sender_id AS senderId,sender_name AS senderName,body,created_at AS createdAt
      FROM customer_messages WHERE customer_id=? ORDER BY id LIMIT 500`).all(customerId));
    const rows=db.prepare(`SELECT c.id AS customerId,c.name AS customerName,MAX(m.id) AS lastId,
      (SELECT body FROM customer_messages x WHERE x.customer_id=c.id ORDER BY x.id DESC LIMIT 1) AS preview,
      SUM(CASE WHEN m.sender_type='customer' AND m.read_by_staff=0 THEN 1 ELSE 0 END) AS unread
      FROM customer_messages m JOIN customers c ON c.id=m.customer_id GROUP BY c.id ORDER BY lastId DESC`).all();
    return res.json(rows);
});

router.post('/api/messages/customer', (req,res,next) => {
  const actor=actorFromRequest(req);if(!actor)return res.status(401).json({error:'Sign in is required.'});
  if(actor.type==='customer'){
    const body=clean(req.body?.body);if(!body)return res.status(400).json({error:'Message cannot be empty.'});
    const id=crypto.randomUUID(),customer=actor.customer;
    withTransaction(()=>db.prepare('INSERT INTO customer_messages(id,customer_id,sender_type,sender_id,sender_name,body) VALUES(?,?,?,?,?,?)').run(id,customer.id,'customer',customer.id,customer.name,body));
    const message={id,senderType:'customer',senderId:customer.id,senderName:customer.name,body,createdAt:new Date().toISOString()};publish(`customer:${customer.id}`,'message',{scope:`customer:${customer.id}`,message});publish('admin','message',{scope:'admin',message});publish('presence','inbox.update',{scope:'presence'});
    return res.status(201).json(message);
  }
  const staff=actor.staff;
    if(!['super_admin','admin','manager','front_desk'].includes(staff.role))return res.status(403).json({error:'Front desk messaging access is required.'});
    const customerId=String(req.body?.customer_id||'');
    const body=clean(req.body?.body);
    if(!body)return res.status(400).json({error:'Message cannot be empty.'});
    if(!db.prepare('SELECT id FROM customers WHERE id=? AND active=1').get(customerId))return res.status(404).json({error:'Customer not found.'});
    const id=crypto.randomUUID();
    withTransaction(()=>db.prepare('INSERT INTO customer_messages(id,customer_id,sender_type,sender_id,sender_name,body) VALUES(?,?,?,?,?,?)')
      .run(id,customerId,staff.role==='admin'||staff.role==='super_admin'?'admin':'staff',String(staff.id),staff.name,body));
    const message={id,senderType:'staff',senderId:String(staff.id),senderName:staff.name,body,createdAt:new Date().toISOString()};
    publish(`customer:${customerId}`,'message',{scope:`customer:${customerId}`,message});
    publish('admin','message',{scope:'admin',message});publish('presence','inbox.update',{scope:'presence'});
    return res.status(201).json(message);
});

router.post('/api/messages/customer/read', (req,res,next) => {
  const actor=actorFromRequest(req);if(!actor)return res.status(401).json({error:'Sign in is required.'});
  if(actor.type==='customer'){withTransaction(()=>db.prepare("UPDATE customer_messages SET read_by_customer=1 WHERE customer_id=? AND sender_type<>'customer'").run(actor.customer.id));return res.json({success:true});}
  const customerId=String(req.body?.customer_id||'');if(!['super_admin','admin','manager','front_desk'].includes(actor.staff.role))return res.status(403).json({error:'Front desk messaging access is required.'});withTransaction(()=>db.prepare("UPDATE customer_messages SET read_by_staff=1 WHERE customer_id=? AND sender_type='customer'").run(customerId));return res.json({success:true});
});

router.post('/api/messages/customer/typing', (req,res,next) => {
  const token=String(req.get('x-auth-token')||/^Bearer\s+(.+)$/i.exec(req.get('authorization')||'')?.[1]||'');
  const customer=db.prepare(`SELECT c.* FROM customer_sessions s JOIN customers c ON c.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>?`).get(tokenDigest(token),Date.now());
  if(customer){const scope=`customer:${customer.id}`,actorId=`cust:${customer.id}`,expiresAt=new Date(Date.now()+3000).toISOString();withTransaction(()=>db.prepare('INSERT INTO typing_state(scope,actor_id,actor_name,expires_at) VALUES(?,?,?,?) ON CONFLICT(scope,actor_id) DO UPDATE SET actor_name=excluded.actor_name,expires_at=excluded.expires_at').run(scope,actorId,customer.name,expiresAt));publish(scope,'typing',{scope,actor:{id:actorId,name:customer.name},expires_at:expiresAt});return res.json({success:true});}
  const actor=actorFromRequest(req);if(!actor)return res.status(401).json({error:'Sign in is required.'});if(actor.type!=='staff')return res.status(401).json({error:'Staff sign-in required.'});const customerId=String(req.body?.customer_id||'');if(!['super_admin','admin','manager','front_desk'].includes(actor.staff.role))return res.status(403).json({error:'Front desk messaging access is required.'});const scope=`customer:${customerId}`,actorId=`staff:${actor.staff.id}`,expiresAt=new Date(Date.now()+3000).toISOString();withTransaction(()=>db.prepare('INSERT INTO typing_state(scope,actor_id,actor_name,expires_at) VALUES(?,?,?,?) ON CONFLICT(scope,actor_id) DO UPDATE SET actor_name=excluded.actor_name,expires_at=excluded.expires_at').run(scope,actorId,actor.staff.name,expiresAt));publish(scope,'typing',{scope,actor:{id:actorId,name:actor.staff.name},expires_at:expiresAt});return res.json({success:true});
});

router.get('/api/messages/threads',requireStaff,requireRole(staffRoles),(req,res)=>{
  const rows=db.prepare(`SELECT t.*, (SELECT body FROM staff_messages m WHERE m.thread_id=CAST(t.id AS TEXT) ORDER BY m.id DESC LIMIT 1) AS preview
    FROM staff_threads t WHERE (?='kitchen' AND thread_type='kitchen') OR (?<>'kitchen' AND thread_type<>'kitchen') ORDER BY t.id DESC`).all(req.staff.role,req.staff.role);
  return res.json(rows);
});

router.post('/api/messages/threads',requireStaff,requireRole(staffRoles),(req,res)=>{
  const type=clean(req.body?.thread_type,40),title=clean(req.body?.title,200),referenceId=Number(req.body?.reference_id)||null;
  if(!['kitchen','direct','admin_broadcast'].includes(type))return res.status(400).json({error:'Invalid thread type.'});
  if(type==='admin_broadcast'&&!['super_admin','admin','manager'].includes(req.staff.role))return res.status(403).json({error:'Admin access is required.'});
  const id=withTransaction(()=>{const threadId=Number(db.prepare('INSERT INTO staff_threads(thread_type,reference_id,title,created_by) VALUES(?,?,?,?)').run(type,referenceId,title,String(req.staff.id)).lastInsertRowid);logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'message.thread.create',targetType:'staff_thread',targetId:threadId,meta:{type}});return threadId;});
  return res.status(201).json(db.prepare('SELECT * FROM staff_threads WHERE id=?').get(id));
});

router.get('/api/messages/threads/:id',requireStaff,requireRole(staffRoles),(req,res)=>{
  const thread=db.prepare('SELECT * FROM staff_threads WHERE id=?').get(Number(req.params.id));
  if(!thread)return res.status(404).json({error:'Thread not found.'});
  if(req.staff.role==='kitchen'&&thread.thread_type!=='kitchen')return res.status(403).json({error:'Kitchen staff can only access kitchen threads.'});
  if(thread.thread_type==='kitchen'&&!['super_admin','admin','manager','kitchen','front_desk','waiter','cashier','supervisor'].includes(req.staff.role))return res.status(403).json({error:'Kitchen thread access is required.'});
  withTransaction(()=>db.prepare("UPDATE staff_messages SET read_at=CURRENT_TIMESTAMP WHERE thread_id=? AND sender_id<>?").run(String(thread.id),String(req.staff.id)));
  const messages=['super_admin','admin','manager'].includes(req.staff.role)
    ?db.prepare('SELECT * FROM staff_messages WHERE thread_id=? ORDER BY id LIMIT 500').all(String(thread.id))
    :db.prepare("SELECT * FROM staff_messages WHERE thread_id=? AND (recipient_role='' OR recipient_role=?) ORDER BY id LIMIT 500").all(String(thread.id),req.staff.role);
  return res.json({thread,messages});
});

router.post('/api/messages/threads/:id',(req,res,next)=>requireStaff(req,res,()=>requireRole(staffRoles)(req,res,()=>{
  const thread=db.prepare('SELECT * FROM staff_threads WHERE id=?').get(Number(req.params.id));if(!thread)return res.status(404).json({error:'Thread not found.'});
  const body=clean(req.body?.body);if(!body)return res.status(400).json({error:'Message cannot be empty.'});
  if(req.staff.role==='kitchen'&&thread.thread_type!=='kitchen')return res.status(403).json({error:'Kitchen staff can only post to kitchen threads.'});
  const id=crypto.randomUUID();withTransaction(()=>db.prepare('INSERT INTO staff_messages(id,thread_type,thread_id,sender_id,sender_role,body) VALUES(?,?,?,?,?,?)').run(id,thread.thread_type,String(thread.id),String(req.staff.id),req.staff.role,body));
  const message={id,senderId:String(req.staff.id),senderRole:req.staff.role,senderName:req.staff.name,body,createdAt:new Date().toISOString()};publish(`thread:${thread.id}`,'message',{scope:`thread:${thread.id}`,message});publish('admin','message',{scope:'admin',message});publish('presence','inbox.update',{scope:'presence'});
  return res.status(201).json(message);
})));

router.post('/api/messages/threads/:id/read',requireStaff,requireRole(staffRoles),(req,res)=>{withTransaction(()=>db.prepare('UPDATE staff_messages SET read_at=CURRENT_TIMESTAMP WHERE thread_id=? AND sender_id<>?').run(String(req.params.id),String(req.staff.id)));return res.json({success:true});});
router.post('/api/messages/threads/:id/typing',requireStaff,requireRole(staffRoles),(req,res)=>{const scope=`thread:${Number(req.params.id)}`,actorId=`staff:${req.staff.id}`,expiresAt=new Date(Date.now()+3000).toISOString();withTransaction(()=>db.prepare('INSERT INTO typing_state(scope,actor_id,actor_name,expires_at) VALUES(?,?,?,?) ON CONFLICT(scope,actor_id) DO UPDATE SET actor_name=excluded.actor_name,expires_at=excluded.expires_at').run(scope,actorId,req.staff.name,expiresAt));publish(scope,'typing',{scope,actor:{id:actorId,name:req.staff.name},expires_at:expiresAt});return res.json({success:true});});

router.post('/api/messages/broadcast',requireStaff,requireRole(['super_admin','admin','manager']),(req,res)=>{
  const body=clean(req.body?.body),roles=Array.isArray(req.body?.roles)?[...new Set(req.body.roles.filter(role=>staffRoles.includes(role)))]:[];
  if(!body||!roles.length)return res.status(400).json({error:'Message and at least one recipient role are required.'});
  const results=withTransaction(()=>{
    let thread=db.prepare("SELECT id FROM staff_threads WHERE thread_type='admin_broadcast' ORDER BY id LIMIT 1").get();
    if(!thread)thread={id:Number(db.prepare("INSERT INTO staff_threads(thread_type,title,created_by) VALUES('admin_broadcast','Admin broadcasts',?)").run(String(req.staff.id)).lastInsertRowid)};
    const insert=db.prepare('INSERT INTO staff_messages(id,thread_type,thread_id,sender_id,sender_role,recipient_role,body) VALUES(?,?,?,?,?,?,?)');
    const messages=roles.map(role=>{const id=crypto.randomUUID();insert.run(id,'admin_broadcast',String(thread.id),String(req.staff.id),req.staff.role,role,body);return {id,role};});
    logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'message.broadcast',targetType:'staff_thread',targetId:thread.id,meta:{roles}});
    return messages;
  });
  for(const item of results)publish(`role:${item.role}`,'message',{scope:`role:${item.role}`,message:{...item,body,senderName:req.staff.name}});
  publish('admin','message',{scope:'admin',message:{id,senderId:String(req.staff.id),senderRole:req.staff.role,senderName:req.staff.name,body,createdAt:new Date().toISOString()}});publish('presence','inbox.update',{scope:'presence'});
  return res.status(201).json({success:true,recipients:results.length});
});

export default router;

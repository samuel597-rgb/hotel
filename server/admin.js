// server/admin.js — role-gated management, audit, presence, and settings APIs.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { db, withTransaction } from './sqlite.js';
import { requireStaff, requireRole } from './auth.js';
import { logAction } from './audit.js';

const scrypt=promisify(crypto.scrypt);
const router=express.Router();
const admins=['super_admin','admin'];
const managers=['super_admin','admin','manager'];
const staffRoles=['front_desk','kitchen','manager','employee','admin'];
const clean=(value,max=500)=>String(value??'').trim().slice(0,max);
const normalizePhone=value=>clean(value,30).replace(/[^+\d]/g,'');

async function makeHash(password) {
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=await scrypt(String(password),salt,64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

router.get('/api/admin/customers',requireStaff,requireRole(managers),(_req,res)=>{
  const rows=db.prepare(`SELECT id,name,phone,email,address,active,last_seen AS lastSeen,created_at AS createdAt
    FROM customers ORDER BY created_at DESC LIMIT 1000`).all();
  return res.json(rows);
});

router.get('/api/admin/staff',requireStaff,requireRole(managers),(_req,res)=>{
  return res.json(db.prepare(`SELECT id,name,phone,role,active,force_password_change AS forcePasswordChange,
    last_seen AS lastSeen,last_page AS currentPage,created_at AS createdAt FROM staff ORDER BY role,name COLLATE NOCASE`).all());
});

router.get('/api/admin/debug/staff',requireStaff,requireRole(admins),(_req,res)=>{
  return res.json(db.prepare(`SELECT id,name,phone,role,active,
    CASE WHEN pin_hash='' THEN '' ELSE substr(pin_hash,1,6) END AS hashPrefix,
    CASE WHEN pin_hash LIKE 'scrypt$%' THEN 'scrypt' WHEN pin_hash='' THEN 'missing' ELSE 'legacy' END AS hashScheme
    FROM staff ORDER BY id`).all());
});

router.delete('/api/admin/staff/:id/delete',requireStaff,requireRole('super_admin'),(req,res)=>{
  const member=db.prepare('SELECT id,name,role,active FROM staff WHERE id=?').get(Number(req.params.id));
  if(!member)return res.status(404).json({error:'Staff member not found.'});
  if(member.id===req.staff.id)return res.status(409).json({error:'You cannot delete your current account.'});
  if(member.role==='super_admin')return res.status(409).json({error:'Super admin accounts cannot be deleted here.'});
  withTransaction(()=>{
    db.prepare('UPDATE staff SET active=0 WHERE id=?').run(member.id);
    db.prepare('DELETE FROM staff_sessions WHERE staff_id=?').run(member.id);
    if(member.active)logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'staff.deactivate',targetType:'staff',targetId:member.id,meta:{via:'delete_button'}});
  });
  return res.status(204).end();
});

router.post('/api/admin/staff',requireStaff,requireRole(managers),async(req,res,next)=>{
  try {
    const name=clean(req.body?.name,120).replace(/\s+/g,' ');
    const phone=normalizePhone(req.body?.phone);
    const role=clean(req.body?.role,40);
    const password=String(req.body?.password ?? req.body?.pin ?? '');
    if(name.length<2||phone.replace(/\D/g,'').length<7||!staffRoles.includes(role)||password.length<4||password.length>128)
      return res.status(400).json({error:'Enter name, valid phone, role, and a password or PIN of at least 4 characters.'});
    if(role==='admin'&&req.staff.role!=='super_admin')return res.status(403).json({error:'Only a super admin can create another admin.'});
    const hash=await makeHash(password);
    let id;
    try {
      id=withTransaction(()=>{
        const result=db.prepare('INSERT INTO staff(name,phone,role,pin_hash,active,force_password_change) VALUES(?,?,?,?,1,1)')
          .run(name,phone,role,hash);
        logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'staff.create',targetType:'staff',targetId:result.lastInsertRowid,meta:{role}});
        return Number(result.lastInsertRowid);
      });
    } catch(error) {
      if(String(error.code).startsWith('SQLITE_CONSTRAINT')||/UNIQUE constraint failed: staff\.phone/i.test(String(error.message)))return res.status(409).json({error:'A staff member already uses that phone number.'});
      throw error;
    }
    return res.status(201).json(db.prepare(`SELECT id,name,phone,role,active,force_password_change AS forcePasswordChange FROM staff WHERE id=?`).get(id));
  } catch(error){
    console.error('[staff-create] database error',error?.stack||error?.message||error);
    return res.status(500).json({error:'staff_create_failed',detail:String(error?.message||error)});
  }
});

router.patch('/api/admin/staff/:id',requireStaff,requireRole(managers),async(req,res,next)=>{
  try {
    const member=db.prepare('SELECT * FROM staff WHERE id=?').get(Number(req.params.id));
    if(!member)return res.status(404).json({error:'Staff member not found.'});
    if(member.role==='super_admin'&&req.staff.role!=='super_admin')return res.status(403).json({error:'Only a super admin can change a super admin.'});
    const name=clean(req.body?.name ?? member.name,120).replace(/\s+/g,' ');
    const phone=normalizePhone(req.body?.phone ?? member.phone);
    const role=clean(req.body?.role ?? member.role,40);
    const active=req.body?.active===undefined?member.active:(req.body.active?1:0);
    if(name.length<2||phone.replace(/\D/g,'').length<7||!staffRoles.includes(role))return res.status(400).json({error:'Enter valid staff details.'});
    if(role==='admin'&&req.staff.role!=='super_admin')return res.status(403).json({error:'Only a super admin can assign the admin role.'});
    const password=String(req.body?.password ?? req.body?.pin ?? '');
    const hash=password ? (password.length<4||password.length>128 ? null : await makeHash(password)) : null;
    if(password&&!hash)return res.status(400).json({error:'Password or PIN must be at least 4 characters.'});
    withTransaction(()=>{
      db.prepare(`UPDATE staff SET name=?,phone=?,role=?,active=?,
        force_password_change=CASE WHEN ? IS NULL THEN force_password_change ELSE 1 END,
        pin_hash=COALESCE(?,pin_hash) WHERE id=?`).run(name,phone,role,active,hash,hash,member.id);
      if(!active)db.prepare('DELETE FROM staff_sessions WHERE staff_id=?').run(member.id);
      logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'staff.update',targetType:'staff',targetId:member.id,meta:{role,active:Boolean(active)}});
      if(role!==member.role)logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'staff.role_change',targetType:'staff',targetId:member.id,meta:{from:member.role,to:role}});
      if(Boolean(active)!==Boolean(member.active))logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:active?'staff.activate':'staff.deactivate',targetType:'staff',targetId:member.id});
    });
    return res.json(db.prepare(`SELECT id,name,phone,role,active,force_password_change AS forcePasswordChange FROM staff WHERE id=?`).get(member.id));
  } catch(error){if(String(error.code).startsWith('SQLITE_CONSTRAINT')||/UNIQUE constraint failed: staff\.phone/i.test(String(error.message)))return res.status(409).json({error:'A staff member already uses that phone number.'});return next(error);}
});

router.delete('/api/admin/staff/:id',requireStaff,requireRole(admins), (req,res)=>{
  const member=db.prepare('SELECT * FROM staff WHERE id=?').get(Number(req.params.id));
  if(!member)return res.status(404).json({error:'Staff member not found.'});
  if(member.role==='super_admin')return res.status(409).json({error:'Super admin accounts cannot be deactivated here.'});
  if(member.id===req.staff.id)return res.status(409).json({error:'You cannot deactivate your current account.'});
  withTransaction(()=>{
    db.prepare('UPDATE staff SET active=0 WHERE id=?').run(member.id);
    db.prepare('DELETE FROM staff_sessions WHERE staff_id=?').run(member.id);
    if(member.active)logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'staff.deactivate',targetType:'staff',targetId:member.id});
  });
  return res.status(204).end();
});

router.get('/api/admin/online',requireStaff,requireRole(managers),(_req,res)=>{
  const cutoff=Date.now()-120000;
  const customers=db.prepare(`SELECT id,name,'customer' AS role,last_seen AS lastSeen,last_page AS currentPage
    FROM customers WHERE active=1 AND last_seen>=? ORDER BY last_seen DESC`).all(cutoff);
  const staff=db.prepare(`SELECT id,name,role,last_seen AS lastSeen,last_page AS currentPage
    FROM staff WHERE active=1 AND last_seen>=? ORDER BY last_seen DESC`).all(cutoff);
  return res.json({customers,staff,count:customers.length+staff.length,asOf:Date.now()});
});

router.get('/api/admin/audit',requireStaff,requireRole(managers),(req,res)=>{
  const filters=[];const args=[];
  const role=clean(req.query.role,40);
  if(role==='customer'){filters.push("actor_role='customer'");}
  else if(role==='employee'){filters.push("actor_role NOT IN ('customer','admin','super_admin')");}
  else if(role==='admin'){filters.push("actor_role IN ('admin','super_admin')");}
  else if(role){filters.push('actor_role=?');args.push(role);}
  const from=clean(req.query.from,20),to=clean(req.query.to,20),action=clean(req.query.action,80);
  if(/^\d{4}-\d{2}-\d{2}$/.test(from)){filters.push("date(created_at)>=date(?)");args.push(from);}
  if(/^\d{4}-\d{2}-\d{2}$/.test(to)){filters.push("date(created_at)<=date(?)");args.push(to);}
  if(action){filters.push('action=?');args.push(action);}
  const page=Math.max(1,Math.min(10000,Number(req.query.page)||1));
  const where=filters.length?`WHERE ${filters.join(' AND ')}`:'';
  const rows=db.prepare(`SELECT a.actor_id AS actorId,a.actor_role AS actorRole,COALESCE(c.name,s.name,'System') AS actorName,a.action,a.target_type AS targetType,
    a.target_id AS targetId,a.meta_json AS metaJson,a.created_at AS createdAt FROM audit_logs a
    LEFT JOIN customers c ON a.actor_role='customer' AND c.id=a.actor_id
    LEFT JOIN staff s ON a.actor_role<>'customer' AND CAST(s.id AS TEXT)=a.actor_id ${where}
    ORDER BY a.id DESC LIMIT 50 OFFSET ?`).all(...args,(page-1)*50);
  const total=db.prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`).get(...args).count;
  return res.json({rows,total,page,pageSize:50});
});

router.get('/api/admin/settings',requireStaff,requireRole(managers),(_req,res)=>{
  const values=Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(row=>[row.key,row.value]));
  let general={};try{general=JSON.parse(values.general||'{}');}catch{}
  return res.json({hotelName:general.hotelName||values.brand_name||'HOTELI POA',taxMode:general.taxMode||values.tax_mode||'included',
    taxRate:Number(general.taxRate??values.tax_rate??16),currency:'KES',themeDefault:general.themeDefault||'light',
    deliveryFeeCents:Number(general.deliveryFeeCents||general.delivery_fee_cents||0),serviceArea:general.serviceAreaText||general.serviceArea||'',
    loyaltyThreshold:Number(general.loyaltyThreshold||10),receiptFooterText:general.receiptFooterText||'Thank you for dining with us.',...general,
    comingSoon:['Real payments','GPS tracking','SMS / WhatsApp','Rider accounts','Merchant onboarding','Settlements']});
});

router.put('/api/admin/settings',requireStaff,requireRole(managers),(req,res)=>{
  const prior=(()=>{try{return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='general'").get()?.value||'{}');}catch{return {};}})();
  const incoming=req.body&&typeof req.body==='object'?req.body:{};
  const value={...prior,...incoming,hotelName:clean(incoming.hotelName||prior.hotelName||'HOTELI POA',120),currency:'KES',
    taxMode:incoming.taxMode==='excluded'?'excluded':'included',taxRate:Math.max(0,Math.min(100,Number(incoming.taxRate??prior.taxRate??16)||0)),
    deliveryFeeCents:Math.max(0,Math.min(10000000,Math.round(Number(incoming.deliveryFeeCents??incoming.delivery_fee_cents??prior.deliveryFeeCents??0)||0))),
    loyaltyThreshold:Math.max(1,Math.min(100,Math.round(Number(incoming.loyaltyThreshold??prior.loyaltyThreshold??10)||10))),
    serviceAreaText:clean(incoming.serviceAreaText??incoming.serviceArea??prior.serviceAreaText??prior.serviceArea??'Nairobi and environs (demo)',1000),
    receiptFooterText:clean(incoming.receiptFooterText??prior.receiptFooterText??'Thank you for dining with us.',300)};
  delete value.comingSoon;
  withTransaction(()=>{
    db.prepare(`INSERT INTO settings(key,value) VALUES('general',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(value));
    db.prepare(`INSERT INTO settings(key,value) VALUES('tax_rate',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(value.taxRate));
    db.prepare(`INSERT INTO settings(key,value) VALUES('tax_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(value.taxMode));
    logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'settings.update',targetType:'settings',targetId:'general'});
  });
  return res.json({success:true,settings:value});
});

export default router;

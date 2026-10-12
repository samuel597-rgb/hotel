// server/orders.js — server-priced ordering, delivery tracking, and staff queue.
import crypto from 'node:crypto';
import express from 'express';
import { db, withTransaction } from './sqlite.js';
import { requireCustomer, requireStaff, requireRole } from './auth.js';
import { fromCents, roundHalfUp, toCents, computeTotals } from './money.js';
import { logAction } from './audit.js';
import { publish } from './events.js';

const router = express.Router();
const activeRoles = ['super_admin', 'admin', 'manager', 'front_desk', 'kitchen', 'employee', 'waiter', 'cashier', 'supervisor'];
const transitions = {
  placed: ['confirmed','cancelled'], new: ['confirmed','cancelled'], confirmed: ['preparing','cancelled'], preparing: ['ready','cancelled'],
  ready: ['out_for_delivery','delivered','cancelled'], out_for_delivery: ['delivered','cancelled'],
  delivered: ['paid'], paid: [], cancelled: [], split: [], merged: []
};
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const orderKey = id => db.prepare('SELECT * FROM orders WHERE legacy_order_id=? OR CAST(id AS TEXT)=?').get(String(id), String(id));

function currentSettings() {
  const settings=Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(row=>[row.key,row.value]));
  let general={};try{general=JSON.parse(settings.general||'{}');}catch{}
  const taxMode=String(general.taxMode||settings.tax_mode||'included')==='excluded'?'excluded':'included';
  const taxRate=Math.max(0,Math.min(100,Number(general.taxRate??settings.tax_rate??0)));
  return {general,taxMode,taxRate};
}

export function calculateQuote(items,channel,tipPercent=0,tipCentsOverride=null) {
  if(!Array.isArray(items)||!items.length||items.length>100)throw new Error('An order needs between 1 and 100 items.');
  const {general,taxMode,taxRate}=currentSettings();
  let subtotalCents=0;
  const lines=items.map(input=>{
    const productId=text(input?.productId||input?.id,128),qty=Number(input?.qty??input?.quantity);
    if(!productId||!Number.isInteger(qty)||qty<1||qty>99)throw new Error('Each order item needs a product and a quantity from 1 to 99.');
    const product=db.prepare(`SELECT id,name,price_cents,price,discount_percent FROM products
      WHERE (CAST(id AS TEXT)=? OR firestore_id=?) AND active=1 AND is_available=1`).get(productId,productId);
    if(!product)throw new Error(`A selected item is unavailable: ${productId}`);
    const baseCents=Number(product.price_cents)||toCents(product.price||0);
    const discountBps=Math.max(0,Math.min(10000,Math.round(Number(product.discount_percent||0)*100)));
    const priceCents=roundHalfUp(BigInt(baseCents)*BigInt(10000-discountBps),10000n);
    subtotalCents+=priceCents*qty;
    return {productId:product.id,name:product.name,priceCents,qty,notes:text(input?.notes,300)};
  });
  if(!Number.isSafeInteger(subtotalCents))throw new Error('Order amount is too large.');
  const rateBps=Math.round(taxRate*100);
  const taxCents=taxMode==='included'
    ?roundHalfUp(BigInt(subtotalCents)*BigInt(rateBps),BigInt(10000+rateBps))
    :roundHalfUp(BigInt(subtotalCents)*BigInt(rateBps),10000n);
  const tipBps=Math.round(Math.max(0,Math.min(100,Number(tipPercent)||0))*100);
  const tipCents=tipCentsOverride==null?roundHalfUp(BigInt(subtotalCents)*BigInt(tipBps),10000n):Number(tipCentsOverride);
  if(!Number.isSafeInteger(tipCents)||tipCents<0||tipCents>100000)throw new Error('Tip must be from 0 to 100000 cents.');
  const deliveryFeeCents=channel==='delivery'?Math.max(0,Number(general.deliveryFeeCents||0)):0;
  const totalCents=computeTotals({subtotalCents,taxRate,taxMode,tipCents,deliveryFeeCents}).totalCents;
  return {lines,subtotalCents,taxCents,tipCents,totalCents,taxMode,taxRate,deliveryFeeCents};
}

function orderDetails(row) {
  const items = db.prepare(`SELECT product_id AS productId,name_snapshot AS name,price_cents_snapshot AS priceCents,
    qty,notes FROM order_items WHERE order_id=? ORDER BY id`).all(row.id).map(item => ({
      ...item, price: Number(fromCents(item.priceCents)), subtotalCents: item.priceCents * item.qty
    }));
  const history = db.prepare('SELECT status,actor_id AS actorId,note,created_at AS createdAt FROM order_status_history WHERE order_id=? ORDER BY id').all(row.id);
  const delivery = db.prepare('SELECT address_text AS address,landmark,notes,rider_name AS riderName,rider_phone AS riderPhone,eta_text AS eta FROM delivery_details WHERE order_id=?').get(row.id) || null;
  const table = row.table_id ? db.prepare('SELECT floor,number FROM tables WHERE id=?').get(row.table_id) : null;
  return {
    id: row.legacy_order_id || String(row.id), customerId: row.customer_id, customer: row.customer_name,
    tableId: row.table_id, table: table ? `${table.floor} ${table.number}` : row.table_name || '',
    channel: row.channel, status: row.status, subtotalCents: row.subtotal_cents, taxCents: row.tax_cents,
    tipCents: row.tip_cents, deliveryFeeCents:Number(row.delivery_fee_cents||0),totalCents: row.total_cents, subtotal: Number(fromCents(row.subtotal_cents)),
    tax: Number(fromCents(row.tax_cents)), tip: Number(fromCents(row.tip_cents)), total: Number(fromCents(row.total_cents)),
    notes: row.notes || '', items, delivery, history, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function applyLoyalty(customerId, phone, orderId) {
  const normalized=text(phone,30).replace(/[^+\d]/g,'');if(normalized.replace(/\D/g,'').length<7)return;
  const settings=currentSettings().general,threshold=Math.max(1,Math.min(100,Number(settings.loyaltyThreshold)||10));
  db.prepare(`INSERT INTO loyalty_accounts(phone,stamps,rewards_earned) VALUES(?,1,0)
    ON CONFLICT(phone) DO UPDATE SET stamps=stamps+1,updated_at=CURRENT_TIMESTAMP`).run(normalized);
  db.prepare('INSERT INTO loyalty_events(customer_id,phone,order_id,event,delta) VALUES(?,?,?,\'stamp\',1)').run(customerId||null,normalized,orderId);
  const account=db.prepare('SELECT stamps,rewards_earned FROM loyalty_accounts WHERE phone=?').get(normalized);
  if(account.stamps>=threshold){
    db.prepare('UPDATE loyalty_accounts SET stamps=stamps-?,rewards_earned=rewards_earned+1,updated_at=CURRENT_TIMESTAMP WHERE phone=?').run(threshold,normalized);
    db.prepare('INSERT INTO loyalty_events(customer_id,phone,order_id,event,delta) VALUES(?,?,?,\'earned\',1)').run(customerId||null,normalized,orderId);
  }
}

router.post('/api/quote',(req,res)=>{
  const channel=['dine_in','takeout','delivery'].includes(req.body?.channel)?req.body.channel:'takeout';
  try {
    const quote=calculateQuote(req.body?.items,channel,req.body?.tipPercent,req.body?.tip_cents??req.body?.tipCents??null);
    return res.json({...quote,subtotal:Number(fromCents(quote.subtotalCents)),tax:Number(fromCents(quote.taxCents)),tip:Number(fromCents(quote.tipCents)),total:Number(fromCents(quote.totalCents)),lines:quote.lines.map(line=>({...line,price:Number(fromCents(line.priceCents))}))});
  }catch(error){return res.status(400).json({error:error.message});}
});

router.post('/api/customer/orders', requireCustomer, (req, res) => {
  const body = req.body || {};
  if (['subtotal', 'subtotalCents', 'tax', 'taxCents', 'tip', 'tipCents', 'total', 'totalCents'].some(key => key in body)) {
    return res.status(400).json({ error: 'Send product IDs and quantities only. Prices and totals are calculated by the server.' });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 100) return res.status(400).json({ error: 'An order needs between 1 and 100 items.' });
  const channel = ['dine_in', 'takeout', 'delivery'].includes(body.channel) ? body.channel : '';
  if (!channel) return res.status(400).json({ error: 'Choose dine-in, takeout, or delivery.' });
  let quote;
  if(body.tip_cents!==undefined&&(!Number.isInteger(body.tip_cents)||body.tip_cents<0||body.tip_cents>100000))return res.status(400).json({error:'Tip must be from 0 to 100000 cents.'});
  try { quote=calculateQuote(items,channel,body.tipPercent,body.tip_cents??body.tipCents??null); }
  catch(error){return res.status(400).json({error:error.message});}
  const {lines,subtotalCents,taxCents,tipCents,totalCents,taxMode,taxRate,deliveryFeeCents}=quote;
  const tableId = channel === 'dine_in' ? Number(body.tableId) || null : null;
  if (channel==='dine_in'&&!tableId) return res.status(400).json({error:'Choose an available table for dine-in.'});
  if (tableId && !db.prepare("SELECT id FROM tables WHERE id=? AND status='available'").get(tableId)) return res.status(409).json({ error: 'That table is not available.' });
  const address = text(body.address, 1000);
  const landmark = text(body.landmark, 300);
  if (channel === 'delivery' && address.length < 4) return res.status(400).json({ error: 'Enter the delivery address.' });
  const notes = text(body.notes, 1000);
  const id = crypto.randomUUID();
  const order = withTransaction(() => {
    const inserted = db.prepare(`INSERT INTO orders(legacy_order_id,customer_id,table_id,channel,status,
      subtotal,subtotal_cents,tax,tax_cents,tip,tip_cents,total,total_cents,total_amount,delivery_fee_cents,customer_name,
      table_name,notes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .run(id, req.customer.id, tableId, channel, 'placed', Number(fromCents(subtotalCents)), subtotalCents,
        Number(fromCents(taxCents)), taxCents, Number(fromCents(tipCents)), tipCents,
        Number(fromCents(totalCents)), totalCents, Number(fromCents(totalCents)), deliveryFeeCents,req.customer.name,
        tableId ? `Table ${tableId}` : '', notes);
    const orderId = Number(inserted.lastInsertRowid);
    const addItem = db.prepare(`INSERT INTO order_items(order_id,product_id,qty,unit_price,notes,quantity,price,name_snapshot,price_cents_snapshot)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const line of lines) {
      const price = Number(fromCents(line.priceCents));
      addItem.run(orderId, line.productId, line.qty, price, line.notes, line.qty, price, line.name, line.priceCents);
    }
    db.prepare('INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,?,?,?)').run(orderId, 'placed', req.customer.id, 'Order submitted');
    if (channel === 'delivery') db.prepare(`INSERT INTO delivery_details(order_id,address_text,landmark,notes) VALUES(?,?,?,?)`)
      .run(orderId, address, landmark, text(body.riderNotes, 500));
    if (tableId) db.prepare("UPDATE tables SET status='occupied' WHERE id=?").run(tableId);
    logAction(db, { actorId: req.customer.id, actorRole: 'customer', action: 'order_create', targetType: 'order', targetId: id, meta: { channel, itemCount: lines.length, totalCents } });
    return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  });
  publish('presence','order.new',{order:orderDetails(order)});publish('kitchen','order.new',{order:orderDetails(order)});publish('admin','order.new',{order:orderDetails(order)});
  return res.status(201).json({ success: true, order: orderDetails(order) });
});

router.get('/api/customer/orders', requireCustomer, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC,id DESC').all(req.customer.id);
  return res.json(rows.map(orderDetails));
});

router.get('/api/customer/orders/:id', requireCustomer, (req, res) => {
  const row = orderKey(req.params.id);
  if (!row || row.customer_id !== req.customer.id) return res.status(404).json({ error: 'Order not found.' });
  return res.json(orderDetails(row));
});

router.get('/api/staff/orders', requireStaff, requireRole(activeRoles), (_req, res) => {
  const rows = db.prepare(`SELECT * FROM orders WHERE status NOT IN ('paid','cancelled','split','merged') ORDER BY created_at`).all();
  return res.json(rows.map(orderDetails));
});

router.patch('/api/staff/orders/:id/status', requireStaff, requireRole(['super_admin','admin','manager','front_desk','kitchen','waiter','cashier','supervisor']), (req, res) => {
  const row = orderKey(req.params.id);
  const status = text(req.body?.status, 40);
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  if (!Object.hasOwn(transitions,status)) return res.status(400).json({ error: 'Invalid order status.' });
  if (!transitions[row.status]?.includes(status)) return res.status(400).json({ error: `Order cannot move from ${row.status} to ${status}.` });
  const allowed = {
    kitchen: ['preparing', 'ready'],
    front_desk: ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'paid', 'cancelled'],
    employee: [], waiter: ['confirmed','preparing','ready','served','cancelled'], cashier: ['paid','cancelled'],
    manager: Object.values(transitions).flat(), admin: Object.values(transitions).flat(), super_admin: Object.values(transitions).flat(), supervisor: Object.values(transitions).flat()
  }[req.staff.role] || [];
  if (!allowed.includes(status)) return res.status(403).json({ error: 'Your role cannot set this order status.' });
  withTransaction(() => {
    db.prepare('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, row.id);
    db.prepare('INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,?,?,?)').run(row.id, status, String(req.staff.id), text(req.body?.note, 300));
    if (status === 'out_for_delivery' || status === 'delivered') {
      db.prepare(`UPDATE delivery_details SET rider_name=COALESCE(NULLIF(?,''),rider_name),
        rider_phone=COALESCE(NULLIF(?,''),rider_phone),eta_text=COALESCE(NULLIF(?,''),eta_text) WHERE order_id=?`)
        .run(text(req.body?.riderName, 100), text(req.body?.riderPhone, 40), text(req.body?.eta, 120), row.id);
    }
    if (status === 'paid' && row.table_id) db.prepare("UPDATE tables SET status='available' WHERE id=?").run(row.table_id);
    if(status==='preparing'){
      const exists=db.prepare("SELECT id FROM staff_threads WHERE thread_type='kitchen' AND reference_id=?").get(row.id);
      if(!exists)db.prepare("INSERT INTO staff_threads(thread_type,reference_id,title,created_by) VALUES('kitchen',?,?,?)")
        .run(row.id,`Order #${row.legacy_order_id}${row.table_name?` · ${row.table_name}`:''}`,req.staff.id);
    }
    logAction(db, { actorId: String(req.staff.id), actorRole: req.staff.role, action: 'order.status.change', targetType: 'order', targetId: row.legacy_order_id, meta: { from: row.status, to: status } });
    if(status==='cancelled')logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'order.cancel',targetType:'order',targetId:row.legacy_order_id});
    if(status==='paid')logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'order.paid',targetType:'order',targetId:row.legacy_order_id});
    if(status==='paid'&&row.customer_id){const customer=db.prepare('SELECT phone FROM customers WHERE id=?').get(row.customer_id);if(customer)applyLoyalty(row.customer_id,customer.phone,row.id);}
  });
  const updated=orderDetails(db.prepare('SELECT * FROM orders WHERE id=?').get(row.id));
  if(updated.customerId)publish(`customer:${updated.customerId}`,'order.status',{scope:`customer:${updated.customerId}`,order:updated});
  publish('presence','order.status',{order:updated});publish('kitchen','order.status',{order:updated});publish('admin','order.status',{order:updated});
  return res.json(updated);
});

router.patch('/api/staff/orders/:id/rider',requireStaff,requireRole(['super_admin','admin','manager','front_desk','cashier','supervisor']),(req,res)=>{
  const row=orderKey(req.params.id);if(!row)return res.status(404).json({error:'Order not found.'});
  if(row.channel!=='delivery')return res.status(400).json({error:'Rider details are only available for delivery orders.'});
  const riderName=text(req.body?.rider_name||req.body?.riderName,100),riderPhone=text(req.body?.rider_phone||req.body?.riderPhone,40);
  withTransaction(()=>{
    db.prepare(`INSERT INTO delivery_details(order_id,address_text,landmark,notes,rider_name,rider_phone)
      VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET rider_name=excluded.rider_name,rider_phone=excluded.rider_phone`)
      .run(row.id,'','', '',riderName,riderPhone);
    db.prepare('UPDATE orders SET rider_name=?,rider_phone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(riderName,riderPhone,row.id);
    logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'order.rider.assign',targetType:'order',targetId:row.legacy_order_id});
  });
  return res.json(orderDetails(db.prepare('SELECT * FROM orders WHERE id=?').get(row.id)));
});

router.post('/api/customer/orders/:id/cancel',requireCustomer,(req,res)=>{
  const row=orderKey(req.params.id);if(!row||row.customer_id!==req.customer.id)return res.status(404).json({error:'Order not found.'});
  if(!['placed','confirmed'].includes(row.status))return res.status(409).json({error:'This order can no longer be cancelled.'});
  withTransaction(()=>{
    db.prepare("UPDATE orders SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    db.prepare("INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,'cancelled',?,'Cancelled by customer')").run(row.id,req.customer.id);
    if(row.table_id)db.prepare("UPDATE tables SET status='available' WHERE id=?").run(row.table_id);
    logAction(db,{actorId:req.customer.id,actorRole:'customer',action:'order.cancel',targetType:'order',targetId:row.legacy_order_id});
  });
  const order=orderDetails(db.prepare('SELECT * FROM orders WHERE id=?').get(row.id));publish(`customer:${req.customer.id}`,'order.status',{scope:`customer:${req.customer.id}`,order});publish('presence','order.status',{order});
  return res.json(order);
});

router.post('/api/staff/orders/:id/split',requireStaff,requireRole(['super_admin','admin','manager','front_desk','cashier','supervisor']),(req,res)=>{
  const parent=orderKey(req.params.id);if(!parent)return res.status(404).json({error:'Order not found.'});
  const parts=req.body?.parts;
  if(!Array.isArray(parts)||parts.length<2||parts.some(part=>!Array.isArray(part)||!part.length))return res.status(400).json({error:'Split into at least two non-empty parts.'});
  const allItems=db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(parent.id),byId=new Map(allItems.map(item=>[String(item.id),item]));
  const selected=parts.flat().map(String);
  if(selected.length!==allItems.length||new Set(selected).size!==selected.length||selected.some(id=>!byId.has(id)))return res.status(400).json({error:'Every order item must appear exactly once in the split.'});
  if(['paid','cancelled','split','merged'].includes(parent.status))return res.status(409).json({error:'This order cannot be split.'});
  const settings=currentSettings();
  const childIds=[];
  withTransaction(()=>{
    parts.forEach((part,index)=>{
      const items=part.map(itemId=>byId.get(String(itemId)));
      const subtotalCents=items.reduce((sum,item)=>sum+Number(item.price_cents_snapshot)*Number(item.qty),0);
      const taxCents=settings.taxMode==='included'?roundHalfUp(BigInt(subtotalCents)*BigInt(Math.round(settings.taxRate*100)),BigInt(10000+Math.round(settings.taxRate*100))):roundHalfUp(BigInt(subtotalCents)*BigInt(Math.round(settings.taxRate*100)),10000n);
      const fee=parent.channel==='delivery'?Math.round(Number(settings.general.deliveryFeeCents||0)/(index===0?1:parts.length)):0;
      const totalCents=subtotalCents+(settings.taxMode==='excluded'?taxCents:0)+fee;
      let orderId=parent.id,publicId=parent.legacy_order_id;
      if(index>0){publicId=crypto.randomUUID();const result=db.prepare(`INSERT INTO orders(legacy_order_id,customer_id,table_id,channel,status,subtotal,subtotal_cents,tax,tax_cents,total,total_cents,total_amount,customer_name,table_name,notes,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).run(publicId,parent.customer_id,parent.table_id,parent.channel,'placed',Number(fromCents(subtotalCents)),subtotalCents,Number(fromCents(taxCents)),taxCents,Number(fromCents(totalCents)),totalCents,Number(fromCents(totalCents)),parent.customer_name,parent.table_name,parent.notes);orderId=Number(result.lastInsertRowid);childIds.push(publicId);}
      else db.prepare("UPDATE orders SET status='split',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(orderId);
      db.prepare('UPDATE order_items SET order_id=? WHERE id IN ('+items.map(()=>'?').join(',')+')').run(orderId,...items.map(item=>item.id));
      db.prepare('UPDATE orders SET subtotal=?,subtotal_cents=?,tax=?,tax_cents=?,tip=0,tip_cents=0,total=?,total_cents=?,total_amount=? WHERE id=?')
        .run(Number(fromCents(subtotalCents)),subtotalCents,Number(fromCents(taxCents)),taxCents,Number(fromCents(totalCents)),totalCents,Number(fromCents(totalCents)),orderId);
      db.prepare('INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,?,?,?)').run(orderId,index===0?'split':'placed',String(req.staff.id),`Split from ${parent.legacy_order_id}`);
    });
    logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'order.split',targetType:'order',targetId:parent.legacy_order_id,meta:{children:childIds}});
  });
  return res.status(201).json({parent_id:parent.legacy_order_id,children:childIds});
});

router.post('/api/staff/orders/merge',requireStaff,requireRole(['super_admin','admin','manager','front_desk','cashier','supervisor']),(req,res)=>{
  const ids=Array.isArray(req.body?.order_ids)?[...new Set(req.body.order_ids.map(String))]:[];if(ids.length<2)return res.status(400).json({error:'Choose at least two orders.'});
  const orders=ids.map(orderKey);if(orders.some(order=>!order))return res.status(404).json({error:'One or more orders were not found.'});
  const first=orders[0];if(orders.some(order=>order.table_id!==first.table_id||order.customer_id!==first.customer_id||!['placed','confirmed','preparing'].includes(order.status)))return res.status(400).json({error:'Orders must share a table and customer and be open.'});
  const publicId=crypto.randomUUID();let targetId;
  withTransaction(()=>{
    const totalCents=orders.reduce((sum,order)=>sum+Number(order.total_cents),0),subtotalCents=orders.reduce((sum,order)=>sum+Number(order.subtotal_cents),0),taxCents=orders.reduce((sum,order)=>sum+Number(order.tax_cents),0),tipCents=orders.reduce((sum,order)=>sum+Number(order.tip_cents),0);
    const inserted=db.prepare(`INSERT INTO orders(legacy_order_id,customer_id,table_id,channel,status,subtotal,subtotal_cents,tax,tax_cents,tip,tip_cents,total,total_cents,total_amount,customer_name,table_name,notes,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).run(publicId,first.customer_id,first.table_id,first.channel,'placed',Number(fromCents(subtotalCents)),subtotalCents,Number(fromCents(taxCents)),taxCents,Number(fromCents(tipCents)),tipCents,Number(fromCents(totalCents)),totalCents,Number(fromCents(totalCents)),first.customer_name,first.table_name,'');
    targetId=Number(inserted.lastInsertRowid);
    for(const order of orders){db.prepare('UPDATE order_items SET order_id=? WHERE order_id=?').run(targetId,order.id);db.prepare("UPDATE orders SET status='merged',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(order.id);db.prepare("INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,'merged',?,'Merged into another order')").run(order.id,String(req.staff.id));}
    db.prepare("INSERT INTO order_status_history(order_id,status,actor_id,note) VALUES(?,'placed',?,'Orders merged')").run(targetId,String(req.staff.id));
    logAction(db,{actorId:String(req.staff.id),actorRole:req.staff.role,action:'order.merge',targetType:'order',targetId:publicId,meta:{sources:ids}});
  });
  return res.status(201).json({order:orderDetails(db.prepare('SELECT * FROM orders WHERE id=?').get(targetId))});
});

router.get('/api/admin/orders', requireStaff, requireRole(['super_admin','admin','manager']), (req, res) => {
  const rows = db.prepare(`SELECT o.*,c.name AS customer_full_name,c.phone AS customer_phone,c.email AS customer_email
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
    ORDER BY o.created_at DESC,o.id DESC LIMIT 500`).all();
  return res.json(rows.map(row => ({ ...orderDetails(row), customer: row.customer_full_name || row.customer_name, customerPhone: row.customer_phone || '' })));
});

export default router;

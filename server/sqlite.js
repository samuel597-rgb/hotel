import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import menu from '../menu.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(process.env.DB_PATH || path.join(here, '../hoteli_poa.db'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

function ensureColumn(table, name, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
}

// Older local POS databases have the catalog already; add only the columns the API needs.
ensureColumn('products', 'firestore_id', 'TEXT');
ensureColumn('products', 'is_available', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('products', 'image_url', 'TEXT');
ensureColumn('products', 'sub_category', 'TEXT');
ensureColumn('products', 'category', 'TEXT');
ensureColumn('local_records', 'owner_id', 'TEXT');
ensureColumn('products', 'category_id', 'INTEGER REFERENCES categories(id) ON DELETE SET NULL');
ensureColumn('products', 'description', "TEXT NOT NULL DEFAULT ''");
ensureColumn('products', 'image_path', 'TEXT');
ensureColumn('products', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('products', 'created_at', 'TEXT');
db.exec("UPDATE products SET created_at=CURRENT_TIMESTAMP WHERE created_at IS NULL OR created_at=''");
ensureColumn('tables', 'display_token', 'TEXT');
const setDisplayToken = db.prepare('UPDATE tables SET display_token=? WHERE id=? AND (display_token IS NULL OR display_token=\'\')');
for (const table of db.prepare('SELECT id FROM tables WHERE display_token IS NULL OR display_token=\'\'').all()) setDisplayToken.run(crypto.randomBytes(24).toString('base64url'), table.id);

// Keep the prior app's order columns while adding the normalized POS fields.
for (const [name, declaration] of Object.entries({
  table_id: 'INTEGER REFERENCES tables(id)', channel: "TEXT NOT NULL DEFAULT 'dine_in'",
  subtotal: 'REAL NOT NULL DEFAULT 0', tax: 'REAL NOT NULL DEFAULT 0', tip: 'REAL NOT NULL DEFAULT 0',
  total: 'REAL NOT NULL DEFAULT 0', staff_id: 'INTEGER', rider_name: 'TEXT', rider_phone: 'TEXT',
  legacy_order_id: 'TEXT', customer_name: "TEXT NOT NULL DEFAULT ''", table_name: "TEXT NOT NULL DEFAULT ''",
  total_amount: 'REAL NOT NULL DEFAULT 0'
})) ensureColumn('orders', name, declaration);
db.exec('UPDATE orders SET legacy_order_id=CAST(id AS TEXT) WHERE legacy_order_id IS NULL');
for (const [name, declaration] of Object.entries({
  qty: 'INTEGER NOT NULL DEFAULT 1', unit_price: 'REAL NOT NULL DEFAULT 0', notes: 'TEXT'
})) ensureColumn('order_items', name, declaration);
db.exec(`UPDATE order_items SET qty=quantity WHERE qty=1 AND quantity<>1;
  UPDATE order_items SET unit_price=price WHERE unit_price=0 AND price<>0;`);

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS orders_legacy_order_id_idx ON orders(legacy_order_id) WHERE legacy_order_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id, active);`);
db.exec(`UPDATE orders SET total = COALESCE(NULLIF(total, 0), total_amount, 0),
  subtotal = COALESCE(NULLIF(subtotal, 0), total_amount, 0),
  customer_name = COALESCE(NULLIF(customer_name, ''), customer_name, '')`);

const categoryIcon = name => ({
  food: '🍽️', drinks: '🥤', 'hot drinks': '☕', snacks: '🥐', chicken: '🍗',
  pizza: '🍕', sushi: '🍣', burgers: '🍔', pasta: '🍝', salads: '🥗', desserts: '🍰', breakfast: '🥐'
}[String(name).toLowerCase()] || '🍽️');
const categoryNames = new Set(db.prepare(`SELECT name FROM categories`).all().map(row => row.name.toLowerCase()));
const legacyCategories = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(sub_category,''),
  CASE lower(category) WHEN 'drinks' THEN 'Drinks' ELSE 'Food' END) AS name FROM products`).all();
let nextCategoryOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories').get().n;
const insertCategory = db.prepare('INSERT OR IGNORE INTO categories(name,icon,sort_order) VALUES(?,?,?)');
for (const row of legacyCategories) {
  if (!row.name || categoryNames.has(row.name.toLowerCase())) continue;
  insertCategory.run(row.name, categoryIcon(row.name), nextCategoryOrder++);
  categoryNames.add(row.name.toLowerCase());
}
const setCategory = db.prepare(`UPDATE products SET category_id=(SELECT id FROM categories WHERE name=? COLLATE NOCASE)
  WHERE id=? AND category_id IS NULL`);
for (const row of db.prepare('SELECT id,category,sub_category FROM products WHERE category_id IS NULL').all()) {
  const name = row.sub_category || (String(row.category).toLowerCase() === 'drinks' ? 'Drinks' : 'Food');
  setCategory.run(name, row.id);
}
db.exec(`UPDATE products SET image_url=image_path WHERE image_path IS NOT NULL AND image_path!='' AND image_url='';
  UPDATE products SET active=is_available WHERE active=1 AND is_available=0;`);

// Some supplied databases use a singular `product` table. Import its catalog
// once into the canonical `products` table while retaining its original IDs.
const singularProductTable = db.prepare(`SELECT type FROM sqlite_master WHERE name = 'product'`).get()?.type === 'table';
const pluralProductCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
if (singularProductTable && !pluralProductCount) {
  const legacyRows = db.prepare('SELECT * FROM product').all();
  const insert = db.prepare(`INSERT INTO products
      (name, price, category, image_url, sub_category, firestore_id, is_available, category_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const row of legacyRows) {
      const externalId = row.firestore_id ?? row.id ?? null;
      const categoryName = row.sub_category || row.category || 'Food';
      insert.run(row.name || row.product_name || 'Menu item', Number(row.price) || 0,
        row.category || row.department || 'food', row.image_url || row.imageUrl || '',
        row.sub_category || row.categoryId || '', externalId == null ? null : String(externalId),
        row.is_available === 0 || row.isAvailable === false ? 0 : 1,
        db.prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE').get(categoryName)?.id || null,
        row.is_available === 0 || row.isAvailable === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const productCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
if (!productCount) {
  const insert = db.prepare(`INSERT INTO products
    (name, price, category, image_url, sub_category, firestore_id, is_available, category_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const [index, product] of menu.entries()) {
      const id = String(product.id || `${product.categoryId || 'item'}-${index + 1}`);
      const categoryName = product.sub_category || product.categoryId || (String(product.category).toLowerCase() === 'drinks' ? 'Drinks' : 'Food');
      insert.run(product.name, Number(product.price) || 0, product.category || product.department || 'food',
        product.image_url || product.imageUrl || '', product.sub_category || product.categoryId || '', id,
        product.isAvailable === false ? 0 : 1,
        db.prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE').get(categoryName)?.id || null,
        product.isAvailable === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const allProductCategories = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(sub_category,''),
  CASE lower(category) WHEN 'drinks' THEN 'Drinks' ELSE 'Food' END) AS name FROM products`).all();
nextCategoryOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories').get().n;
for (const row of allProductCategories) {
  if (!row.name || categoryNames.has(row.name.toLowerCase())) continue;
  insertCategory.run(row.name, categoryIcon(row.name), nextCategoryOrder++);
  categoryNames.add(row.name.toLowerCase());
}
for (const row of db.prepare('SELECT id,category,sub_category FROM products WHERE category_id IS NULL').all()) {
  const name=row.sub_category || (String(row.category).toLowerCase()==='drinks'?'Drinks':'Food');
  setCategory.run(name,row.id);
}

db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)`)
  .run('general', JSON.stringify({ id: 'general', hotelName: 'HOTELI POA', currency: 'KES', taxRate: 16, taxMode: 'included' }));

const parseJson = value => {
  try { return JSON.parse(value); } catch { return { value }; }
};
const externalProductId = row => String(row.firestore_id || row.id);
const productData = row => ({
  id: externalProductId(row), name: row.name, price: Number(row.price),
  category: row.category || 'food', department: row.category || 'food',
  categoryId: String(row.category_id || row.sub_category || row.category || 'food'), sub_category: row.sub_category || '',
  description: row.description || '', imagePath: row.image_path || '',
  imageUrl: row.image_path || row.image_url || '', image_url: row.image_path || row.image_url || '',
  isAvailable: row.is_available !== 0 && row.active !== 0
});

export function readRecords(collectionPath, { ownerId, id } = {}) {
  if (collectionPath === 'products') {
    const rows = id
      ? db.prepare('SELECT * FROM products WHERE CAST(id AS TEXT) = ? OR firestore_id = ?').all(String(id), String(id))
      : db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name COLLATE NOCASE').all();
    return rows.map(row => ({ id: externalProductId(row), owner_id: null, data: productData(row) }));
  }
  if (collectionPath === 'categories') {
    const rows = db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY sort_order,name COLLATE NOCASE').all();
    return rows.map(row => ({ id: String(row.id), owner_id: null,
      data: { id: String(row.id), name: row.name, icon: row.icon, sequence: row.sort_order, sort_order: row.sort_order, isAvailable: row.active !== 0 } }));
  }
  if (collectionPath === 'settings') {
    const rows = id
      ? db.prepare('SELECT key, value FROM settings WHERE key = ?').all(String(id))
      : db.prepare('SELECT key, value FROM settings').all();
    return rows.map(row => {
      const data = parseJson(row.value);
      return { id: row.key, owner_id: null, data: data && typeof data === 'object' ? { id: row.key, ...data } : { id: row.key, value: data } };
    });
  }
  if (collectionPath === 'orders') {
    let rows = db.prepare(`SELECT * FROM orders WHERE (? IS NULL OR legacy_order_id=?) ORDER BY created_at DESC`).all(id || null, id || null);
    const normalized = rows.map(row => {
      const lines = db.prepare(`SELECT oi.*, p.name FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? ORDER BY oi.id`).all(row.id)
        .map(line => ({ id: String(line.id), productId: String(line.product_id || ''), name: line.name || 'Menu item', qty: line.qty || line.quantity || 1,
          quantity: line.qty || line.quantity || 1, price: Number(line.unit_price || line.price || 0), subtotal: Number(line.unit_price || line.price || 0) * (line.qty || line.quantity || 1), notes: line.notes || '' }));
      const stored = db.prepare('SELECT payload,owner_id FROM local_records WHERE collection_name=? AND document_id=?').get('orders', row.legacy_order_id || String(row.id));
      const payload = { ...(stored ? parseJson(stored.payload) : {}), id: row.legacy_order_id || String(row.id), table: row.table_name || '', tableId: row.table_id,
        channel: row.channel || 'dine_in', status: row.status === 'paid' ? 'paid' : row.status || 'new',
        paymentStatus: row.status === 'paid' ? 'paid' : 'pending', subtotal: Number(row.subtotal || row.total_amount || 0),
        tax: Number(row.tax || 0), tip: Number(row.tip || 0), total: Number(row.total || row.total_amount || 0),
        customer: row.customer_name || '', waiterId: stored?.owner_id || row.staff_id ? (parseJson(stored?.payload || '{}').waiterId || String(row.staff_id || '')) : null,
        riderName: row.rider_name || '', riderPhone: row.rider_phone || '', createdAt: row.created_at, lines };
      return { id: payload.id, owner_id: stored?.owner_id || null, data: payload };
    });
    if (id) return normalized;
    const existingIds = new Set(normalized.map(row => row.id));
    const legacy = db.prepare('SELECT document_id AS id,owner_id,payload FROM local_records WHERE collection_name=?').all('orders')
      .filter(row => !existingIds.has(row.id)).map(row => ({ id: row.id, owner_id: row.owner_id, data: parseJson(row.payload) }));
    return [...normalized, ...legacy];
  }
  let rows;
  if (id && ownerId) rows = db.prepare('SELECT document_id AS id, owner_id, payload FROM local_records WHERE collection_name = ? AND id = ? AND (owner_id IS NULL OR owner_id = ?)').all(collectionPath, String(id), ownerId);
  else if (id) rows = db.prepare('SELECT document_id AS id, owner_id, payload FROM local_records WHERE collection_name = ? AND id = ?').all(collectionPath, String(id));
  else if (ownerId) rows = db.prepare('SELECT document_id AS id, owner_id, payload FROM local_records WHERE collection_name = ? AND (owner_id IS NULL OR owner_id = ?)').all(collectionPath, ownerId);
  else rows = db.prepare('SELECT document_id AS id, owner_id, payload FROM local_records WHERE collection_name = ?').all(collectionPath);
  return rows.map(row => ({ id: row.id, owner_id: row.owner_id, data: parseJson(row.payload) }));
}

export function writeRecord(collectionPath, id, data, ownerId = null) {
  const key = String(id);
  if (collectionPath === 'products') {
    const existing = db.prepare('SELECT id FROM products WHERE CAST(id AS TEXT) = ? OR firestore_id = ? LIMIT 1').get(key, key);
    const category = data.categoryId ? db.prepare('SELECT * FROM categories WHERE CAST(id AS TEXT)=? OR name=? COLLATE NOCASE').get(String(data.categoryId), String(data.categoryId)) : null;
    const department = data.category || data.department || (category?.name === 'Drinks' ? 'drinks' : 'food');
    const image = data.image_path || data.imagePath || data.image_url || data.imageUrl || '';
    if (existing) db.prepare(`UPDATE products SET name=?, price=?, category=?, image_url=?, image_path=?, description=?,
      sub_category=?, category_id=?, firestore_id=?, is_available=?, active=? WHERE id=?`)
      .run(data.name || 'Menu item', Number(data.price) || 0, department, image, image || null,
        data.description || '', category?.name || data.sub_category || data.categoryId || '', category?.id || null,
        key, data.isAvailable === false ? 0 : 1, data.isAvailable === false ? 0 : 1, existing.id);
    else db.prepare(`INSERT INTO products(name, price, category, image_url, image_path, description, sub_category,
      category_id, firestore_id, is_available, active) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(data.name || 'Menu item', Number(data.price) || 0, department, image, image || null, data.description || '',
        category?.name || data.sub_category || data.categoryId || '', category?.id || null, key,
        data.isAvailable === false ? 0 : 1, data.isAvailable === false ? 0 : 1);
    return;
  }
  if (collectionPath === 'settings') {
    db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, JSON.stringify(data));
    return;
  }
  if (collectionPath === 'orders') {
    const existing = db.prepare('SELECT id FROM orders WHERE legacy_order_id=?').get(key);
    const tableName = String(data.table || data.table_name || '');
    const tableId = data.tableId ? Number(data.tableId) : (tableName ? Number(tableName.replace(/\D/g, '')) || null : null);
    const status = String(data.status || 'new');
    const staffId=data.staffId ? Number(data.staffId) : (data.waiterId ? db.prepare('SELECT id FROM staff WHERE auth_user_id=?').get(String(data.waiterId))?.id || null : null);
    const values = [tableId, String(data.channel || (tableName ? 'dine_in' : 'takeout')), status,
      Number(data.subtotal || 0), Number(data.tax || 0), Number(data.tip || 0), Number(data.total || data.total_amount || 0),
      staffId, String(data.riderName || ''), String(data.riderPhone || ''),
      tableName, Number(data.total || data.total_amount || 0), String(data.customer || data.customer_name || ''), key];
    if (existing) db.prepare(`UPDATE orders SET table_id=?,channel=?,status=?,subtotal=?,tax=?,tip=?,total=?,staff_id=?,rider_name=?,rider_phone=?,table_name=?,total_amount=?,customer_name=? WHERE id=?`)
      .run(...values.slice(0, 13), existing.id);
    else db.prepare(`INSERT INTO orders(table_id,channel,status,subtotal,tax,tip,total,staff_id,rider_name,rider_phone,table_name,total_amount,customer_name,legacy_order_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
    const orderId = existing?.id || db.prepare('SELECT id FROM orders WHERE legacy_order_id=?').get(key).id;
    if (Array.isArray(data.lines)) {
      db.prepare('DELETE FROM order_items WHERE order_id=?').run(orderId);
      const insertLine = db.prepare('INSERT INTO order_items(order_id,product_id,qty,unit_price,notes,quantity,price) VALUES(?,?,?,?,?,?,?)');
      for (const line of data.lines) {
        const product = db.prepare('SELECT id FROM products WHERE CAST(id AS TEXT)=? OR firestore_id=?').get(String(line.productId || ''), String(line.productId || ''));
        const qty = Number(line.qty || line.quantity || 1), price = Number(line.price || line.unit_price || 0);
        insertLine.run(orderId, product?.id || null, qty, price, String(line.notes || ''), qty, price);
      }
    }
    db.prepare(`INSERT INTO local_records(collection_name,document_id,payload,updated_at,owner_id)
      VALUES('orders',?,?,CURRENT_TIMESTAMP,?) ON CONFLICT(collection_name,document_id) DO UPDATE SET
      payload=excluded.payload,updated_at=CURRENT_TIMESTAMP,owner_id=COALESCE(local_records.owner_id,excluded.owner_id)`)
      .run(key, JSON.stringify(data), ownerId);
    return;
  }
  db.prepare(`INSERT INTO local_records(collection_name, document_id, payload, updated_at, owner_id)
    VALUES(?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(collection_name, document_id) DO UPDATE SET payload=excluded.payload,
    updated_at=CURRENT_TIMESTAMP, owner_id=COALESCE(local_records.owner_id, excluded.owner_id)`)
    .run(collectionPath, key, JSON.stringify(data), ownerId);
}

export function deleteRecord(collectionPath, id) {
  if (collectionPath === 'products') {
    db.prepare('DELETE FROM products WHERE CAST(id AS TEXT) = ? OR firestore_id = ?').run(String(id), String(id));
    return;
  }
  if (collectionPath === 'settings') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(String(id));
    return;
  }
  db.prepare('DELETE FROM local_records WHERE collection_name = ? AND document_id = ?').run(collectionPath, String(id));
}

export function findUserByToken(token) {
  const digest = tokenDigest(token);
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.phone, u.photo_url, u.role
    FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at > ?`).get(digest, Date.now());
  return row ? { id: row.id, uid: row.id, email: row.email, role: row.role,
    user_metadata: { full_name: row.name, phone: row.phone || '', avatar_url: row.photo_url || '' } } : null;
}

export const tokenDigest = token => crypto.createHash('sha256').update(token).digest('hex');
export function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(tokenDigest(token), userId, Date.now() + 30 * 24 * 60 * 60 * 1000);
  const staff=db.prepare('SELECT id FROM staff WHERE auth_user_id=?').get(userId);
  if(staff) db.prepare("INSERT INTO sessions(staff_id,token,expires_at) VALUES(?,?,datetime('now','+30 days'))").run(staff.id,tokenDigest(token));
  return token;
}

export function deleteSession(token) {
  const digest=tokenDigest(token);
  db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest);
  db.prepare('DELETE FROM sessions WHERE token=?').run(digest);
}

export { dbPath };

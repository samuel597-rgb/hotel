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

// Some supplied databases use a singular `product` table. Import its catalog
// once into the canonical `products` table while retaining its original IDs.
const singularProductTable = db.prepare(`SELECT type FROM sqlite_master WHERE name = 'product'`).get()?.type === 'table';
const pluralProductCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
if (singularProductTable && !pluralProductCount) {
  const legacyRows = db.prepare('SELECT * FROM product').all();
  const insert = db.prepare(`INSERT INTO products
    (name, price, category, image_url, sub_category, firestore_id, is_available)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const row of legacyRows) {
      const externalId = row.firestore_id ?? row.id ?? null;
      insert.run(row.name || row.product_name || 'Menu item', Number(row.price) || 0,
        row.category || row.department || 'food', row.image_url || row.imageUrl || '',
        row.sub_category || row.categoryId || '', externalId == null ? null : String(externalId),
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
    (name, price, category, image_url, sub_category, firestore_id, is_available)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const [index, product] of menu.entries()) {
      const id = String(product.id || `${product.categoryId || 'item'}-${index + 1}`);
      insert.run(product.name, Number(product.price) || 0, product.category || product.department || 'food',
        product.image_url || product.imageUrl || '', product.sub_category || product.categoryId || '', id,
        product.isAvailable === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)`)
  .run('general', JSON.stringify({ id: 'general', hotelName: 'HOTELI POA', currency: 'KES', taxRate: 0 }));

const parseJson = value => {
  try { return JSON.parse(value); } catch { return { value }; }
};
const externalProductId = row => String(row.firestore_id || row.id);
const productData = row => ({
  id: externalProductId(row), name: row.name, price: Number(row.price),
  category: row.category || 'food', department: row.category || 'food',
  categoryId: row.sub_category || row.category || 'food', sub_category: row.sub_category || '',
  imageUrl: row.image_url || '', image_url: row.image_url || '', isAvailable: row.is_available !== 0
});

export function readRecords(collectionPath, { ownerId, id } = {}) {
  if (collectionPath === 'products') {
    const rows = id
      ? db.prepare('SELECT * FROM products WHERE CAST(id AS TEXT) = ? OR firestore_id = ?').all(String(id), String(id))
      : db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
    return rows.map(row => ({ id: externalProductId(row), owner_id: null, data: productData(row) }));
  }
  if (collectionPath === 'categories') {
    const rows = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(sub_category, ''), category, 'food') AS id,
      COALESCE(NULLIF(sub_category, ''), category, 'Food') AS name, COALESCE(category, 'food') AS department
      FROM products ORDER BY name COLLATE NOCASE`).all();
    return rows.map(row => ({ id: String(row.id), owner_id: null,
      data: { id: String(row.id), name: row.name, department: row.department, isAvailable: true } }));
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
    const fields = [data.name || 'Menu item', Number(data.price) || 0, data.category || data.department || 'food',
      data.image_url || data.imageUrl || '', data.sub_category || data.categoryId || '', key,
      data.isAvailable === false ? 0 : 1];
    if (existing) db.prepare(`UPDATE products SET name=?, price=?, category=?, image_url=?, sub_category=?,
      firestore_id=?, is_available=? WHERE id=?`).run(...fields, existing.id);
    else db.prepare(`INSERT INTO products(name, price, category, image_url, sub_category, firestore_id, is_available)
      VALUES(?,?,?,?,?,?,?)`).run(...fields);
    return;
  }
  if (collectionPath === 'settings') {
    db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, JSON.stringify(data));
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
  return token;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenDigest(token));
}

export { dbPath };

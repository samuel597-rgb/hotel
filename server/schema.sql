-- SQLite schema for the local/free demo. No customer data belongs in this file.
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'food',
  image_url TEXT NOT NULL DEFAULT '',
  sub_category TEXT NOT NULL DEFAULT '',
  firestore_id TEXT,
  is_available INTEGER NOT NULL DEFAULT 1,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  discount_percent REAL NOT NULL DEFAULT 0,
  image_path TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','reserved','cleaning')),
  UNIQUE(floor, number)
);

-- Existing databases with legacy orders retain their columns; sqlite.js adds these fields.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER REFERENCES tables(id),
  channel TEXT NOT NULL DEFAULT 'dine_in',
  status TEXT NOT NULL DEFAULT 'new',
  subtotal REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  tip REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  staff_id INTEGER,
  rider_name TEXT,
  rider_phone TEXT,
  table_name TEXT NOT NULL DEFAULT '',
  total_amount REAL NOT NULL DEFAULT 0,
  customer_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  notes TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  price REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_user_id TEXT UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  pin_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS register_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  opening_cash REAL NOT NULL DEFAULT 0,
  opening_note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  phone TEXT PRIMARY KEY,
  stamps INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The singular name is retained for tools that expect the requested product table.
CREATE VIEW IF NOT EXISTS product AS SELECT * FROM products;

CREATE TABLE IF NOT EXISTS local_records (
  collection_name TEXT NOT NULL,
  document_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  owner_id TEXT,
  PRIMARY KEY (collection_name, document_id)
);

CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer','waiter','cashier','supervisor','manager','admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_presence (
  user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('brand_name','"HOTELI POA"'), ('tax_mode','"included"'), ('tax_rate','16'), ('logo_path','""');

INSERT OR IGNORE INTO tables(floor,number,status)
  SELECT 'Main Floor', value, 'available' FROM (SELECT 1 value UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8);
INSERT OR IGNORE INTO tables(floor,number,status)
  SELECT 'Patio', value, 'available' FROM (SELECT 1 value UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4);

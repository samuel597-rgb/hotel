-- SQLite schema for the local/free demo. No customer data belongs in this file.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'food',
  image_url TEXT NOT NULL DEFAULT '',
  sub_category TEXT NOT NULL DEFAULT '',
  firestore_id TEXT,
  is_available INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}'
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
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);

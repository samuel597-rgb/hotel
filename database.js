const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const menu = require('./menu');

const dbPath = path.resolve(process.env.SQLITE_PATH || path.join(__dirname, 'hoteli_poa.db'));
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database opening error: ', err);
    else console.log('Connected to SQLite Database.');
});
db.run('PRAGMA foreign_keys = ON');

db.serialize(() => {
    // 1. Products Table
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        category TEXT NOT NULL,
        sub_category TEXT,
        image_url TEXT,
        firestore_id TEXT,
        is_available INTEGER NOT NULL DEFAULT 1
    )`);

    // 2. Orders Table
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        total_amount REAL NOT NULL,
        status TEXT DEFAULT 'active',
        customer_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrate databases created before customer_name was added to orders.
    db.all("PRAGMA table_info(orders)", (err, columns) => {
        if (err) {
            console.error('Orders schema check failed: ', err);
            return;
        }
        if (!columns.some(column => column.name === 'customer_name')) {
            db.run("ALTER TABLE orders ADD COLUMN customer_name TEXT", (alterErr) => {
                if (alterErr) console.error('Orders schema migration failed: ', alterErr);
            });
        }
    });

    // 3. Order Items Table
    db.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        product_id INTEGER,
        quantity INTEGER,
        price REAL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )`);

    // 4. Messages Table
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. Settings Table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // Firestore is the source of truth. SQLite stores a local backup and
    // durable outbox entries when Firestore cannot be reached.
    db.run(`CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS local_records (
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (collection_name, document_id)
    )`);

    // Add catalog columns without dropping tables or disturbing past orders.
    db.all('PRAGMA table_info(products)', (schemaError, columns) => {
        if (schemaError) {
            console.error('Products schema check failed:', schemaError.message);
            return;
        }
        const existingColumns = new Set(columns.map(column => column.name));
        const migrations = [
            ['sub_category', 'ALTER TABLE products ADD COLUMN sub_category TEXT'],
            ['firestore_id', 'ALTER TABLE products ADD COLUMN firestore_id TEXT'],
            ['is_available', 'ALTER TABLE products ADD COLUMN is_available INTEGER NOT NULL DEFAULT 1']
        ].filter(([name]) => !existingColumns.has(name));
        if (!migrations.length) return seedLocalMenu();
        let remaining = migrations.length;
        for (const [, sql] of migrations) {
            db.run(sql, migrationError => {
                if (migrationError) console.error('Products schema migration failed:', migrationError.message);
                if (--remaining === 0) seedLocalMenu();
            });
        }
    });

    function seedLocalMenu() {
        db.get("SELECT value FROM settings WHERE key = 'menuVersion'", (versionError, row) => {
            if (versionError) {
                console.error('Menu version lookup failed:', versionError.message);
                return;
            }
            if (Number(row?.value || 0) >= 2) return;

            // Retire the old demo catalog in place so existing order_item foreign
            // keys remain valid. New menu items reuse matching rows by name.
            db.run('UPDATE products SET is_available = 0', retireError => {
                if (retireError) console.error('Old catalog could not be retired:', retireError.message);
            });
            let remaining = menu.length;
            let hadItemError = false;
            const finishItem = error => {
                if (error) {
                    hadItemError = true;
                    console.error('Local menu item could not be saved:', error.message);
                }
                if (--remaining !== 0) return;
                if (hadItemError) return;
                db.run("INSERT INTO settings (key, value) VALUES ('menuVersion', '2') ON CONFLICT(key) DO UPDATE SET value='2'", markerError => {
                    if (markerError) console.error('Menu version could not be saved:', markerError.message);
                    else console.log(`SQLite menu seeded with ${menu.length} products.`);
                });
            };
            for (const product of menu) {
                const firestoreId = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                db.get('SELECT id FROM products WHERE firestore_id = ? OR name = ? COLLATE NOCASE LIMIT 1', [firestoreId, product.name], (lookupError, existing) => {
                    if (lookupError) return finishItem(lookupError);
                    const values = [product.name, product.price, product.department, product.sub_category, product.image_url, firestoreId];
                    const sql = existing
                        ? 'UPDATE products SET name=?, price=?, category=?, sub_category=?, image_url=?, firestore_id=?, is_available=1 WHERE id=?'
                        : 'INSERT INTO products (name, price, category, sub_category, image_url, firestore_id, is_available) VALUES (?, ?, ?, ?, ?, ?, 1)';
                    db.run(sql, existing ? [...values, existing.id] : values, error => finishItem(error));
                });
            }
        });
    }

    // Seed Settings Defaults
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('fontSize', '14')`);
});
module.exports = db;

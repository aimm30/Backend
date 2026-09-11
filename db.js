const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/kanjimart.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_normalized TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL, -- 'signup' | 'reset'
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_lookup ON verification_codes(email, purpose);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  category TEXT NOT NULL,
  category_icon TEXT,
  tags TEXT,
  price REAL NOT NULL,
  old_price REAL,
  discount_pct REAL,
  rating REAL,
  reviews_count INTEGER,
  in_stock INTEGER NOT NULL DEFAULT 1,
  image TEXT,
  description TEXT,
  features TEXT,
  on_sale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_name TEXT,
  phone TEXT,
  city TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  accuracy REAL,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'Confirmed',
  total REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  product_id INTEGER,
  name TEXT NOT NULL,
  unit_price REAL NOT NULL,
  quantity INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

// One-time seed of the product catalog from the storefront's built-in demo
// data, so /products and /categories have real content on first run. Safe
// to re-run: it only seeds when the table is empty.
function seedProductsIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM products').get();
  if (count > 0) return;

  const seedPath = path.join(__dirname, 'seed-products.json');
  if (!fs.existsSync(seedPath)) return;
  const products = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  const insert = db.prepare(`
    INSERT INTO products (id, name, slug, category, category_icon, tags, price, old_price, discount_pct, rating, reviews_count, in_stock, image, description, features, on_sale)
    VALUES (@id, @name, @slug, @category, @categoryIcon, @tags, @price, @oldPrice, @discountPct, @rating, @reviewsCount, @inStock, @image, @description, @features, @onSale)
  `);

  const insertMany = db.transaction((rows) => {
    for (const p of rows) {
      insert.run({
        id: p.id,
        name: p.name,
        slug: p.slug || null,
        category: p.category,
        categoryIcon: p.categoryIcon || null,
        tags: JSON.stringify(p.tags || []),
        price: p.price,
        oldPrice: p.oldPrice ?? p.price,
        discountPct: p.discountPct || 0,
        rating: p.rating || 0,
        reviewsCount: p.reviewsCount || 0,
        inStock: p.inStock === false ? 0 : 1,
        image: p.image || null,
        description: p.description || null,
        features: JSON.stringify(p.features || []),
        onSale: p.onSale ? 1 : 0,
      });
    }
  });

  insertMany(products);
  console.log(`[db] seeded ${products.length} products`);
}

seedProductsIfEmpty();

module.exports = db;

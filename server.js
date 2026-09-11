require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const { normalizeEmail, generateSixDigitCode, generateOrderId } = require('./helpers');
const { sendVerificationEmail, SMTP_CONFIGURED } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'aimloqris@gmail.com').toLowerCase();
const EXPOSE_DEV_CODE = String(process.env.EXPOSE_DEV_CODE || 'false').toLowerCase() === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';
const DELIVERY_FEE = 100;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
}));
app.use(express.json());
app.use(cookieSession({
  name: 'kanji_session',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  sameSite: IS_PROD ? 'none' : 'lax',
  secure: IS_PROD,
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use(['/auth/login', '/auth/signup', '/auth/forgot-password', '/auth/verify', '/auth/reset-password'], authLimiter);

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------
function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    isAdmin: !!row.is_admin,
    emailVerified: !!row.email_verified,
  };
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim());
}

function findUserByNormalizedEmail(normEmail) {
  return db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(normEmail);
}

function issueCode(email, purpose) {
  db.prepare('DELETE FROM verification_codes WHERE email = ? COLLATE NOCASE AND purpose = ?').run(email, purpose);
  const code = generateSixDigitCode();
  db.prepare(`INSERT INTO verification_codes (email, purpose, code, expires_at, attempts, created_at)
              VALUES (?, ?, ?, ?, 0, ?)`)
    .run(email, purpose, code, Date.now() + CODE_TTL_MS, Date.now());
  return code;
}

async function sendCode(email, name, purpose) {
  const code = issueCode(email, purpose);
  const result = await sendVerificationEmail({ to: email, name, code, purpose }).catch(err => {
    console.error('[mailer] send failed:', err.message);
    return { delivered: false };
  });
  return { code, delivered: result.delivered };
}

function requireAuth(req, res, next) {
  const userId = req.session && req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) { req.session = null; return res.status(401).json({ error: 'Session expired.' }); }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin && req.user.email.toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  });
}

// ---------------------------------------------------------------
// health / catalog
// ---------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, smtpConfigured: SMTP_CONFIGURED });
});

app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products').all();
  const products = rows.map(p => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    category: p.category,
    categoryIcon: p.category_icon,
    tags: JSON.parse(p.tags || '[]'),
    price: p.price,
    oldPrice: p.old_price,
    discountPct: p.discount_pct,
    rating: p.rating,
    reviewsCount: p.reviews_count,
    inStock: !!p.in_stock,
    image: p.image,
    description: p.description,
    features: JSON.parse(p.features || '[]'),
    onSale: !!p.on_sale,
  }));
  res.json({ products });
});

app.get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT category, COUNT(*) AS count FROM products GROUP BY category').all();
  res.json({ categories: rows });
});

// ---------------------------------------------------------------
// auth: signup -> verify
// ---------------------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '');

  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !/^\d{10}$/.test(phone) || password.length < 8) {
    return res.status(400).json({ error: 'Please fill in all fields correctly (10-digit phone, 8+ character password).' });
  }

  const normEmail = normalizeEmail(email);

  // This is the check that guarantees ONE account per Gmail address (and per
  // email generally) across every device -- it looks at the shared
  // database, not anything stored in a browser.
  const existingByNorm = findUserByNormalizedEmail(normEmail);
  if (existingByNorm && existingByNorm.email_verified) {
    return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const isAdmin = email === ADMIN_EMAIL ? 1 : 0;

  if (existingByNorm && !existingByNorm.email_verified) {
    // They started signing up before but never verified -- update the
    // pending row instead of creating a duplicate, and send a fresh code.
    db.prepare('UPDATE users SET name = ?, phone = ?, password_hash = ?, is_admin = ? WHERE id = ?')
      .run(name, phone, passwordHash, isAdmin, existingByNorm.id);
  } else {
    db.prepare(`INSERT INTO users (name, email, email_normalized, phone, password_hash, is_admin, email_verified, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(name, email, normEmail, phone, passwordHash, isAdmin, Date.now());
  }

  const { code, delivered } = await sendCode(email, name, 'signup');
  res.json({ ok: true, delivered, devCode: EXPOSE_DEV_CODE ? code : undefined });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No pending signup found for that email.' });
  const { code, delivered } = await sendCode(email, user.name, 'signup');
  res.json({ ok: true, delivered, devCode: EXPOSE_DEV_CODE ? code : undefined });
});

app.post('/api/auth/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const enteredCode = String(req.body.code || '').trim();

  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'Verification expired -- please sign up again.' });

  const row = db.prepare(`SELECT * FROM verification_codes WHERE email = ? COLLATE NOCASE AND purpose = 'signup' ORDER BY id DESC LIMIT 1`).get(email);
  if (!row) return res.status(400).json({ error: 'Verification expired -- please sign up again.' });
  if (Date.now() > row.expires_at) return res.status(400).json({ error: 'That code has expired. Tap "Resend Code" to get a new one.' });
  if (row.code !== enteredCode) {
    const attempts = row.attempts + 1;
    db.prepare('UPDATE verification_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
    if (attempts >= MAX_CODE_ATTEMPTS) {
      return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new code.' });
    }
    return res.status(400).json({ error: `That code is incorrect. ${MAX_CODE_ATTEMPTS - attempts} attempt(s) left.` });
  }

  const isAdmin = user.email.toLowerCase() === ADMIN_EMAIL ? 1 : user.is_admin;
  db.prepare('UPDATE users SET email_verified = 1, is_admin = ? WHERE id = ?').run(isAdmin, user.id);
  db.prepare(`DELETE FROM verification_codes WHERE email = ? COLLATE NOCASE AND purpose = 'signup'`).run(email);

  req.session.userId = user.id;
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated) });
});

// ---------------------------------------------------------------
// auth: login / logout / me
// ---------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials. Please check your password or sign up.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials. Please check your password or sign up.' });

  if (!user.email_verified) {
    const { code, delivered } = await sendCode(user.email, user.name, 'signup');
    return res.json({
      requiresVerification: true,
      user: { name: user.name, email: user.email, phone: user.phone },
      delivered,
      devCode: EXPOSE_DEV_CODE ? code : undefined,
    });
  }

  const isAdmin = user.email.toLowerCase() === ADMIN_EMAIL ? 1 : user.is_admin;
  if (isAdmin !== user.is_admin) {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin, user.id);
  }

  req.session.userId = user.id;
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------
// auth: forgot / reset password
// ---------------------------------------------------------------
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No account found with that email.' });
  const { code, delivered } = await sendCode(email, user.name, 'reset');
  res.json({ ok: true, delivered, devCode: EXPOSE_DEV_CODE ? code : undefined });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const enteredCode = String(req.body.code || '').trim();
  const newPassword = String(req.body.newPassword || '');

  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'Something went wrong finding your account -- please try again.' });

  const row = db.prepare(`SELECT * FROM verification_codes WHERE email = ? COLLATE NOCASE AND purpose = 'reset' ORDER BY id DESC LIMIT 1`).get(email);
  if (!row) return res.status(400).json({ error: 'Reset session expired -- please start again.' });
  if (Date.now() > row.expires_at) return res.status(400).json({ error: 'That code has expired. Tap "Resend Code" to get a new one.' });
  if (row.code !== enteredCode) return res.status(400).json({ error: 'That code is incorrect. Please check your email and try again.' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  db.prepare(`DELETE FROM verification_codes WHERE email = ? COLLATE NOCASE AND purpose = 'reset'`).run(email);

  res.json({ ok: true });
});

// ---------------------------------------------------------------
// orders
// ---------------------------------------------------------------
app.get('/api/orders', requireAuth, (req, res) => {
  const orderRows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const itemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const orders = orderRows.map(o => ({
    orderId: o.order_id,
    date: o.created_at,
    items: itemStmt.all(o.order_id).map(i => ({ id: i.product_id, name: i.name, price: i.unit_price, qty: i.quantity })),
    total: o.total,
    paymentMethod: o.payment_method,
    paymentCard: null,
    status: o.status,
  }));
  res.json({ orders });
});

app.post('/api/orders', requireAuth, (req, res) => {
  const { customer = {}, location = {}, paymentMethod, items = [], termsAccepted } = req.body;

  if (!termsAccepted) return res.status(400).json({ error: 'Please accept the terms to place your order.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Your cart is empty.' });
  if (!customer.name || !customer.phone || !customer.city || !customer.address) {
    return res.status(400).json({ error: 'Please fill in all delivery details.' });
  }

  const productStmt = db.prepare('SELECT * FROM products WHERE id = ?');
  let subtotal = 0;
  const lineItems = [];
  for (const it of items) {
    const product = productStmt.get(it.productId);
    if (!product) return res.status(400).json({ error: `Product ${it.productId} not found.` });
    if (!product.in_stock) return res.status(400).json({ error: `"${product.name}" is currently out of stock.` });
    const qty = Math.max(1, Number(it.quantity) || 1);
    // Prices are always taken from the database here, never from the
    // client -- this is what "server-verified checkout pricing" means.
    subtotal += product.price * qty;
    lineItems.push({ productId: product.id, name: product.name, unitPrice: product.price, qty });
  }
  const total = subtotal + DELIVERY_FEE;

  let orderId = generateOrderId();
  while (db.prepare('SELECT 1 FROM orders WHERE order_id = ?').get(orderId)) {
    orderId = generateOrderId();
  }

  const insertOrder = db.prepare(`INSERT INTO orders (order_id, user_id, customer_name, phone, city, address, lat, lng, accuracy, payment_method, status, total, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Confirmed', ?, ?)`);
  const insertItem = db.prepare(`INSERT INTO order_items (order_id, product_id, name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)`);

  const createOrder = db.transaction(() => {
    insertOrder.run(orderId, req.user.id, customer.name, customer.phone, customer.city, customer.address,
      location.lat ?? null, location.lng ?? null, location.accuracy ?? null, paymentMethod || '—', total, Date.now());
    for (const li of lineItems) insertItem.run(orderId, li.productId, li.name, li.unitPrice, li.qty);
  });
  createOrder();

  res.json({ order: { orderId, total } });
});

// ---------------------------------------------------------------
// admin dashboard -- shared across every device, unlike the old
// localStorage-only version which could only ever see this one browser.
// ---------------------------------------------------------------
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const orderRows = db.prepare('SELECT o.*, u.email AS user_email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC').all();
  const itemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const orders = orderRows.map(o => ({
    orderId: o.order_id,
    created_at: o.created_at,
    customerName: o.customer_name,
    phone: o.phone,
    email: o.user_email,
    items: itemStmt.all(o.order_id).map(i => ({ product_id: i.product_id, name: i.name, unit_price: i.unit_price, quantity: i.quantity })),
    total: o.total,
    paymentMethod: o.payment_method,
    status: o.status,
  }));

  const customers = db.prepare('SELECT name, email, phone, email_verified, created_at FROM users ORDER BY created_at DESC').all();

  const summary = {
    revenue: orders.reduce((s, o) => s + Number(o.total || 0), 0),
    orders: orders.length,
    units: orders.reduce((s, o) => s + o.items.reduce((s2, i) => s2 + Number(i.quantity || 0), 0), 0),
    customers: customers.filter(c => c.email_verified).length,
  };

  res.json({ orders, customers, summary });
});

app.listen(PORT, () => {
  console.log(`[kanjimart backend] listening on port ${PORT}`);
  console.log(`[kanjimart backend] admin email: ${ADMIN_EMAIL}`);
  console.log(`[kanjimart backend] SMTP configured: ${SMTP_CONFIGURED}`);
});

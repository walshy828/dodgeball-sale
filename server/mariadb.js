// mariadb.js
import { pool } from "./db.js";
import crypto from 'crypto';

// In-memory admin token store (token -> expiry timestamp ms)
const adminTokens = new Map();
const ADMIN_TOKEN_TTL = 1000 * 60 * 30; // 30 minutes

export async function submitOrder(orderData) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1️⃣ Lock and update counter
    const [counterRow] = await conn.query(
      "SELECT count FROM meta WHERE id = 'counter' FOR UPDATE"
    );
    const current = counterRow[0].count;
    const newCount = current + 1;
    const newOrderId = newCount.toString().padStart(4, "0");

    await conn.query("UPDATE meta SET count = ? WHERE id = 'counter'", [newCount]);

    // 2️⃣ Insert new order
    const status = orderData.paymentType === "Venmo" ? "pending" : "paid";
    await conn.query(
      "INSERT INTO orders (orderId, totalAmount, paymentType, status) VALUES (?, ?, ?, ?)",
      [newOrderId, orderData.totalAmount, orderData.paymentType, status]
    );

    // 3️⃣ Insert each item into transactions
    const txPromises = orderData.items.map((item) =>
      conn.query(
        "INSERT INTO transactions (orderId, item, quantity, total) VALUES (?, ?, ?, ?)",
        [newOrderId, item.name, item.qty, item.price * item.qty]
      )
    );
    await Promise.all(txPromises);

    await conn.commit();
    return { ...orderData, orderId: newOrderId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function getOrders() {
  const [rows] = await pool.query(`
    SELECT 
      o.orderId,
      o.totalAmount,
      o.paymentType,
      o.status,
      o.timestamp,
      t.item,
      t.quantity,
      t.total AS itemTotal
    FROM orders o
    LEFT JOIN transactions t ON o.orderId = t.orderId
    ORDER BY o.id DESC, t.id ASC
  `);

  // Group items by orderId
  const ordersMap = new Map();
  for (const row of rows) {
    if (!ordersMap.has(row.orderId)) {
      ordersMap.set(row.orderId, {
        orderId: row.orderId,
        // Convert DECIMAL (returned as string) to number for client usage
        totalAmount: row.totalAmount != null ? parseFloat(row.totalAmount) : 0,
        paymentType: row.paymentType,
        status: row.status,
        timestamp: row.timestamp,
        items: [],
      });
    }

    if (row.item) {
      ordersMap.get(row.orderId).items.push({
        name: row.item,
        qty: row.quantity,
        total: row.itemTotal != null ? parseFloat(row.itemTotal) : 0,
      });
    }
  }

  return Array.from(ordersMap.values());
}

// ----------------------
// Items (CRUD)
// ----------------------
export async function getItems() {
  const [rows] = await pool.query(`SELECT id, tab, category, name, dataName, price, color, orderIndex FROM items ORDER BY tab, category, orderIndex`);
  return rows.map(r => ({ ...r, price: r.price != null ? parseFloat(r.price) : 0 }));
}

export function validateItemFields(item) {
  const errs = [];
  if (!item) {
    errs.push('Missing item payload');
    return errs;
  }
  const { tab, category, name, dataName, price } = item;
  if (!tab || (tab !== 'raffles' && tab !== 'concessions')) errs.push("'tab' is required and must be 'raffles' or 'concessions'");
  if (!category || typeof category !== 'string' || category.trim().length === 0) errs.push("'category' is required");
  if (!name || typeof name !== 'string' || name.trim().length === 0) errs.push("'name' is required");
  if (!dataName || typeof dataName !== 'string' || dataName.trim().length === 0) errs.push("'dataName' is required");
  const p = Number(price);
  if (Number.isNaN(p) || p < 0) errs.push("'price' must be a non-negative number");
  return errs;
}

export async function createItem(item) {
  const { tab, category, name, dataName, price, color, orderIndex } = item;
  const [res] = await pool.query(`INSERT INTO items (tab, category, name, dataName, price, color, orderIndex) VALUES (?, ?, ?, ?, ?, ?, ?)`, [tab, category, name, dataName, price || 0, color || 'gray-600', orderIndex || 0]);
  return { id: res.insertId, tab, category, name, dataName, price: Number(price || 0), color, orderIndex };
}

export async function updateItem(id, item) {
  const { tab, category, name, dataName, price, color, orderIndex } = item;
  await pool.query(`UPDATE items SET tab=?, category=?, name=?, dataName=?, price=?, color=?, orderIndex=? WHERE id=?`, [tab, category, name, dataName, price || 0, color || 'gray-600', orderIndex || 0, id]);
  return { id, tab, category, name, dataName, price: Number(price || 0), color, orderIndex };
}

export async function deleteItem(id) {
  await pool.query(`DELETE FROM items WHERE id = ?`, [id]);
  return { id };
}

// ----------------------
// Admin auth (simple password+salt)
// ----------------------
export async function validateAdminPassword(password) {
  // read admin_hash and admin_salt from meta_text
  try {
    const adminHashRow = await pool.query(`SELECT value FROM meta_text WHERE id = 'admin_hash'`).then(r => r[0]);
    const adminSaltRow = await pool.query(`SELECT value FROM meta_text WHERE id = 'admin_salt'`).then(r => r[0]);
    const storedHash = adminHashRow && adminHashRow[0] ? adminHashRow[0].value : null;
    const storedSalt = adminSaltRow && adminSaltRow[0] ? adminSaltRow[0].value : null;
    if (!storedHash || !storedSalt) return false;
  const derived = crypto.pbkdf2Sync(password, storedSalt, 100000, 64, 'sha512').toString('hex');
  // constant time comparison
  return crypto.timingSafeEqual(Buffer.from(derived,'hex'), Buffer.from(storedHash,'hex'));
  } catch (err) {
    // meta_text table missing or other DB error
    console.error('Admin password validation error:', err.message);
    return false;
  }
}

export function createAdminToken() {
  const token = crypto.randomBytes(24).toString('hex');
  const expiry = Date.now() + ADMIN_TOKEN_TTL;
  adminTokens.set(token, expiry);
  return token;
}

export function validateAdminToken(token) {
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { adminTokens.delete(token); return false; }
  // extend TTL on use
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL);
  return true;
}

export function revokeAdminToken(token) {
  if (!token) return false;
  return adminTokens.delete(token);
}

// Check whether admin credentials have been configured (meta_text.admin_hash exists)
export async function isAdminConfigured() {
  try {
    const [rows] = await pool.query(`SELECT value FROM meta_text WHERE id = 'admin_hash'`);
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    // meta_text may not exist yet; treat as not configured
    return false;
  }
}

// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { submitOrder, getOrders, getItems, createItem, updateItem, deleteItem, validateAdminPassword, createAdminToken, validateAdminToken, revokeAdminToken, validateItemFields, isAdminConfigured } from "./mariadb.js";
import { initializeDatabase, pool } from "./db.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ✅ Health check route
app.get("/api/health", async (_req, res) => {
  try {
    // Ping the database to confirm connectivity
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();

    res.json({
      status: "ok",
      service: "tournament-pos",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Health check failed:", err);
    res.status(500).json({
      status: "error",
      database: "unreachable",
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

async function startServer() {
  try {
    await initializeDatabase();

    // 🧾 Order routes
    app.post("/api/orders", async (req, res) => {
      try {
        const result = await submitOrder(req.body);
        res.json(result);
      } catch (err) {
        console.error("Submit order failed:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/orders", async (_req, res) => {
      try {
        const orders = await getOrders();
        res.json(orders);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Public items endpoint used by the frontend to render menus
    app.get('/api/items', async (_req, res) => {
      try {
        const items = await getItems();
        res.json(items);
      } catch (err) {
        console.error('Failed to get items:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Simple rate-limited admin login: sets an httpOnly cookie on success
    const loginAttempts = new Map();
    const MAX_ATTEMPTS = 5;
    const ATTEMPT_WINDOW_MS = 1000 * 60 * 10; // 10 minutes
    const LOCK_TIME_MS = 1000 * 60 * 15; // 15 minutes

    app.post('/api/admin/login', async (req, res) => {
      try {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        const record = loginAttempts.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };

        // if locked
        if (record.lockedUntil && now < record.lockedUntil) {
          return res.status(429).json({ error: 'Too many attempts. Try again later.' });
        }

        const { password } = req.body || {};
        if (!password) return res.status(400).json({ error: 'Missing password' });
        const ok = await validateAdminPassword(password);
        if (!ok) {
          // update attempts
          if (now - record.firstAt > ATTEMPT_WINDOW_MS) {
            record.count = 1;
            record.firstAt = now;
          } else {
            record.count = (record.count || 0) + 1;
          }
          if (record.count >= MAX_ATTEMPTS) {
            record.lockedUntil = now + LOCK_TIME_MS;
          }
          loginAttempts.set(ip, record);
          return res.status(401).json({ error: 'Invalid password' });
        }

        // success -> clear attempts for this IP
        loginAttempts.delete(ip);
        const token = createAdminToken();
        const cookieOptions = {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge: 1000 * 60 * 60, // 1 hour
        };
        res.cookie('admin_token', token, cookieOptions);
        res.json({ ok: true });
      } catch (err) {
        console.error('Admin login failed:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Helper to extract admin token from Authorization header or cookie
    function tokenFromReq(req) {
      const auth = req.headers.authorization || '';
      const parts = auth.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') return parts[1];
      const cookieHeader = req.headers.cookie || '';
      const match = cookieHeader.match(/(^|; )admin_token=([^;]+)/);
      if (match) return match[2];
      return null;
    }

    // Middleware to protect admin routes (reads token from cookie or header)
    async function requireAdmin(req, res, next) {
      try {
        // Allow unauthenticated admin for local development when explicitly enabled
        if (process.env.ALLOW_UNAUTH_ADMIN === 'true') return next();

        // If admin is not configured (no admin password set), allow access for local/dev convenience
        const configured = await isAdminConfigured();
        if (!configured) return next();

        const token = tokenFromReq(req);
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        if (!validateAdminToken(token)) return res.status(401).json({ error: 'Invalid or expired token' });
        next();
      } catch (err) {
        console.error('requireAdmin error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    }

    // admin logout - clears cookie and revokes token server-side
    app.post('/api/admin/logout', (req, res) => {
      try {
        const token = tokenFromReq(req);
        if (token) revokeAdminToken(token);
        res.clearCookie('admin_token');
        res.json({ ok: true });
      } catch (err) {
        console.error('Logout failed:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Admin CRUD for items
    app.post('/api/admin/items', requireAdmin, async (req, res) => {
      try {
        const errs = validateItemFields(req.body);
        if (errs && errs.length) return res.status(400).json({ error: 'validation', details: errs });
        const item = await createItem(req.body);
        res.json(item);
      } catch (err) {
        console.error('Create item failed:', err);
        res.status(500).json({ error: err.message });
      }
    });

    app.put('/api/admin/items/:id', requireAdmin, async (req, res) => {
      try {
        const errs = validateItemFields(req.body);
        if (errs && errs.length) return res.status(400).json({ error: 'validation', details: errs });
        const id = Number(req.params.id);
        const item = await updateItem(id, req.body);
        res.json(item);
      } catch (err) {
        console.error('Update item failed:', err);
        res.status(500).json({ error: err.message });
      }
    });

    app.delete('/api/admin/items/:id', requireAdmin, async (req, res) => {
      try {
        const id = Number(req.params.id);
        const result = await deleteItem(id);
        res.json(result);
      } catch (err) {
        console.error('Delete item failed:', err);
        res.status(500).json({ error: err.message });
      }
    });

    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (err) {
    console.error("🚫 Server startup aborted due to database error.");
    process.exit(1);
  }
}

startServer();

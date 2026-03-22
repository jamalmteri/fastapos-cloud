// ============================================================
// FASTAPOS CLOUD SERVER
// Inapokea sync data kutoka migahawa
// Owner anaona dashboard yake kutoka popote
// ============================================================

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { Pool } = require("pg");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "fastapos-cloud-secret-2026";

// ── Database ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Init DB tables ────────────────────────────────────────────
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id          SERIAL PRIMARY KEY,
      tenant_id   VARCHAR(50) UNIQUE NOT NULL,
      name        VARCHAR(100) NOT NULL,
      email       VARCHAR(100) UNIQUE NOT NULL,
      password    VARCHAR(200) NOT NULL,
      api_key     VARCHAR(100) UNIQUE NOT NULL,
      plan        VARCHAR(20) DEFAULT 'basic',
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sync_data (
      id          SERIAL PRIMARY KEY,
      tenant_id   VARCHAR(50) NOT NULL,
      date        DATE NOT NULL,
      data        JSONB NOT NULL,
      synced_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(tenant_id, date)
    );

    CREATE TABLE IF NOT EXISTS sync_history (
      id          SERIAL PRIMARY KEY,
      tenant_id   VARCHAR(50) NOT NULL,
      synced_at   TIMESTAMP DEFAULT NOW(),
      data        JSONB
    );
  `);
  console.log("✅ Database tables ready");

  // Ongeza demo tenant kama haipo
  const exists = await pool.query("SELECT id FROM tenants WHERE tenant_id = 'demo'");
  if (exists.rows.length === 0) {
    const hashed = await bcrypt.hash("demo1234", 10);
    await pool.query(`
      INSERT INTO tenants (tenant_id, name, email, password, api_key, plan)
      VALUES ('demo', 'Demo Restaurant', 'demo@fastapos.co.tz', $1, 'sk-demo-key-123', 'hotel')
    `, [hashed]);
    console.log("✅ Demo tenant created: demo@fastapos.co.tz / demo1234");
  }
};

// ── Auth middleware ───────────────────────────────────────────
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ ok: false, message: "Token inahitajika" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.tenant = decoded;
    next();
  } catch {
    return res.status(401).json({ ok: false, message: "Token batili" });
  }
};

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "FastaPos Cloud API", version: "1.0.0" });
});

// ── POST /api/sync — kutoka local backend ────────────────────
app.post("/api/sync", async (req, res) => {
  try {
    const { tenantId, apiKey, data } = req.body;
    if (!tenantId || !apiKey || !data) {
      return res.status(400).json({ ok: false, message: "tenantId, apiKey, data zinahitajika" });
    }

    // Thibitisha api_key
    const tenant = await pool.query(
      "SELECT * FROM tenants WHERE tenant_id = $1 AND api_key = $2 AND is_active = true",
      [tenantId, apiKey]
    );
    if (tenant.rows.length === 0) {
      return res.status(401).json({ ok: false, message: "API key batili" });
    }

    const today = new Date().toISOString().slice(0, 10);

    // Upsert data ya leo
    await pool.query(`
      INSERT INTO sync_data (tenant_id, date, data, synced_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tenant_id, date)
      DO UPDATE SET data = $3, synced_at = NOW()
    `, [tenantId, today, JSON.stringify(data)]);

    // Historia (last 100)
    await pool.query(`
      INSERT INTO sync_history (tenant_id, data, synced_at)
      VALUES ($1, $2, NOW())
    `, [tenantId, JSON.stringify({ date: today, summary: data })]);

    // Futa historia ya zamani (zaidi ya 100)
    await pool.query(`
      DELETE FROM sync_history WHERE id NOT IN (
        SELECT id FROM sync_history WHERE tenant_id = $1
        ORDER BY synced_at DESC LIMIT 100
      ) AND tenant_id = $1
    `, [tenantId]);

    return res.json({ ok: true, message: "Data imepokelewa", syncedAt: new Date() });
  } catch (err) {
    console.error("Sync error:", err.message);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ── POST /api/auth/login — Owner anaingia ────────────────────
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, message: "Email na password zinahitajika" });
    }

    const result = await pool.query(
      "SELECT * FROM tenants WHERE email = $1 AND is_active = true",
      [email.toLowerCase()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, message: "Email au password si sahihi" });
    }

    const tenant = result.rows[0];
    const valid  = await bcrypt.compare(password, tenant.password);
    if (!valid) {
      return res.status(401).json({ ok: false, message: "Email au password si sahihi" });
    }

    const token = jwt.sign(
      { tenantId: tenant.tenant_id, name: tenant.name, plan: tenant.plan },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      ok: true,
      token,
      tenant: { id: tenant.tenant_id, name: tenant.name, plan: tenant.plan },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ── GET /api/dashboard — Data ya leo ────────────────────────
app.get("/api/dashboard", authenticate, async (req, res) => {
  try {
    // Ruhusu back-date: ?date=2026-03-20
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    // Thibitisha format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, message: "date format lazima iwe YYYY-MM-DD" });
    }

    const result = await pool.query(
      "SELECT data, synced_at, date FROM sync_data WHERE tenant_id = $1 AND date = $2",
      [req.tenant.tenantId, date]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: true, data: null, date, message: "Hakuna data kwa tarehe hii" });
    }

    return res.json({
      ok:       true,
      data:     result.rows[0].data,
      date:     result.rows[0].date,
      syncedAt: result.rows[0].synced_at,
      isToday:  date === new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ── GET /api/history?days=30 ──────────────────────────────────
app.get("/api/history", authenticate, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const result = await pool.query(`
      SELECT date, data, synced_at
      FROM sync_data
      WHERE tenant_id = $1
        AND date >= NOW() - INTERVAL '${days} days'
      ORDER BY date DESC
    `, [req.tenant.tenantId]);

    return res.json({ ok: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ── GET /api/me — Tenant info ────────────────────────────────
app.get("/api/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT tenant_id, name, email, plan, api_key, created_at FROM tenants WHERE tenant_id = $1",
      [req.tenant.tenantId]
    );
    return res.json({ ok: true, tenant: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ── POST /api/tenants — Ongeza mgahawa mpya (admin) ──────────
app.post("/api/tenants", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, message: "Admin key batili" });
    }

    const { tenantId, name, email, password, plan } = req.body;
    if (!tenantId || !name || !email || !password) {
      return res.status(400).json({ ok: false, message: "Fields zote zinahitajika" });
    }

    const hashed = await bcrypt.hash(password, 10);
    // Generate random API key
    const apiKey = "sk-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    await pool.query(`
      INSERT INTO tenants (tenant_id, name, email, password, api_key, plan)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [tenantId, name, email.toLowerCase(), hashed, apiKey, plan || "basic"]);

    return res.status(201).json({
      ok: true,
      message: "Mgahawa ameongezwa",
      tenant: { tenantId, name, email, apiKey, plan: plan || "basic" },
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ ok: false, message: "Tenant ID au email ipo tayari" });
    }
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
const start = async () => {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`\n🌐 FastaPos Cloud running on port ${PORT}`);
      console.log(`📡 API ready`);
    });
  } catch (err) {
    console.error("❌ Failed to start:", err);
    process.exit(1);
  }
};

start();
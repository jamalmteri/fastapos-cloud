// ============================================================
// FASTAPOS CLOUD SERVER (v6.0 FINAL)
// File: server.js
// Location: ~/Desktop/fastapos-cloud/src/server.js
// ============================================================

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { Pool } = require("pg");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");

const app  = express();
const PORT = process.env.PORT || 5050;
const JWT_SECRET = process.env.JWT_SECRET || "fastapos-cloud-secret-2026";

// ── Database Connection ──────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Lazima kwa Railway/Neon
});

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Database Initialization ───────────────────────────────────
const initDB = async () => {
  try {
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
    console.log("✅ Database tables verified/created");

    // Unda demo tenant kama haipo kwa ajili ya majaribio
    const demoExists = await pool.query("SELECT id FROM tenants WHERE tenant_id = 'demo'");
    if (demoExists.rows.length === 0) {
      const hashed = await bcrypt.hash("demo1234", 10);
      await pool.query(`
        INSERT INTO tenants (tenant_id, name, email, password, api_key, plan)
        VALUES ('demo', 'Demo Restaurant', 'demo@fastapos.co.tz', $1, 'sk-demo-key-123', 'hotel')
      `, [hashed]);
      console.log("✅ Demo tenant created (demo@fastapos.co.tz / demo1234)");
    }
  } catch (err) {
    console.error("❌ Database Init Error:", err.message);
  }
};

// ── Authentication Middleware ────────────────────────────────
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ ok: false, message: "Login inahitajika" });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.tenant = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: "Session imeisha, login tena" });
  }
};

// ── ROUTES ────────────────────────────────────────────────────

// Serve dashboard.html (Iliyo kwenye folder moja na server.js au root)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "running", time: new Date() });
});

// ── 1. SYNC API (Inapokea data kutoka local POS) ───────────────
app.post("/api/sync", async (req, res) => {
  const { tenantId, apiKey, data } = req.body;
  
  try {
    console.log(`📡 Sync Request: ${tenantId} at ${new Date().toISOString()}`);

    if (!tenantId || !apiKey || !data) {
      return res.status(400).json({ ok: false, message: "Data pungufu" });
    }

    // Thibitisha API Key na Tenant
    const tenantResult = await pool.query(
      "SELECT id FROM tenants WHERE tenant_id = $1 AND api_key = $2 AND is_active = true",
      [tenantId, apiKey]
    );

    if (tenantResult.rows.length === 0) {
      console.log(`❌ Unauthorized sync attempt: ${tenantId}`);
      return res.status(401).json({ ok: false, message: "API key au Tenant ID si sahihi" });
    }

    const today = new Date().toISOString().slice(0, 10);

    // A. Upsert data ya leo (Ipo? Update. Haipo? Insert)
    await pool.query(`
      INSERT INTO sync_data (tenant_id, date, data, synced_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tenant_id, date)
      DO UPDATE SET data = $3, synced_at = NOW()
    `, [tenantId, today, JSON.stringify(data)]);

    // B. Rekodi kwenye historia fupi
    await pool.query(`
      INSERT INTO sync_history (tenant_id, data, synced_at)
      VALUES ($1, $2, NOW())
    `, [tenantId, JSON.stringify({ date: today, summary: data })]);

    // C. Safisha historia (Baki na rekodi 100 tu kwa kila tenant)
    await pool.query(`
      DELETE FROM sync_history 
      WHERE tenant_id = $1 AND id NOT IN (
        SELECT id FROM sync_history 
        WHERE tenant_id = $1 
        ORDER BY synced_at DESC LIMIT 100
      )
    `, [tenantId]);

    console.log(`✅ Sync Successful: ${tenantId}`);
    return res.json({ ok: true, message: "Data imesawazishwa", syncedAt: new Date() });

  } catch (err) {
    console.error("❌ Sync Error:", err.message);
    return res.status(500).json({ ok: false, message: "Itilafu kwenye cloud server" });
  }
});

// ── 2. LOGIN API (Kwa ajili ya Owner) ─────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM tenants WHERE email = $1 AND is_active = true",
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, message: "Email haijasajiliwa" });
    }

    const tenant = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, tenant.password);

    if (!isPasswordValid) {
      return res.status(401).json({ ok: false, message: "Password si sahihi" });
    }

    const token = jwt.sign(
      { tenantId: tenant.tenant_id, name: tenant.name, plan: tenant.plan },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    return res.json({
      ok: true,
      token,
      tenant: { id: tenant.tenant_id, name: tenant.name, plan: tenant.plan }
    });
  } catch (err) {
    console.error("Login Error:", err.message);
    return res.status(500).json({ ok: false, message: "Login failed" });
  }
});

// ── 3. DASHBOARD API (Data ya sasa) ──────────────────────────
app.get("/api/dashboard", authenticate, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      "SELECT data, synced_at FROM sync_data WHERE tenant_id = $1 AND date = $2",
      [req.tenant.tenantId, today]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: true, data: null, message: "Hakuna data ya leo bado" });
    }

    return res.json({
      ok: true,
      data: result.rows[0].data,
      syncedAt: result.rows[0].synced_at
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Error fetching dashboard" });
  }
});

// ── 4. HISTORY API (Grafu/Ripoti) ────────────────────────────
app.get("/api/history", authenticate, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const result = await pool.query(`
      SELECT date, data, synced_at
      FROM sync_data
      WHERE tenant_id = $1
        AND date >= NOW() - INTERVAL '${days} days'
      ORDER BY date DESC
    `, [req.tenant.tenantId]);

    return res.json({ ok: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Error fetching history" });
  }
});

// ── 5. ADMIN API (Kuongeza Mgahawa Mpya) ──────────────────────
app.post("/api/tenants", async (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ ok: false, message: "Admin key haitambuliki" });
  }

  const { tenantId, name, email, password, plan } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const apiKey = "sk-" + Math.random().toString(36).slice(2, 15) + Math.random().toString(36).slice(2, 15);

    await pool.query(`
      INSERT INTO tenants (tenant_id, name, email, password, api_key, plan)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [tenantId.toLowerCase(), name, email.toLowerCase(), hashedPassword, apiKey, plan || "basic"]);

    return res.status(201).json({
      ok: true,
      message: "Mgahawa umesajiliwa kikamilifu",
      credentials: { tenantId, apiKey }
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ ok: false, message: "Tenant ID au Email imeshatumika" });
    }
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── SERVER START ──────────────────────────────────────────────
const startServer = async () => {
  await initDB();
  app.listen(PORT, () => {
    console.log(`
    🚀 FastaPos Cloud Server Started
    --------------------------------
    Port:    ${PORT}
    URL:     https://fastapos-cloud-production.up.railway.app
    DB:      Connected
    Time:    ${new Date().toLocaleString()}
    --------------------------------
    `);
  });
};

startServer();
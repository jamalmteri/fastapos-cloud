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

// ══════════════════════════════════════════════════════════════
// LICENSE MANAGEMENT SYSTEM
// ══════════════════════════════════════════════════════════════

// ── Init license tables ───────────────────────────────────────
const initLicenseTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id           SERIAL PRIMARY KEY,
      license_key  VARCHAR(50) UNIQUE NOT NULL,
      tenant_id    VARCHAR(50),
      machine_id   VARCHAR(200),         -- fingerprint ya kompyuta
      plan         VARCHAR(20) DEFAULT 'basic',
      status       VARCHAR(20) DEFAULT 'active', -- active|suspended|expired|cancelled
      valid_from   DATE NOT NULL DEFAULT CURRENT_DATE,
      valid_until  DATE NOT NULL,
      notes        TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      activated_at TIMESTAMP,            -- lini ilianza kutumika
      last_seen_at TIMESTAMP             -- mara ya mwisho ilipochekiwa
    );

    CREATE TABLE IF NOT EXISTS license_events (
      id          SERIAL PRIMARY KEY,
      license_key VARCHAR(50),
      event       VARCHAR(50),   -- activated|renewed|suspended|check_ok|check_fail
      machine_id  VARCHAR(200),
      ip_address  VARCHAR(50),
      notes       TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ License tables ready");
};

// ── Generate license key ──────────────────────────────────────
const generateLicenseKey = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join('');
  return `FASTA-${seg()}-${seg()}-${seg()}`;
};

// ── POST /api/licenses — unda license mpya (admin only) ──────
app.post("/api/licenses", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, message: "Admin key batili" });
    }
    const { tenantId, plan, months = 1, notes } = req.body;
    if (!tenantId) return res.status(400).json({ ok: false, message: "tenantId inahitajika" });

    const licenseKey  = generateLicenseKey();
    const validFrom   = new Date();
    const validUntil  = new Date();
    validUntil.setMonth(validUntil.getMonth() + parseInt(months));

    await pool.query(`
      INSERT INTO licenses (license_key, tenant_id, plan, valid_from, valid_until, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [licenseKey, tenantId, plan || 'basic', validFrom, validUntil, notes || null]);

    return res.status(201).json({
      ok: true,
      license: {
        key:        licenseKey,
        tenantId,
        plan:       plan || 'basic',
        validFrom:  validFrom.toISOString().slice(0,10),
        validUntil: validUntil.toISOString().slice(0,10),
        months,
      }
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, message: "Key ipo tayari" });
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── POST /api/licenses/check — local POS inacheki ────────────
app.post("/api/licenses/check", async (req, res) => {
  try {
    const { licenseKey, machineId, tenantId } = req.body;
    if (!licenseKey) return res.status(400).json({ ok: false, message: "licenseKey inahitajika" });

    const result = await pool.query(
      "SELECT * FROM licenses WHERE license_key = $1",
      [licenseKey]
    );

    if (result.rows.length === 0) {
      await logEvent(licenseKey, 'check_fail', machineId, req.ip, 'Key haikupatikana');
      return res.json({ ok: false, valid: false, reason: "invalid_key", message: "License key si sahihi" });
    }

    const lic = result.rows[0];

    // Angalia status
    if (lic.status === 'suspended') {
      await logEvent(licenseKey, 'check_fail', machineId, req.ip, 'Imesimamishwa');
      return res.json({ ok: false, valid: false, reason: "suspended", message: "License imesimamishwa — wasiliana na msimamizi" });
    }
    if (lic.status === 'cancelled') {
      return res.json({ ok: false, valid: false, reason: "cancelled", message: "License imefutwa" });
    }

    // Angalia tarehe
    const today = new Date(); today.setHours(0,0,0,0);
    const expiry = new Date(lic.valid_until);
    if (expiry < today) {
      await pool.query("UPDATE licenses SET status='expired' WHERE license_key=$1", [licenseKey]);
      await logEvent(licenseKey, 'check_fail', machineId, req.ip, 'Imeisha muda');
      return res.json({
        ok: false, valid: false, reason: "expired",
        message: "Subscription imekwisha",
        expiredAt: lic.valid_until,
      });
    }

    // Angalia machine ID (kuzuia copying)
    if (lic.machine_id && machineId && lic.machine_id !== machineId) {
      await logEvent(licenseKey, 'check_fail', machineId, req.ip, `Machine tofauti: ${machineId}`);
      return res.json({
        ok: false, valid: false, reason: "wrong_machine",
        message: "License hii imefungwa kwenye kompyuta nyingine — wasiliana na msimamizi",
      });
    }

    // Activate — weka machine_id ukifika mara ya kwanza
    if (!lic.machine_id && machineId) {
      await pool.query(
        "UPDATE licenses SET machine_id=$1, activated_at=NOW() WHERE license_key=$2",
        [machineId, licenseKey]
      );
      await logEvent(licenseKey, 'activated', machineId, req.ip, `Tenant: ${tenantId}`);
    }

    // Sasisha last_seen
    await pool.query(
      "UPDATE licenses SET last_seen_at=NOW() WHERE license_key=$1",
      [licenseKey]
    );
    await logEvent(licenseKey, 'check_ok', machineId, req.ip, null);

    const daysLeft = Math.ceil((expiry - today) / (1000*60*60*24));

    return res.json({
      ok: true, valid: true,
      plan:       lic.plan,
      validUntil: lic.valid_until,
      daysLeft,
      warning:    daysLeft <= 7 ? `Subscription inaisha siku ${daysLeft} — fanya upya` : null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/licenses — orodha ya licenses (admin) ───────────
app.get("/api/licenses", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const result = await pool.query(`
      SELECT l.*, t.name as tenant_name
      FROM licenses l
      LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
      ORDER BY l.created_at DESC
    `);
    return res.json({ ok: true, licenses: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, message: err.message }); }
});

// ── PATCH /api/licenses/:key — renew au suspend ──────────────
app.patch("/api/licenses/:key", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const { key } = req.params;
    const { months, status, resetMachine } = req.body;

    if (months) {
      // Renew — ongeza miezi
      await pool.query(`
        UPDATE licenses SET
          valid_until = GREATEST(valid_until, CURRENT_DATE) + INTERVAL '${parseInt(months)} months',
          status = 'active'
        WHERE license_key = $1
      `, [key]);
      await logEvent(key, 'renewed', null, null, `+${months} miezi`);
    }
    if (status) {
      await pool.query("UPDATE licenses SET status=$1 WHERE license_key=$2", [status, key]);
      await logEvent(key, status, null, null, null);
    }
    if (resetMachine) {
      await pool.query("UPDATE licenses SET machine_id=NULL, activated_at=NULL WHERE license_key=$1", [key]);
      await logEvent(key, 'machine_reset', null, null, 'Machine reset na admin');
    }

    const result = await pool.query("SELECT * FROM licenses WHERE license_key=$1", [key]);
    return res.json({ ok: true, license: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, message: err.message }); }
});

const logEvent = async (key, event, machineId, ip, notes) => {
  try {
    await pool.query(
      "INSERT INTO license_events (license_key, event, machine_id, ip_address, notes) VALUES ($1,$2,$3,$4,$5)",
      [key, event, machineId||null, ip||null, notes||null]
    );
  } catch {}
};

// Init license tables
initLicenseTables().catch(console.error);

// ══════════════════════════════════════════════════════════════
// LICENSE ROUTES
// ══════════════════════════════════════════════════════════════
const licenseService = require('./licenses');

// Init license tables on startup
licenseService.initLicensesDB().catch(console.error);

// POST /api/licenses/activate — local server inafanya hii ukiingiza key
app.post('/api/licenses/activate', async (req, res) => {
  try {
    const { key, machineId, machineName } = req.body;
    if (!key || !machineId) {
      return res.status(400).json({ ok: false, error: 'key na machineId zinahitajika' });
    }
    const ipAddress = req.ip || req.connection.remoteAddress;
    const result = await licenseService.activateLicense({ key, machineId, machineName, ipAddress });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/licenses/verify — check ya kila siku
app.post('/api/licenses/verify', async (req, res) => {
  try {
    const { key, machineId } = req.body;
    if (!key || !machineId) {
      return res.status(400).json({ ok: false, error: 'key na machineId zinahitajika' });
    }
    const result = await licenseService.verifyLicense({ key, machineId });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/licenses — Jamal anaona zote (ADMIN_KEY required)
app.get('/api/licenses', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: 'Admin key inahitajika' });
    }
    const licenses = await licenseService.getAllLicenses();
    return res.json({ ok: true, licenses });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/licenses/create — Jamal anaunda license mpya
app.post('/api/licenses/create', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: 'Admin key inahitajika' });
    }
    const { tenantName, plan, months, tenantId, notes } = req.body;
    if (!tenantName) return res.status(400).json({ ok: false, error: 'tenantName inahitajika' });
    const license = await licenseService.createLicense({ tenantName, plan, months, tenantId, notes });
    return res.status(201).json({ ok: true, license });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/licenses/renew — ongeza muda
app.post('/api/licenses/renew', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: 'Admin key inahitajika' });
    }
    const { key, months } = req.body;
    const result = await licenseService.renewLicense({ key, months });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/licenses/transfer — hamisha license kwenye machine nyingine
app.post('/api/licenses/transfer', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: 'Admin key inahitajika' });
    }
    const { key, newMachineId, newMachineName } = req.body;
    const result = await licenseService.transferLicense({ key, newMachineId, newMachineName });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// LICENSE ROUTES
// ══════════════════════════════════════════════════════════════
const licenseService = require('./licenses');

// Init license DB on startup
licenseService.initLicenseDB().catch(console.error);

// ── POST /api/licenses/verify — Local mfumo unacheki ─────────
app.post('/api/licenses/verify', async (req, res) => {
  try {
    const { key, machineId } = req.body;
    if (!key || !machineId) {
      return res.status(400).json({ ok: false, message: 'key na machineId zinahitajika' });
    }
    const result = await licenseService.verifyLicense(key.trim().toUpperCase(), machineId);
    return res.json({ ok: result.valid, ...result });
  } catch (err) {
    console.error('License verify error:', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// ── POST /api/licenses/create — Jamal anaunda license ────────
app.post('/api/licenses/create', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, message: 'Admin key batili' });
    }
    const { tenantName, plan, months, notes } = req.body;
    if (!tenantName) return res.status(400).json({ ok: false, message: 'tenantName inahitajika' });
    const license = await licenseService.createLicense({ tenantName, plan, months, notes });
    return res.status(201).json({ ok: true, license });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/licenses — Angalia zote ─────────────────────────
app.get('/api/licenses', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, message: 'Admin key batili' });
    }
    const licenses = await licenseService.listLicenses();
    return res.json({ ok: true, licenses });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── POST /api/licenses/extend — Ongeza muda ──────────────────
app.post('/api/licenses/extend', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, message: 'Admin key batili' });
    }
    const { key, months } = req.body;
    const license = await licenseService.extendLicense(key, months || 1);
    return res.json({ ok: true, license });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── POST /api/licenses/deactivate — Zima license ─────────────
app.post('/api/licenses/deactivate', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, message: 'Admin key batili' });
    }
    await licenseService.deactivateLicense(req.body.key);
    return res.json({ ok: true, message: 'License imezimwa' });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});
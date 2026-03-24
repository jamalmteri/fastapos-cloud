// ============================================================
// LICENSE SERVICE — FastaPos Cloud
// Inasimamia licenses za wateja
// ============================================================

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Init license table ────────────────────────────────────────
const initLicenseDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id            SERIAL PRIMARY KEY,
      key           VARCHAR(32) UNIQUE NOT NULL,
      tenant_name   VARCHAR(100) NOT NULL,
      plan          VARCHAR(20) DEFAULT 'restaurant',
      created_at    TIMESTAMP DEFAULT NOW(),
      expires_at    TIMESTAMP NOT NULL,
      activated_at  TIMESTAMP,
      machine_id    VARCHAR(200),
      is_active     BOOLEAN DEFAULT true,
      notes         TEXT
    );
  `);
  console.log('✅ License table ready');
};

// ── Generate license key: FASTA-XXXX-XXXX-XXXX ───────────────
const generateKey = () => {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `FASTA-${seg()}${seg()}-${seg()}${seg()}-${seg()}${seg()}`;
};

// ── Create license ────────────────────────────────────────────
const createLicense = async ({ tenantName, plan, months, notes }) => {
  const key = generateKey();
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + (parseInt(months) || 1));

  const result = await pool.query(`
    INSERT INTO licenses (key, tenant_name, plan, expires_at, notes)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [key, tenantName, plan || 'restaurant', expiresAt, notes || null]);

  return result.rows[0];
};

// ── Verify/Activate license ───────────────────────────────────
const verifyLicense = async (key, machineId) => {
  const result = await pool.query(
    'SELECT * FROM licenses WHERE key = $1',
    [key]
  );

  if (result.rows.length === 0) {
    return { valid: false, reason: 'KEY_NOT_FOUND', message: 'License key haikupatikana' };
  }

  const license = result.rows[0];

  if (!license.is_active) {
    return { valid: false, reason: 'DEACTIVATED', message: 'License hii imezimwa' };
  }

  if (new Date() > new Date(license.expires_at)) {
    return { valid: false, reason: 'EXPIRED', message: 'License imekwisha', expiredAt: license.expires_at };
  }

  // Kama bado haijafunganishwa na machine — fungisha
  if (!license.machine_id) {
    await pool.query(
      'UPDATE licenses SET machine_id = $1, activated_at = NOW() WHERE key = $2',
      [machineId, key]
    );
  } else if (license.machine_id !== machineId) {
    // Machine nyingine — ruhusu kama ni machine ID inayofanana kwa kiasi
    // (kuzuia hali ya update ya OS inabadilisha machine ID kidogo)
    const similarity = stringSimilarity(license.machine_id, machineId);
    if (similarity < 0.7) {
      return { valid: false, reason: 'MACHINE_MISMATCH', message: 'License imefungwa kwa kompyuta nyingine. Wasiliana na msimamizi.' };
    }
    // Sasisha machine ID kama imebadilika kidogo (OS update, nk)
    await pool.query('UPDATE licenses SET machine_id = $1 WHERE key = $2', [machineId, key]);
  }

  const daysLeft = Math.ceil((new Date(license.expires_at) - new Date()) / (1000 * 60 * 60 * 24));

  return {
    valid:       true,
    key:         license.key,
    tenantName:  license.tenant_name,
    plan:        license.plan,
    expiresAt:   license.expires_at,
    daysLeft,
    warning:     daysLeft <= 7,
    warningMsg:  daysLeft <= 7 ? `⚠️ License inakwisha siku ${daysLeft} — wasiliana na msimamizi` : null,
  };
};

// ── Simple string similarity (Hamming-like) ───────────────────
const stringSimilarity = (a, b) => {
  if (!a || !b) return 0;
  const longer  = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  const matches = [...shorter].filter((c, i) => c === longer[i]).length;
  return matches / longer.length;
};

// ── List all licenses ─────────────────────────────────────────
const listLicenses = async () => {
  const result = await pool.query(
    'SELECT * FROM licenses ORDER BY created_at DESC'
  );
  return result.rows;
};

// ── Deactivate license ────────────────────────────────────────
const deactivateLicense = async (key) => {
  await pool.query('UPDATE licenses SET is_active = false WHERE key = $1', [key]);
};

// ── Extend license ────────────────────────────────────────────
const extendLicense = async (key, months) => {
  await pool.query(`
    UPDATE licenses
    SET expires_at = GREATEST(expires_at, NOW()) + INTERVAL '${parseInt(months)} months'
    WHERE key = $1
  `, [key]);
  const r = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
  return r.rows[0];
};

module.exports = { initLicenseDB, createLicense, verifyLicense, listLicenses, deactivateLicense, extendLicense };
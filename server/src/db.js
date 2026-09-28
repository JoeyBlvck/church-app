import { DatabaseSync } from 'node:sqlite';

// SQLite for dev/small deployments. The schema is deliberately simple
// (tenant-scoped generic record store) so it ports to Postgres unchanged.
export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'trial',
      seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      -- SMS (Arkesel) config: kept only here, server-side — never synced down to client devices
      -- via the generic records/settings collection, since any signed-in staff device could
      -- then read the API key straight out of its local IndexedDB store.
      sms_api_key TEXT, sms_sender_id TEXT,
      -- Paystack config, same reasoning as SMS above: the secret key must never reach a
      -- client device. Each church connects its OWN Paystack account (its own test/live keys),
      -- so giving money lands directly in that church's account — this app never holds or
      -- moves the funds itself. The public key is safe to hand to the (unauthenticated) giving
      -- page, since Paystack's own inline checkout is designed to run with it client-side.
      paystack_secret_key TEXT, paystack_public_key TEXT,
      -- WhatsApp Business API config, same reasoning again: the access token must never reach a
      -- client device. Each church connects its own WhatsApp Business API access (a phone number
      -- ID + access token, from Meta directly or through a BSP such as Arkesel) — see
      -- server/src/whatsapp.js. whatsapp_base_url overrides the default Meta Graph API host, for
      -- a BSP that proxies the same request shape at its own address. whatsapp_template_name/lang
      -- is the one pre-approved single-variable template ("{{1}}") a broadcast notice is sent
      -- through; whatsapp_checkin_service names the attendance record a WhatsApp "IN" reply is
      -- filed under when today doesn't have one yet (server/src/app.js's POST /whatsapp/webhook).
      whatsapp_phone_number_id TEXT, whatsapp_access_token TEXT, whatsapp_base_url TEXT,
      whatsapp_template_name TEXT, whatsapp_template_lang TEXT, whatsapp_checkin_service TEXT,
      -- QR self-check-in (server/src/app.js's GET/POST /checkin): unlike SMS/Paystack/WhatsApp
      -- above, this needs no third-party account at all — the QR code just encodes a link to this
      -- church's own public check-in page (app/checkin.html?t=<tenantId>) — so the only setting is
      -- what to call the attendance record it creates. Falls back to whatsapp_checkin_service, then
      -- "Sunday service", so a church that already set one up for WhatsApp doesn't have to repeat
      -- themselves (see recordSelfCheckIn in app.js).
      qr_checkin_service TEXT
    );
    -- One row per attempted online gift, created (status 'pending') the moment the public giving
    -- page asks Paystack to start a checkout, before we know whether it will succeed. Looked up
    -- by its own id (used as the Paystack transaction reference) from both the browser's
    -- post-checkout redirect and Paystack's webhook, neither of which is an authenticated church
    -- user — so this stays a dedicated table rather than a tenant-scoped "records" row, which
    -- only ever exists behind a signed-in device's own sync.
    CREATE TABLE IF NOT EXISTS giving_intents (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'GHS',
      purpose TEXT NOT NULL, ministry_id TEXT, fund_id TEXT,
      donor_name TEXT, donor_email TEXT, donor_phone TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
      tx_id TEXT, created_at INTEGER NOT NULL, paid_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS giving_intents_tenant ON giving_intents(tenant_id);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pass_hash TEXT NOT NULL,
      role TEXT NOT NULL,              -- owner|admin|treasurer|secretary|leader
      ministry_ids TEXT NOT NULL DEFAULT '[]', -- for leaders
      active INTEGER NOT NULL DEFAULT 1,
      photo TEXT                       -- self-service profile picture, a compressed data URI (see ui.js compressImage) — set via POST /auth/update-profile
    );
    -- The SaaS operator's own login(s) — deliberately separate from every church's own
    -- "tenants"/"users" tables and never reachable from the regular app's sign-in screen: a
    -- platform admin can see and edit basic info for every church, but has no elevated access
    -- inside any one church's own data (members/finance/attendance stay scoped to that church's
    -- own accounts). There is no public sign-up for this table — see server/src/platformAdmin.js.
    CREATE TABLE IF NOT EXISTS platform_admins (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      tenant_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
      data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL, ministry_id TEXT,
      PRIMARY KEY (tenant_id, collection, id)
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records(tenant_id, seq);
  `);
  // CREATE TABLE IF NOT EXISTS is a no-op against a `church.db` file created before a column
  // existed (e.g. sms_api_key/sms_sender_id, added after some dev/pilot databases were already
  // on disk) — so add any column an older file is missing rather than erroring on startup.
  migrateColumns(db, 'tenants', { sms_api_key: 'TEXT', sms_sender_id: 'TEXT', paystack_secret_key: 'TEXT', paystack_public_key: 'TEXT',
    whatsapp_phone_number_id: 'TEXT', whatsapp_access_token: 'TEXT', whatsapp_base_url: 'TEXT',
    whatsapp_template_name: 'TEXT', whatsapp_template_lang: 'TEXT', whatsapp_checkin_service: 'TEXT',
    qr_checkin_service: 'TEXT' });
  migrateColumns(db, 'users', { photo: 'TEXT' });
  return db;
}

function migrateColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

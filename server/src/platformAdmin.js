import { randomUUID } from 'node:crypto';
import { hashPassword } from './auth.js';

// Seeds (or updates) the platform admin account from env vars at server startup — there is no
// public sign-up for this table (see server/src/db.js's `platform_admins`): it's the SaaS
// operator's own login, kept entirely separate from any church's tenants/users. Re-running this
// on every restart keeps the password in sync with whatever env var is currently set, so
// rotating it is just changing SUPER_ADMIN_PASSWORD and restarting — no extra "change password"
// flow needed for a single operator account.
export function ensureSuperAdmin(db, email, password, name = 'Super Admin') {
  if (!email || !password) return; // not configured — the admin console simply has no login yet
  if (password.length < 8) throw new Error('SUPER_ADMIN_PASSWORD must be 8+ characters');
  const lower = email.toLowerCase();
  const existing = db.prepare('SELECT id FROM platform_admins WHERE email = ?').get(lower);
  const id = existing?.id ?? randomUUID();
  db.prepare(`INSERT INTO platform_admins (id, email, name, pass_hash, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET pass_hash = excluded.pass_hash, name = excluded.name`)
    .run(id, lower, name, hashPassword(password), Date.now());
}

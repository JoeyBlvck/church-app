import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureSuperAdmin } from './platformAdmin.js';
import { createBackupManager } from './backup.js';

const secret = process.env.JWT_SECRET;
if (!secret && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET required');
const db = openDb(process.env.DB_PATH ?? './church.db');
// The platform admin console (app/admin.html) has no sign-up screen — set SUPER_ADMIN_EMAIL and
// SUPER_ADMIN_PASSWORD to seed (or update) the one operator login; leave them unset and the
// console simply has no login yet.
ensureSuperAdmin(db, process.env.SUPER_ADMIN_EMAIL, process.env.SUPER_ADMIN_PASSWORD, process.env.SUPER_ADMIN_NAME);
// The public URL of the hosted app (not this server) — e.g. https://<app>.up.railway.app — so a
// password-reset email (server/src/email.js) can link back to a page that actually exists. Leave
// it unset and "forgot password" requests still succeed (never revealing whether an email has an
// account either way — see the route's own note), they just log an error instead of emailing a
// link, same as leaving BREVO_API_KEY/EMAIL_FROM unset does.
const appUrl = process.env.APP_URL ?? '';
if (!appUrl) console.warn('APP_URL is not set — "forgot password" emails will not be sent (see server/src/email.js).');
const port = Number(process.env.PORT ?? 8787);
// Offline ("one PC") edition: started by local.js with LOCAL_EDITION=1. It only listens on this
// computer itself (so Windows never asks about the firewall and nothing else on the church WiFi can
// reach the data), and keeps dated backups -- see backup.js.
const localEdition = process.env.LOCAL_EDITION === '1';
let backup = null;
if (localEdition) {
  const dataDir = process.env.DATA_DIR;
  const dbPath = process.env.DB_PATH;
  if (!dataDir || !dbPath || !process.env.BACKUP_DIR) throw new Error('LOCAL_EDITION needs DATA_DIR, DB_PATH and BACKUP_DIR');
  backup = createBackupManager({ db, dbPath, dataDir, defaultDir: process.env.BACKUP_DIR });
  backup.start();
}
createApp(db, { secret: secret ?? 'dev-secret-change-me', appUrl, backup, localEdition })
  .listen(port, localEdition ? '127.0.0.1' : undefined, () => console.log(`church server on :${port}${localEdition ? ' (this computer only)' : ''}`));

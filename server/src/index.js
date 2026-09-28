import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureSuperAdmin } from './platformAdmin.js';

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
createApp(db, { secret: secret ?? 'dev-secret-change-me', appUrl }).listen(port, () =>
  console.log(`church server on :${port}`));

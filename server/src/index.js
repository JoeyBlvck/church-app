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
const port = Number(process.env.PORT ?? 8787);
createApp(db, { secret: secret ?? 'dev-secret-change-me' }).listen(port, () =>
  console.log(`church server on :${port}`));

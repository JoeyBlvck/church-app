import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';
import { COLLECTIONS, canRead, canWrite, ministryOf } from './permissions.js';
import { normalizeGhanaPhone, sendSms, SmsConfigError } from './sms.js';
import { initializeTransaction, verifyTransaction, verifySignature, PaystackConfigError } from './paystack.js';
import { sendTemplateMessage, sendTextMessage, verifyWebhookChallenge, parseInboundMessage, WhatsAppConfigError } from './whatsapp.js';
import { sendPasswordResetEmail } from './email.js';

const SENDER_ID_RE = /^[A-Za-z0-9 ]{3,11}$/;
const GIVING_PURPOSES = ['tithe', 'offering', 'welfare', 'donation'];
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour — long enough to find the email, short enough that a stale, unused link isn't a standing risk
// One shared secret the whole app checks Meta's webhook-verification handshake against (see
// whatsapp.js's verifyWebhookChallenge) — every church enters this same value when setting up
// their own Meta App's webhook, since the handshake only proves this server owns the endpoint
// and carries no tenant-identifying information either way.
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'dev-whatsapp-verify-token';
const CHECK_IN_KEYWORDS = new Set(['IN', 'HERE', 'PRESENT', 'CHECK IN', 'CHECKIN']);

const ROLES = ['admin', 'treasurer', 'secretary', 'leader'];
const PLANS = ['trial', 'active', 'suspended'];

// Per-route, per-IP request limits — worth having on exactly the routes an attacker would script:
// password guessing (login), signup spam (register-church), and the two unauthenticated public
// routes (checkin, give/init) where the only thing standing between "typo" and "automated
// enumeration" is how fast requests can be fired. /checkin in particular hands back a member's
// name on a match — without a limit here, an attacker could script through phone numbers and use
// the 200-vs-404 response (and the name on a hit) to build a list of who's a member.
const RATE_LIMITED_ROUTES = new Map([
  ['POST /auth/login', { windowMs: 60_000, max: 10 }],
  ['POST /admin/login', { windowMs: 60_000, max: 10 }],
  ['POST /auth/register-church', { windowMs: 60_000, max: 5 }],
  ['POST /checkin', { windowMs: 60_000, max: 20 }],
  ['POST /give/init', { windowMs: 60_000, max: 20 }],
  ['POST /auth/request-password-reset', { windowMs: 60_000, max: 5 }],
  ['POST /auth/reset-password', { windowMs: 60_000, max: 10 }],
]);

export function createApp(db, { secret = 'dev-secret-change-me', appUrl = '', sendPasswordResetEmailImpl } = {}) {
  // In-memory and per-app-instance on purpose: this runs as a single Node process (see
  // server/src/index.js), so there's no shared store to coordinate with — if this is ever scaled
  // to more than one instance, this needs to move to something shared (e.g. Redis) instead, or a
  // login spike on one instance won't be seen by the others. Scoped inside createApp (not module
  // level) so each test's own createApp() call starts with a clean slate rather than sharing state
  // with every other test that happened to run in the same process.
  const rateBuckets = new Map(); // `${ip}:${routeKey}` -> recent request timestamps (ms)
  setInterval(() => { // keeps long-lived memory bounded without needing every request to do it
    const now = Date.now();
    for (const [key, timestamps] of rateBuckets) {
      const fresh = timestamps.filter((t) => now - t < 5 * 60_000); // nothing above has a window longer than this
      if (fresh.length) rateBuckets.set(key, fresh); else rateBuckets.delete(key);
    }
  }, 5 * 60_000).unref();
  function checkRateLimit(ip, routeKey) {
    const rule = RATE_LIMITED_ROUTES.get(routeKey);
    if (!rule) return;
    const key = `${ip}:${routeKey}`;
    const now = Date.now();
    const timestamps = (rateBuckets.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    timestamps.push(now);
    rateBuckets.set(key, timestamps);
    if (timestamps.length > rule.max) throw new HttpError(429, 'Too many attempts — please wait a moment and try again.');
  }
  const clientIp = (req) => (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown').trim();

  const q = {
    tenantByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ? AND active = 1'),
    insTenant: db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?,?,?)'),
    insUser: db.prepare(
      'INSERT INTO users (id, tenant_id, email, name, pass_hash, role, ministry_ids) VALUES (?,?,?,?,?,?,?)'),
    bump: db.prepare('UPDATE tenants SET seq = seq + 1 WHERE id = ? RETURNING seq'),
    rec: db.prepare('SELECT * FROM records WHERE tenant_id = ? AND collection = ? AND id = ?'),
    upsert: db.prepare(`INSERT INTO records (tenant_id, collection, id, data, updated_at, deleted, seq, ministry_id)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, collection, id) DO UPDATE SET
        data=excluded.data, updated_at=excluded.updated_at, deleted=excluded.deleted,
        seq=excluded.seq, ministry_id=excluded.ministry_id`),
    since: db.prepare('SELECT * FROM records WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
    staff: db.prepare('SELECT id,email,name,role,ministry_ids,active FROM users WHERE tenant_id = ?'),
    smsConfig: db.prepare('SELECT sms_api_key, sms_sender_id FROM tenants WHERE id = ?'),
    setSmsConfig: db.prepare('UPDATE tenants SET sms_api_key = ?, sms_sender_id = ? WHERE id = ?'),
    membersOf: db.prepare("SELECT data FROM records WHERE tenant_id = ? AND collection = 'members' AND deleted = 0"),
    // ---- Paystack online giving (server/src/paystack.js) ----
    paystackConfig: db.prepare('SELECT paystack_secret_key, paystack_public_key FROM tenants WHERE id = ?'),
    setPaystackConfig: db.prepare('UPDATE tenants SET paystack_secret_key = ?, paystack_public_key = ? WHERE id = ?'),
    // Public, unauthenticated reads for the giving page (app/give.html) — deliberately narrow:
    // just {id, name}, never a member's own data, and only for the two collections a donor
    // needs to pick from (which ministry, which designated fund).
    publicMinistries: db.prepare("SELECT data FROM records WHERE tenant_id = ? AND collection = 'ministries' AND deleted = 0"),
    publicFunds: db.prepare("SELECT data FROM records WHERE tenant_id = ? AND collection = 'funds' AND deleted = 0"),
    insGivingIntent: db.prepare(`INSERT INTO giving_intents
      (id, tenant_id, amount, currency, purpose, ministry_id, fund_id, donor_name, donor_email, donor_phone, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`),
    givingIntent: db.prepare('SELECT * FROM giving_intents WHERE id = ?'),
    markGivingIntentPaid: db.prepare("UPDATE giving_intents SET status = 'paid', tx_id = ?, paid_at = ? WHERE id = ? AND status != 'paid'"),
    markGivingIntentFailed: db.prepare("UPDATE giving_intents SET status = 'failed' WHERE id = ? AND status = 'pending'"),
    // ---- WhatsApp (server/src/whatsapp.js) ----
    whatsappConfig: db.prepare(`SELECT whatsapp_phone_number_id, whatsapp_access_token, whatsapp_base_url,
      whatsapp_template_name, whatsapp_template_lang, whatsapp_checkin_service FROM tenants WHERE id = ?`),
    setWhatsappConfig: db.prepare(`UPDATE tenants SET whatsapp_phone_number_id = ?, whatsapp_access_token = ?, whatsapp_base_url = ?,
      whatsapp_template_name = ?, whatsapp_template_lang = ?, whatsapp_checkin_service = ? WHERE id = ?`),
    // Inbound webhook routing: Meta's payload names which of a church's WhatsApp phone numbers
    // received the message, not which church — this is how POST /whatsapp/webhook finds the
    // right tenant (and that tenant's own access token to reply with) from it.
    tenantByWhatsappPhoneId: db.prepare('SELECT * FROM tenants WHERE whatsapp_phone_number_id = ?'),
    attendanceOf: db.prepare("SELECT id, data, updated_at FROM records WHERE tenant_id = ? AND collection = 'attendance' AND deleted = 0"),
    // ---- QR self-check-in (server/src/app.js's GET/POST /checkin, app/checkin.html) ----
    qrCheckinConfig: db.prepare('SELECT qr_checkin_service FROM tenants WHERE id = ?'),
    setQrCheckinConfig: db.prepare('UPDATE tenants SET qr_checkin_service = ? WHERE id = ?'),
    // ---- platform admin console (app/admin.html) — separate login, separate table (see
    // server/src/db.js's platform_admins / server/src/platformAdmin.js) ----
    platformAdminByEmail: db.prepare('SELECT * FROM platform_admins WHERE email = ?'),
    platformAdmin: db.prepare('SELECT * FROM platform_admins WHERE id = ?'),
    allTenants: db.prepare('SELECT id, name, plan, created_at FROM tenants ORDER BY created_at DESC'),
    tenantById: db.prepare('SELECT * FROM tenants WHERE id = ?'),
    updateTenant: db.prepare('UPDATE tenants SET name = ?, plan = ? WHERE id = ?'),
    churchProfileRec: db.prepare("SELECT * FROM records WHERE tenant_id = ? AND collection = 'settings' AND id = 'church'"),
    activeStaffCountOf: db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND active = 1'),
    membersCountOf: db.prepare("SELECT COUNT(*) AS n FROM records WHERE tenant_id = ? AND collection = 'members' AND deleted = 0"),
  };

  const toUser = (row) => ({
    id: row.id, tenantId: row.tenant_id, email: row.email, name: row.name,
    role: row.role, ministryIds: JSON.parse(row.ministry_ids), photo: row.photo ?? null,
  });

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  function auth(req) {
    const h = req.headers.authorization ?? '';
    const p = verifyToken(h.replace(/^Bearer /, ''), secret);
    // A platform-admin token (kind: 'platform') is signed with the same secret but must never
    // be usable as a church login — the two ids come from entirely separate tables.
    if (!p || p.kind === 'platform') throw new HttpError(401, 'unauthorized');
    const row = q.user.get(p.sub);
    if (!row) throw new HttpError(401, 'unauthorized');
    // A church the platform admin has suspended (see admin.js) is cut off immediately, not just
    // on its next login — every authenticated call runs through here, including an already
    // signed-in device's own background sync.
    if (q.tenantById.get(row.tenant_id)?.plan === 'suspended') throw new HttpError(403, 'suspended');
    return toUser(row);
  }

  function session(row) {
    const user = toUser(row);
    return { token: signToken({ sub: user.id }, secret), user };
  }

  // The platform admin console's own auth — separate token "kind" so it can never double as a
  // church login (or vice versa), and separate from every church's own users/permissions.
  function authAdmin(req) {
    const h = req.headers.authorization ?? '';
    const p = verifyToken(h.replace(/^Bearer /, ''), secret);
    if (!p || p.kind !== 'platform') throw new HttpError(401, 'unauthorized');
    const row = q.platformAdmin.get(p.sub);
    if (!row) throw new HttpError(401, 'unauthorized');
    return { id: row.id, email: row.email, name: row.name };
  }

  // Turns a Paystack-confirmed payment into an ordinary entry in the same append-only ledger
  // everything else uses (compare finance.js's own `post` helper) — called from both GET
  // /give/status (the donor's own browser, redirected back after checkout) and POST
  // /give/webhook (Paystack's server-to-server confirmation), whichever arrives first. Safe to
  // call twice for the same intent: the `intent.status === 'paid'` check (read fresh by the
  // caller right before this) is what makes it idempotent, since two nearly-simultaneous
  // callers could otherwise each post their own duplicate transaction.
  function finalizeGivingIntent(intent, paystackData) {
    if (intent.status === 'paid' || paystackData.status !== 'success') return;
    const txId = randomUUID();
    const rec = {
      id: txId, type: intent.purpose, amount: intent.amount,
      method: paystackData.channel === 'card' ? 'card' : 'mobile money',
      ministryId: intent.ministry_id ?? undefined, fundId: intent.fund_id ?? undefined,
      date: new Date().toISOString().slice(0, 10), at: Date.now(), recordedBy: 'Online giving',
      note: `Online giving via Paystack — ${intent.donor_name}${intent.donor_phone ? ' · ' + intent.donor_phone : intent.donor_email ? ' · ' + intent.donor_email : ''}`,
      source: 'paystack', paystackReference: intent.id,
    };
    const { seq } = q.bump.get(intent.tenant_id);
    q.upsert.run(intent.tenant_id, 'transactions', txId, JSON.stringify(rec), Date.now(), 0, seq, ministryOf('transactions', rec));
    q.markGivingIntentPaid.run(txId, Date.now(), intent.id);
  }

  // Marks one member present on today's whole-church attendance record — shared by both
  // self-check-in channels (WhatsApp reply, POST /whatsapp/webhook below; and QR scan, POST
  // /checkin below). Folds into whichever whole-church (no ministryId) record for today already
  // exists — e.g. one staff already started from the app — rather than always creating a second
  // one, and is a no-op if that member is already marked, so checking in twice (a replayed
  // WhatsApp message, or scanning the QR code again) never double-counts anyone.
  function recordSelfCheckIn(tenantId, memberId, defaultService) {
    const rows = q.attendanceOf.all(tenantId).map((r) => ({ id: r.id, data: JSON.parse(r.data), updatedAt: r.updated_at }));
    const today = new Date().toISOString().slice(0, 10);
    const existing = rows.filter((r) => r.data.date === today && !r.data.ministryId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const { seq } = q.bump.get(tenantId);
    if (existing) {
      if ((existing.data.presentIds ?? []).includes(memberId)) return false; // already checked in
      const rec = { ...existing.data, presentIds: [...(existing.data.presentIds ?? []), memberId] };
      q.upsert.run(tenantId, 'attendance', existing.id, JSON.stringify(rec), Date.now(), 0, seq, null);
    } else {
      const id = randomUUID();
      const rec = { id, date: today, service: defaultService || 'Sunday service', presentIds: [memberId] };
      q.upsert.run(tenantId, 'attendance', id, JSON.stringify(rec), Date.now(), 0, seq, null);
    }
    return true;
  }

  // ---- routes ----
  const routes = {
    'POST /auth/register-church': (req, body) => {
      const { churchName, name, email, password } = body;
      if (!churchName || !name || !email || !password || password.length < 8)
        throw new HttpError(400, 'churchName, name, email and 8+ char password required');
      if (q.tenantByEmail.get(email.toLowerCase())) throw new HttpError(409, 'email in use');
      const tid = randomUUID(), uid = randomUUID();
      q.insTenant.run(tid, churchName, Date.now());
      q.insUser.run(uid, tid, email.toLowerCase(), name, hashPassword(password), 'owner', '[]');
      return session(q.user.get(uid));
    },

    'POST /auth/login': (req, body) => {
      const row = q.tenantByEmail.get((body.email ?? '').toLowerCase());
      if (!row || !row.active || !verifyPassword(body.password ?? '', row.pass_hash))
        throw new HttpError(401, 'invalid credentials');
      if (q.tenantById.get(row.tenant_id)?.plan === 'suspended')
        throw new HttpError(403, "This church's account has been suspended. Contact your church administrator.");
      return session(row);
    },

    // "Forgot password" — until now, only an owner/admin could reset a colleague's password
    // (POST /users/update below), which left the owner's own account with no recovery path at
    // all if they forgot it. This emails a one-time link instead (server/src/email.js). The
    // reply is identical whether or not the address has an account, and never mentions which —
    // same reasoning as /checkin's own note on this further down: an attacker probing emails one
    // at a time must learn nothing from the response, only ever "ok" either way.
    'POST /auth/request-password-reset': async (req, body) => {
      const email = (body.email ?? '').trim().toLowerCase();
      const row = email && q.tenantByEmail.get(email);
      if (row && row.active) {
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(rawToken).digest('hex');
        db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id); // at most one live link per account
        db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)')
          .run(tokenHash, row.id, Date.now() + RESET_TOKEN_TTL_MS);
        if (!appUrl) {
          console.error('Cannot send password reset email: APP_URL is not set.');
        } else {
          const resetUrl = `${appUrl}/?resetToken=${rawToken}`;
          const send = sendPasswordResetEmailImpl ?? sendPasswordResetEmail;
          // A bad SMTP password or a down mail provider must never change the response below —
          // that would leak whether this address has an account just as surely as an error message
          // naming it outright would.
          try { await send({ to: row.email, name: row.name, resetUrl }); }
          catch (e) { console.error('Could not send password reset email:', e.message); }
        }
      }
      return { ok: true };
    },

    // The other half of the flow above: spends a one-time token for a new password. Deliberately
    // takes no Authorization header at all — arriving in an email sent only to the account's own
    // inbox is what proves it's really that person, the same way a login form's password does.
    'POST /auth/reset-password': (req, body) => {
      const rawToken = body.token ?? '';
      if (!rawToken || (body.password ?? '').length < 8) throw new HttpError(400, 'token and 8+ char password required');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash);
      if (!row || row.used_at || row.expires_at < Date.now())
        throw new HttpError(400, 'This reset link is invalid or has expired — request a new one.');
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(body.password), row.user_id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(Date.now(), tokenHash);
      return { ok: true };
    },

    'GET /users': (req) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      return q.staff.all(u.tenantId).map((r) => ({ ...r, ministry_ids: JSON.parse(r.ministry_ids) }));
    },

    // Admins create staff accounts; a leader is bound to one or more ministries.
    'POST /users': (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'bad role');
      if (body.role === 'leader' && !(body.ministryIds?.length))
        throw new HttpError(400, 'leader needs ministryIds');
      if (!body.email || !body.name || (body.password ?? '').length < 8)
        throw new HttpError(400, 'name, email and 8+ char password required');
      if (q.tenantByEmail.get(body.email.toLowerCase())) throw new HttpError(409, 'email in use');
      const id = randomUUID();
      q.insUser.run(id, u.tenantId, body.email.toLowerCase(), body.name,
        hashPassword(body.password), body.role, JSON.stringify(body.ministryIds ?? []));
      return { id };
    },

    // Admins update a staff account: deactivate, change role/ministries, reset password.
    'POST /users/update': (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const row = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(body.id ?? '', u.tenantId);
      if (!row) throw new HttpError(404, 'no such user');
      if (row.role === 'owner') throw new HttpError(403, 'the owner account cannot be changed here');
      const role = body.role ?? row.role;
      if (!ROLES.includes(role)) throw new HttpError(400, 'bad role');
      const ministryIds = body.ministryIds ?? JSON.parse(row.ministry_ids);
      if (role === 'leader' && !ministryIds.length) throw new HttpError(400, 'leader needs ministryIds');
      if (body.password != null && body.password.length < 8) throw new HttpError(400, '8+ char password required');
      db.prepare('UPDATE users SET role = ?, ministry_ids = ?, active = ?, pass_hash = ? WHERE id = ?').run(
        role, JSON.stringify(role === 'leader' ? ministryIds : []), body.active === false ? 0 : 1,
        body.password ? hashPassword(body.password) : row.pass_hash, row.id);
      return { ok: true };
    },

    'POST /auth/change-password': (req, body) => {
      const u = auth(req);
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      if (!verifyPassword(body.current ?? '', row.pass_hash)) throw new HttpError(401, 'current password is wrong');
      if ((body.next ?? '').length < 8) throw new HttpError(400, '8+ char password required');
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(body.next), u.id);
      return { ok: true };
    },

    // A signed-in user editing their own name/email/photo — distinct from /users/update, which
    // is admin-only and manages OTHER staff accounts (role, ministries, active, password).
    // `photo` is optional and, like the church logo and member photos, arrives pre-compressed
    // by the browser (see ui.js compressImage) — only included when the form actually touched
    // it, so leaving it out here (rather than sending null) keeps whatever photo is on file.
    'POST /auth/update-profile': (req, body) => {
      const u = auth(req);
      const name = (body.name ?? '').trim();
      const email = (body.email ?? '').trim().toLowerCase();
      if (!name || !email) throw new HttpError(400, 'name and email required');
      const clash = q.tenantByEmail.get(email);
      if (clash && clash.id !== u.id) throw new HttpError(409, 'email in use');
      const photo = 'photo' in body ? (body.photo || null) : q.user.get(u.id).photo;
      db.prepare('UPDATE users SET name = ?, email = ?, photo = ? WHERE id = ?').run(name, email, photo, u.id);
      return { user: toUser(q.user.get(u.id)) };
    },

    // Arkesel SMS config — kept in the tenants table, never synced to client devices (unlike
    // the generic records/settings collection, which every device pulls down): a client-side
    // secret would be readable by any staff member's browser devtools.
    'GET /sms/config': (req) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const row = q.smsConfig.get(u.tenantId);
      return { configured: !!(row?.sms_api_key && row?.sms_sender_id), senderId: row?.sms_sender_id ?? null };
    },

    'POST /sms/config': (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const apiKey = (body.apiKey ?? '').trim();
      const senderId = (body.senderId ?? '').trim();
      if (!apiKey && !senderId) { q.setSmsConfig.run(null, null, u.tenantId); return { ok: true, configured: false }; } // clears it
      if (!apiKey || !senderId) throw new HttpError(400, 'API key and sender ID are both required');
      if (!SENDER_ID_RE.test(senderId)) throw new HttpError(400, 'Sender ID must be 3-11 letters/numbers, matching what you registered with Arkesel');
      q.setSmsConfig.run(apiKey, senderId, u.tenantId);
      return { ok: true, configured: true };
    },

    // Sends `message` by SMS to every member with a usable phone number — either the whole
    // church, or just members belonging to one OR MORE ministries (ministryIds), independent of
    // whichever single ministry (if any) the Notices board post itself was addressed to: a
    // church can post one whole-church notice while texting only a couple of ministries about
    // it, or the reverse. Reads member phone numbers straight from this tenant's own records
    // rather than trusting whatever list the client sends up, and de-duplicates numbers so a
    // shared household phone isn't billed/texted twice.
    'POST /sms/send': async (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin', 'secretary'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const message = (body.message ?? '').trim();
      if (!message) throw new HttpError(400, 'message is required');
      const ministryIds = Array.isArray(body.ministryIds) ? body.ministryIds.filter(Boolean) : [];
      const row = q.smsConfig.get(u.tenantId);
      const members = q.membersOf.all(u.tenantId).map((r) => JSON.parse(r.data))
        .filter((m) => !ministryIds.length || (m.ministryIds ?? []).some((id) => ministryIds.includes(id)));
      const phones = members.map((m) => normalizeGhanaPhone(m.phone));
      const recipients = [...new Set(phones.filter(Boolean))]; // de-duped: a shared household phone is only texted once
      const missing = phones.filter((p) => p === null).length; // no phone at all, or not a recognizable Ghanaian number
      if (!recipients.length) return { sent: 0, failed: 0, total: members.length, missing, errors: [] };
      try {
        const result = await sendSms({ apiKey: row?.sms_api_key, senderId: row?.sms_sender_id, recipients, message });
        return { ...result, total: members.length, missing };
      } catch (e) {
        if (e instanceof SmsConfigError) throw new HttpError(400, e.message);
        throw e;
      }
    },

    // ---- WhatsApp (server/src/whatsapp.js): owner/admin connect their church's own WhatsApp
    // Business API access — a phone number ID + access token from Meta directly, or from a BSP
    // such as Arkesel — plus the one pre-approved single-variable template a broadcast is sent
    // through. The access token is never sent back to the client once saved.
    'GET /whatsapp/config': (req) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const row = q.whatsappConfig.get(u.tenantId);
      return {
        configured: !!(row?.whatsapp_phone_number_id && row?.whatsapp_access_token),
        phoneNumberId: row?.whatsapp_phone_number_id ?? null, baseUrl: row?.whatsapp_base_url ?? null,
        templateName: row?.whatsapp_template_name ?? null, templateLang: row?.whatsapp_template_lang ?? null,
        checkinService: row?.whatsapp_checkin_service ?? null,
      };
    },

    'POST /whatsapp/config': (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const phoneNumberId = (body.phoneNumberId ?? '').trim();
      const accessToken = (body.accessToken ?? '').trim();
      if (!phoneNumberId && !accessToken) { q.setWhatsappConfig.run(null, null, null, null, null, null, u.tenantId); return { ok: true, configured: false }; } // clears it
      if (!phoneNumberId || !accessToken) throw new HttpError(400, 'The phone number ID and access token are both required');
      const baseUrl = (body.baseUrl ?? '').trim() || null;
      const templateName = (body.templateName ?? '').trim() || null;
      const templateLang = (body.templateLang ?? '').trim() || 'en_US';
      const checkinService = (body.checkinService ?? '').trim() || null;
      q.setWhatsappConfig.run(phoneNumberId, accessToken, baseUrl, templateName, templateLang, checkinService, u.tenantId);
      return { ok: true, configured: true };
    },

    // Sends a notice as a WhatsApp broadcast — mirrors /sms/send's own recipient selection
    // (whole church, or one or more ministries; shared household numbers de-duped) but one
    // WhatsApp message per recipient rather than one batched API call, since Meta's API has no
    // bulk-send endpoint. Each send is independent, so one recipient's number being wrong (or
    // never having messaged the church's WhatsApp number, if no template is configured) doesn't
    // stop the rest from going out.
    'POST /whatsapp/send': async (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin', 'secretary'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const message = (body.message ?? '').trim();
      if (!message) throw new HttpError(400, 'message is required');
      const ministryIds = Array.isArray(body.ministryIds) ? body.ministryIds.filter(Boolean) : [];
      const row = q.whatsappConfig.get(u.tenantId);
      const members = q.membersOf.all(u.tenantId).map((r) => JSON.parse(r.data))
        .filter((m) => !ministryIds.length || (m.ministryIds ?? []).some((id) => ministryIds.includes(id)));
      const phones = members.map((m) => normalizeGhanaPhone(m.phone));
      const recipients = [...new Set(phones.filter(Boolean))];
      const missing = phones.filter((p) => p === null).length;
      if (!recipients.length) return { sent: 0, failed: 0, total: members.length, missing, errors: [] };
      if (!row?.whatsapp_phone_number_id || !row?.whatsapp_access_token) throw new HttpError(400, 'WhatsApp is not set up for this church yet — connect it under Settings.');
      if (!row?.whatsapp_template_name) throw new HttpError(400, 'No WhatsApp template is set for this church yet — add one under Settings.');
      let sent = 0; const errors = [];
      for (const to of recipients) {
        try {
          await sendTemplateMessage({ baseUrl: row.whatsapp_base_url, phoneNumberId: row.whatsapp_phone_number_id,
            accessToken: row.whatsapp_access_token, to, templateName: row.whatsapp_template_name, templateLang: row.whatsapp_template_lang, bodyText: message });
          sent++;
        } catch (e) { errors.push(e.message || `Could not message ${to}`); }
      }
      return { sent, failed: recipients.length - sent, total: members.length, missing, errors };
    },

    // Meta's one-time webhook-verification handshake (see whatsapp.js's verifyWebhookChallenge) —
    // answered with the raw challenge text, not JSON, hence the { __raw } marker the handler
    // below special-cases.
    'GET /whatsapp/webhook': (req, _b, url) => {
      const challenge = verifyWebhookChallenge({
        mode: url.searchParams.get('hub.mode'), token: url.searchParams.get('hub.verify_token'), challenge: url.searchParams.get('hub.challenge'),
      }, WHATSAPP_VERIFY_TOKEN);
      if (challenge == null) throw new HttpError(403, 'verification failed');
      return { __raw: challenge };
    },

    // An inbound WhatsApp message — either a check-in-by-reply, or anything else (which gets a
    // short auto-reply explaining how to check in). Routed to a tenant by the phone_number_id
    // Meta's payload says received the message (see q.tenantByWhatsappPhoneId), not by anything
    // the sender controls, so this can't be pointed at another church's records by a spoofed
    // payload claiming a different tenant. Always acks 200 quickly — Meta expects that regardless
    // of what (if anything) happened with the message.
    'POST /whatsapp/webhook': async (req, body) => {
      const parsed = parseInboundMessage(body);
      if (!parsed?.phoneNumberId) return { ok: true };
      const t = q.tenantByWhatsappPhoneId.get(parsed.phoneNumberId);
      if (!t) return { ok: true }; // not a number any church here has configured
      const from = parsed.from; // already digits-only international form, e.g. "233244000000"
      const members = q.membersOf.all(t.id).map((r) => JSON.parse(r.data));
      const member = members.find((m) => normalizeGhanaPhone(m.phone) === from);
      const replyTo = { baseUrl: t.whatsapp_base_url, phoneNumberId: t.whatsapp_phone_number_id, accessToken: t.whatsapp_access_token, to: from };
      try {
        if (member && CHECK_IN_KEYWORDS.has(parsed.text.trim().toUpperCase())) {
          const justNow = recordSelfCheckIn(t.id, member.id, t.whatsapp_checkin_service);
          await sendTextMessage({ ...replyTo, text: justNow ? `You're checked in, ${member.name.split(' ')[0]}! 🙏` : "You're already checked in — see you there!" });
        } else if (member) {
          await sendTextMessage({ ...replyTo, text: 'To check yourself in, reply "IN".' });
        } // an unrecognized number gets no reply — nothing to confirm and no way to know who they are
      } catch (e) { console.error('WhatsApp auto-reply failed', e); } // the check-in itself already succeeded either way
      return { ok: true };
    },

    // A bare {id, name} list of every member in the tenant — used only to populate the "add
    // member" picker on a ministry's own detail screen (ministries.js's openMinistry). A leader's
    // normal sync only ever brings down members already in one of their ministries (see
    // permissions.js's leaderCanSee), on purpose — this endpoint lets them browse who else to
    // recruit without handing their device everyone's full profile (phone, email, birthday…)
    // the way a blanket 'members' read would.
    'GET /members/directory': (req) => {
      const u = auth(req);
      if (!['owner', 'admin', 'secretary', 'leader'].includes(u.role)) throw new HttpError(403, 'forbidden');
      return { members: q.membersOf.all(u.tenantId).map((r) => JSON.parse(r.data)).map((m) => ({ id: m.id, name: m.name })) };
    },

    // Add or remove ONE ministry from a member's roster (ministries.js's openMinistry "Add
    // member"/"×" controls) — applied straight to the server's own authoritative record rather
    // than routed through the generic /sync/push whole-record replace: a ministry leader may
    // have no local copy of the member at all yet (see the directory endpoint just above), so a
    // client-submitted "full" record here could only ever be a partial {id, name} stand-in and
    // would silently wipe out everyone's other fields. Permission is exactly canWrite's own
    // roster-only rule (see permissions.js) — a leader may only touch a ministry they lead, and
    // only this one field.
    'POST /members/roster': (req, body) => {
      const u = auth(req);
      const { memberId, ministryId, action } = body ?? {};
      if (!memberId || !ministryId || !['add', 'remove'].includes(action)) throw new HttpError(400, 'memberId, ministryId and action (add/remove) are required');
      const row = q.rec.get(u.tenantId, 'members', memberId);
      if (!row || row.deleted) throw new HttpError(404, 'no such member');
      const existing = JSON.parse(row.data);
      const ids = new Set(existing.ministryIds ?? []);
      if (action === 'add') ids.add(ministryId); else ids.delete(ministryId);
      const rec = { ...existing, ministryIds: [...ids] };
      if (!canWrite(u, 'members', rec, existing)) throw new HttpError(403, 'forbidden');
      const { seq } = q.bump.get(u.tenantId);
      q.upsert.run(u.tenantId, 'members', memberId, JSON.stringify(rec), Date.now(), 0, seq, ministryOf('members', rec));
      return { ok: true, member: rec, seq };
    },

    // ---- Online giving (Paystack): owner/admin connect their church's own Paystack account
    // (its own secret/public key pair — see server/src/paystack.js). The secret key is never
    // sent back to the client once saved, same as the Arkesel SMS key above.
    'GET /paystack/config': (req) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const row = q.paystackConfig.get(u.tenantId);
      return {
        configured: !!(row?.paystack_secret_key && row?.paystack_public_key),
        publicKey: row?.paystack_public_key ?? null,
        testMode: row?.paystack_secret_key ? row.paystack_secret_key.startsWith('sk_test_') : null,
      };
    },

    'POST /paystack/config': (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const secretKey = (body.secretKey ?? '').trim();
      const publicKey = (body.publicKey ?? '').trim();
      if (!secretKey && !publicKey) { q.setPaystackConfig.run(null, null, u.tenantId); return { ok: true, configured: false }; } // clears it
      if (!secretKey || !publicKey) throw new HttpError(400, 'The secret key and public key are both required');
      if (!secretKey.startsWith('sk_') || !publicKey.startsWith('pk_'))
        throw new HttpError(400, 'That doesn\'t look like a Paystack key pair — the secret key starts with "sk_" and the public key with "pk_", both from the same Paystack dashboard (Settings > API Keys & Webhooks).');
      q.setPaystackConfig.run(secretKey, publicKey, u.tenantId);
      return { ok: true, configured: true, testMode: secretKey.startsWith('sk_test_') };
    },

    // ---- Public giving page (app/give.html) — deliberately unauthenticated: a donor is not a
    // signed-in staff account. `t` is the opaque tenant id from the giving link a church shares
    // (Settings > Online giving); these routes hand back only what that church chose to publish
    // (name, logo, ministry/fund names) — never members, finance, or staff data.
    'GET /give/info': (req, _b, url) => {
      const tenantId = url.searchParams.get('t') ?? '';
      const t = q.tenantById.get(tenantId);
      if (!t || t.plan === 'suspended') throw new HttpError(404, 'Giving link not found.');
      const row = q.paystackConfig.get(tenantId);
      if (!row?.paystack_secret_key || !row?.paystack_public_key) throw new HttpError(404, 'This church has not set up online giving yet.');
      const settingsRow = q.churchProfileRec.get(tenantId);
      const settings = settingsRow ? JSON.parse(settingsRow.data) : {};
      return {
        tenantId, churchName: t.name, logo: settings.logo ?? null, publicKey: row.paystack_public_key,
        ministries: q.publicMinistries.all(tenantId).map((r) => JSON.parse(r.data)).map((m) => ({ id: m.id, name: m.name })),
        funds: q.publicFunds.all(tenantId).map((r) => JSON.parse(r.data)).map((f) => ({ id: f.id, name: f.name })),
      };
    },

    // Starts a Paystack checkout for one gift. Creates a `pending` giving_intents row FIRST (so
    // the reference exists to be looked up) before ever calling out to Paystack.
    'POST /give/init': async (req, body) => {
      const tenantId = (body.tenantId ?? '').trim();
      const t = q.tenantById.get(tenantId);
      if (!t || t.plan === 'suspended') throw new HttpError(404, 'Giving link not found.');
      const row = q.paystackConfig.get(tenantId);
      if (!row?.paystack_secret_key) throw new HttpError(400, 'This church has not set up online giving yet.');
      const amount = Number(body.amount);
      if (!(amount > 0)) throw new HttpError(400, 'Enter an amount above zero.');
      const purpose = GIVING_PURPOSES.includes(body.purpose) ? body.purpose : 'donation';
      const donorName = (body.donorName ?? '').trim() || 'Anonymous';
      const donorEmail = (body.donorEmail ?? '').trim();
      const donorPhone = (body.donorPhone ?? '').trim();
      if (!donorEmail && !donorPhone) throw new HttpError(400, 'Enter an email or phone number so we can confirm your payment.');
      const ministryId = (body.ministryId ?? '').trim() || null;
      const fundId = (body.fundId ?? '').trim() || null;
      const id = `give_${randomUUID()}`;
      q.insGivingIntent.run(id, tenantId, amount, 'GHS', purpose, ministryId, fundId, donorName, donorEmail || null, donorPhone || null, Date.now());
      try {
        // Paystack requires an email even for a mobile-money-only payer; donors who only give a
        // phone number get a throwaway placeholder address instead of being turned away.
        const data = await initializeTransaction({
          secretKey: row.paystack_secret_key, email: donorEmail || `giver+${id}@donor.churchmanager.app`,
          amount, currency: 'GHS', reference: id, callbackUrl: (body.callbackUrl ?? '').trim() || undefined,
          metadata: { churchName: t.name, purpose, donorName },
        });
        return { reference: id, authorizationUrl: data.authorization_url };
      } catch (e) {
        if (e instanceof PaystackConfigError) throw new HttpError(400, e.message);
        throw new HttpError(502, e.message || 'Could not start the payment with Paystack — please try again.');
      }
    },

    // Polled by the giving page right after Paystack redirects the donor back. Self-heals rather
    // than only waiting on the webhook: if the intent is still `pending` here, it asks Paystack
    // directly whether the payment actually went through and finalizes it inline — so the "thank
    // you" screen doesn't depend on the webhook having already landed.
    'GET /give/status': async (req, _b, url) => {
      const ref = url.searchParams.get('ref') ?? '';
      const intent = q.givingIntent.get(ref);
      if (!intent) throw new HttpError(404, 'Not found.');
      const t = q.tenantById.get(intent.tenant_id);
      if (intent.status === 'pending') {
        const row = q.paystackConfig.get(intent.tenant_id);
        try {
          const data = await verifyTransaction({ secretKey: row?.paystack_secret_key, reference: intent.id });
          if (data.status === 'success') finalizeGivingIntent(intent, data);
          else if (['failed', 'abandoned'].includes(data.status)) q.markGivingIntentFailed.run(intent.id);
        } catch { /* Paystack unreachable right now — leave it pending, the webhook or a later poll will catch it */ }
      }
      const fresh = q.givingIntent.get(ref) ?? intent;
      return { status: fresh.status, amount: fresh.amount, currency: fresh.currency, purpose: fresh.purpose, tenantId: fresh.tenant_id, churchName: t?.name ?? '' };
    },

    // Paystack's own server-to-server confirmation — the durable backstop for when a donor pays
    // (e.g. approves a MoMo prompt on their phone) but never makes it back to the browser to hit
    // /give/status themselves. Signed per-request with HMAC-SHA512 of the raw body, keyed by
    // whichever church's OWN secret key the reference (looked up first, unverified) belongs to.
    'POST /give/webhook': async (req, body, _url, rawBody) => {
      const ref = body?.data?.reference;
      if (!ref) return { ok: true }; // not a transaction event we care about
      const intent = q.givingIntent.get(ref);
      if (!intent) return { ok: true }; // not one of ours
      const row = q.paystackConfig.get(intent.tenant_id);
      if (!verifySignature(row?.paystack_secret_key, rawBody, req.headers['x-paystack-signature'])) throw new HttpError(401, 'bad signature');
      if (body.event === 'charge.success' && intent.status === 'pending') {
        try {
          const data = await verifyTransaction({ secretKey: row.paystack_secret_key, reference: ref });
          if (data.status === 'success') finalizeGivingIntent(intent, data);
        } catch (e) { console.error('Paystack webhook verify failed', e); }
      }
      return { ok: true };
    },

    // ---- QR self-check-in: owner/admin/secretary set what to call the attendance record it
    // creates (app/checkin.html's own display info needs no auth — see below). No third-party
    // account is involved at all — unlike SMS/Paystack/WhatsApp above, there's nothing to
    // "connect", so this has no configured/not-configured state to report.
    'GET /checkin/config': (req) => {
      const u = auth(req);
      if (!['owner', 'admin', 'secretary'].includes(u.role)) throw new HttpError(403, 'forbidden');
      const row = q.qrCheckinConfig.get(u.tenantId);
      return { serviceName: row?.qr_checkin_service ?? '' };
    },

    'POST /checkin/config': (req, body) => {
      const u = auth(req);
      if (!['owner', 'admin'].includes(u.role)) throw new HttpError(403, 'forbidden');
      q.setQrCheckinConfig.run((body.serviceName ?? '').trim() || null, u.tenantId);
      return { ok: true };
    },

    // ---- Public check-in page (app/checkin.html) — deliberately unauthenticated, same reasoning
    // as the giving page: a member scanning the church's displayed QR code is not a signed-in
    // staff account. `t` is the same opaque tenant id used in the giving link — not a secret, just
    // an identifier, and this hands back only a church name/logo to display, never member data.
    'GET /checkin/info': (req, _b, url) => {
      const tenantId = (url.searchParams.get('t') ?? '').toLowerCase();
      const t = q.tenantById.get(tenantId);
      if (!t || t.plan === 'suspended') throw new HttpError(404, 'Check-in link not found.');
      const settingsRow = q.churchProfileRec.get(tenantId);
      const settings = settingsRow ? JSON.parse(settingsRow.data) : {};
      return { tenantId, churchName: t.name, logo: settings.logo ?? null };
    },

    // A member's own phone, typed on their own device right after scanning the QR code — matched
    // to a member the same way an inbound WhatsApp message is (normalizeGhanaPhone), and marked
    // present the same way (recordSelfCheckIn). Deliberately never reveals the church's member
    // list to an unauthenticated caller — a phone that doesn't match anyone just gets told so, not
    // shown who else is a member.
    'POST /checkin': (req, body) => {
      const tenantId = (body.tenantId ?? '').toLowerCase();
      const t = q.tenantById.get(tenantId);
      if (!t || t.plan === 'suspended') throw new HttpError(404, 'Check-in link not found.');
      const phone = normalizeGhanaPhone(body.phone);
      if (!phone) throw new HttpError(400, "That doesn't look like a valid phone number.");
      const members = q.membersOf.all(tenantId).map((r) => JSON.parse(r.data));
      const member = members.find((m) => normalizeGhanaPhone(m.phone) === phone);
      if (!member) throw new HttpError(404, "We couldn't find a member with that phone number — see the welcome desk to get checked in.");
      const defaultService = t.qr_checkin_service || t.whatsapp_checkin_service || 'Sunday service';
      const justNow = recordSelfCheckIn(tenantId, member.id, defaultService);
      return { ok: true, name: member.name, alreadyCheckedIn: !justNow };
    },

    // ---- platform admin console (app/admin.html): separate login (server/src/platformAdmin.js
    // seeds it from env vars — no public sign-up), scoped to each church's basic profile and
    // account info only. It never touches a church's members/finance/attendance/staff records —
    // those stay reachable only through that church's own accounts and permissions.js.
    'POST /admin/login': (req, body) => {
      const row = q.platformAdminByEmail.get((body.email ?? '').toLowerCase());
      if (!row || !verifyPassword(body.password ?? '', row.pass_hash)) throw new HttpError(401, 'invalid credentials');
      return { token: signToken({ sub: row.id, kind: 'platform' }, secret), admin: { id: row.id, email: row.email, name: row.name } };
    },

    'GET /admin/tenants': (req) => {
      authAdmin(req);
      return q.allTenants.all().map((t) => {
        const settingsRow = q.churchProfileRec.get(t.id);
        const settings = settingsRow ? JSON.parse(settingsRow.data) : {};
        const smsRow = q.smsConfig.get(t.id);
        return {
          id: t.id, name: t.name, plan: t.plan, createdAt: t.created_at,
          members: q.membersCountOf.get(t.id).n, staff: q.activeStaffCountOf.get(t.id).n,
          motto: settings.motto ?? '', location: settings.location ?? '', district: settings.district ?? '',
          region: settings.region ?? '', logo: settings.logo ?? null,
          smsConfigured: !!(smsRow?.sms_api_key && smsRow?.sms_sender_id), smsSenderId: smsRow?.sms_sender_id ?? null,
        };
      });
    },

    'POST /admin/tenants/update': (req, body) => {
      authAdmin(req);
      const t = q.tenantById.get(body.id ?? '');
      if (!t) throw new HttpError(404, 'no such church');
      const name = (body.name ?? '').trim();
      if (!name) throw new HttpError(400, 'name is required');
      q.updateTenant.run(name, (body.plan ?? t.plan).trim() || t.plan, t.id);
      return { ok: true };
    },

    // Quick suspend/reactivate — a one-click version of the Plan field on the full profile form,
    // for the "this church needs cutting off right now" case. A suspended church's own users are
    // refused at /auth/login and at every authenticated call (see auth() above), not merely
    // labeled suspended in this console.
    'POST /admin/tenants/set-plan': (req, body) => {
      authAdmin(req);
      const t = q.tenantById.get(body.id ?? '');
      if (!t) throw new HttpError(404, 'no such church');
      if (!PLANS.includes(body.plan)) throw new HttpError(400, 'bad plan');
      q.updateTenant.run(t.name, body.plan, t.id);
      return { ok: true };
    },

    // Read-only — who has a login at this church, and what role/ministry they're scoped to.
    // Support/troubleshooting only: this console still never edits a church's own staff accounts
    // (create/deactivate/reset password stays with that church's own owner/admin, under Settings).
    'GET /admin/tenants/staff': (req, _b, url) => {
      authAdmin(req);
      const t = q.tenantById.get(url.searchParams.get('id') ?? '');
      if (!t) throw new HttpError(404, 'no such church');
      return { staff: q.staff.all(t.id).map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, ministryIds: JSON.parse(r.ministry_ids), active: !!r.active })) };
    },

    // Permanently deletes a church: every member/finance/attendance/etc. record and every staff
    // login, then the tenant itself. Irreversible — admin.js gates it behind a confirm dialog that
    // makes the operator type the church's name back.
    'POST /admin/tenants/delete': (req, body) => {
      authAdmin(req);
      const t = q.tenantById.get(body.id ?? '');
      if (!t) throw new HttpError(404, 'no such church');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM records WHERE tenant_id = ?').run(t.id);
        db.prepare('DELETE FROM users WHERE tenant_id = ?').run(t.id);
        db.prepare('DELETE FROM tenants WHERE id = ?').run(t.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { ok: true };
    },

    // Writes straight into that tenant's own 'settings'/'church' record through the same
    // versioned upsert /sync/push uses, so it bumps seq like any other write and every one of
    // that church's own signed-in devices picks it up on their next pull — same as if a church
    // admin had edited it themselves under Settings.
    'POST /admin/tenants/church-profile': (req, body) => {
      authAdmin(req);
      const t = q.tenantById.get(body.id ?? '');
      if (!t) throw new HttpError(404, 'no such church');
      const existingRow = q.churchProfileRec.get(t.id);
      const existing = existingRow ? JSON.parse(existingRow.data) : { id: 'church' };
      const rec = { ...existing, id: 'church',
        motto: body.motto ?? existing.motto, location: body.location ?? existing.location,
        district: body.district ?? existing.district, region: body.region ?? existing.region,
        logo: body.logo !== undefined ? (body.logo || undefined) : existing.logo };
      const { seq } = q.bump.get(t.id);
      q.upsert.run(t.id, 'settings', 'church', JSON.stringify(rec), Date.now(), 0, seq, null);
      return { ok: true };
    },

    'POST /admin/tenants/sms-config': (req, body) => {
      authAdmin(req);
      const t = q.tenantById.get(body.id ?? '');
      if (!t) throw new HttpError(404, 'no such church');
      const apiKey = (body.apiKey ?? '').trim();
      const senderId = (body.senderId ?? '').trim();
      if (!apiKey && !senderId) { q.setSmsConfig.run(null, null, t.id); return { ok: true, configured: false }; }
      if (!apiKey || !senderId) throw new HttpError(400, 'API key and sender ID are both required');
      if (!SENDER_ID_RE.test(senderId)) throw new HttpError(400, 'Sender ID must be 3-11 letters/numbers');
      q.setSmsConfig.run(apiKey, senderId, t.id);
      return { ok: true, configured: true };
    },

    // Client -> server. Optimistic concurrency by server-assigned version (seq), not by
    // client clock: a write must be based on the version this device last saw (baseSeq).
    // Whoever commits first wins; the loser gets the current copy back instead of being
    // silently discarded or (as a clock-based scheme would allow) able to win every future
    // conflict just by claiming a later timestamp.
    'POST /sync/push': (req, body) => {
      const u = auth(req);
      const results = [];
      db.exec('BEGIN');
      try {
        for (const c of body.changes ?? []) {
          const { collection, id, data, deleted } = c;
          const baseSeq = Number.isInteger(c.baseSeq) ? c.baseSeq : 0;
          // updatedAt is stored for display/audit only (receipts, "last edited"); it never
          // decides conflicts. Still clamped so a bad clock can't corrupt those dates.
          const updatedAt = typeof c.updatedAt === 'number' ? Math.min(c.updatedAt, Date.now() + 5 * 60_000) : c.updatedAt;
          if (!COLLECTIONS.includes(collection) || !id || typeof updatedAt !== 'number') {
            results.push({ id, status: 'invalid' }); continue;
          }
          const existingRow = q.rec.get(u.tenantId, collection, id);
          const existing = existingRow ? JSON.parse(existingRow.data) : null;
          const rec = { ...data, id };
          if (!canWrite(u, collection, rec, existing)) {
            results.push({ collection, id, status: 'forbidden' }); continue;
          }
          // Finance ledger is append-only, for every role including owner/admin: once a
          // transaction is posted it can never be edited or deleted, only reversed or
          // corrected by a new entry. Reported as a conflict (not "forbidden") so the
          // client immediately restores the original instead of leaving a doomed edit
          // sitting locally until a manual re-download.
          if (collection === 'transactions' && existingRow) {
            results.push({ collection, id, status: 'conflict', seq: existingRow.seq,
              data: existing, updatedAt: existingRow.updated_at, deleted: !!existingRow.deleted });
            continue;
          }
          if (existingRow && existingRow.seq !== baseSeq) {
            // Someone else's write landed in between. Hand back the authoritative copy so
            // the client can adopt it immediately instead of waiting for the next pull.
            results.push({ collection, id, status: 'conflict', seq: existingRow.seq,
              data: existing, updatedAt: existingRow.updated_at, deleted: !!existingRow.deleted });
            continue;
          }
          const { seq } = q.bump.get(u.tenantId);
          q.upsert.run(u.tenantId, collection, id, JSON.stringify(rec), updatedAt,
            deleted ? 1 : 0, seq, ministryOf(collection, rec));
          results.push({ collection, id, status: 'ok', seq });
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { results };
    },

    // Server -> client. Cursor-based, filtered by what this user may see.
    'GET /sync/pull': (req, _b, url) => {
      const u = auth(req);
      const since = Number(url.searchParams.get('since') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 1000);
      const rows = q.since.all(u.tenantId, since, limit);
      const changes = [];
      for (const r of rows) {
        const data = JSON.parse(r.data);
        if (!canRead(u, r.collection, data)) continue;
        changes.push({ collection: r.collection, id: r.id, data, updatedAt: r.updated_at,
          deleted: !!r.deleted, seq: r.seq });
      }
      const cursor = rows.length ? rows[rows.length - 1].seq : since;
      return { changes, cursor, more: rows.length === limit };
    },

    'GET /me': (req) => ({ user: auth(req), church: db.prepare('SELECT name FROM tenants WHERE id = ?').get(auth(req).tenantId)?.name }),

    'GET /health': () => ({ ok: true }),
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    try {
      const routeKey = `${req.method} ${url.pathname}`;
      const route = routes[routeKey];
      if (!route) throw new HttpError(404, 'not found');
      checkRateLimit(clientIp(req), routeKey);
      let body = {};
      let rawBody = '';
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const ch of req) {
          size += ch.length;
          if (size > 5_000_000) throw new HttpError(413, 'too large');
          chunks.push(ch);
        }
        rawBody = Buffer.concat(chunks).toString();
        try { body = JSON.parse(rawBody || '{}'); }
        catch { throw new HttpError(400, 'bad json'); }
      }
      // rawBody is only used by POST /give/webhook, to verify Paystack's HMAC signature against
      // the exact bytes it signed — every other route just takes the already-parsed `body`.
      const out = await route(req, body, url, rawBody); // routes are normally synchronous; awaiting is a no-op for those and lets /sms/send (which calls out to Arkesel) return normally too
      // { __raw } is GET /whatsapp/webhook's one exception to the JSON convention below: Meta's
      // verification handshake requires the bare challenge string back, not a JSON document.
      if (out && typeof out === 'object' && '__raw' in out) { res.writeHead(200, { 'content-type': 'text/plain' }).end(String(out.__raw)); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: status === 500 ? 'server error' : e.message }));
    }
  };

  return http.createServer(handler);
}

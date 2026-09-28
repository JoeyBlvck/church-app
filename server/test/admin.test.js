import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureSuperAdmin } from '../src/platformAdmin.js';

async function setup() {
  const db = openDb();
  ensureSuperAdmin(db, 'root@churchmanager.app', 'super-secret-1');
  const server = createApp(db, { secret: 't' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  return { server, call };
}

test('platform admin: login is separate from church logins, and its token cannot be used as either', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;

  assert.equal((await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'wrong' })).status, 401);
  const admin = (await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'super-secret-1' })).body;
  assert.ok(admin.token);
  assert.equal(admin.admin.email, 'root@churchmanager.app');

  // an admin token is useless against the regular church API, and a church token is useless
  // against the admin console — the two are entirely separate credentials.
  assert.equal((await call('GET', '/sync/pull?since=0', null, admin.token)).status, 401);
  assert.equal((await call('GET', '/admin/tenants', null, o.token)).status, 401);
  assert.equal((await call('GET', '/admin/tenants')).status, 401);
  server.close();
});

test('platform admin: sees every church\'s basic info, can edit church profile fields and plan, but never members/finance', async () => {
  const { server, call } = await setup();
  const a = (await call('POST', '/auth/register-church', { churchName: 'Grace Chapel', name: 'Ama', email: 'a@x.org', password: 'password1' })).body;
  const b = (await call('POST', '/auth/register-church', { churchName: 'Bethel', name: 'Kofi', email: 'b@x.org', password: 'password1' })).body;
  await call('POST', '/sync/push', { changes: [{ collection: 'members', id: 'm1', data: { name: 'A Member' }, updatedAt: 1 }] }, a.token);

  const { token } = (await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'super-secret-1' })).body;
  const tenants = (await call('GET', '/admin/tenants', null, token)).body;
  assert.equal(tenants.length, 2);
  const grace = tenants.find((t) => t.name === 'Grace Chapel');
  assert.equal(grace.members, 1);
  assert.equal(grace.plan, 'trial');
  assert.equal(grace.smsConfigured, false);
  // the admin listing carries a member COUNT, never the members' own data
  assert.equal(typeof grace.members, 'number');

  // edit name + plan
  const upd = await call('POST', '/admin/tenants/update', { id: grace.id, name: 'Grace Chapel International', plan: 'active' }, token);
  assert.equal(upd.status, 200);
  assert.equal((await call('GET', '/admin/tenants', null, token)).body.find((t) => t.id === grace.id).plan, 'active');

  // edit church profile — should land in that tenant's own 'settings' collection, versioned
  // the same way a normal sync write is, so the church's own device picks it up on pull
  const before = (await call('GET', '/sync/pull?since=0', null, a.token)).body.cursor;
  const prof = await call('POST', '/admin/tenants/church-profile', { id: grace.id, motto: 'Faith and Works', region: 'Greater Accra' }, token);
  assert.equal(prof.status, 200);
  const pulled = await call('GET', `/sync/pull?since=${before}`, null, a.token);
  const churchRec = pulled.body.changes.find((c) => c.collection === 'settings' && c.id === 'church');
  assert.equal(churchRec.data.motto, 'Faith and Works');
  assert.equal(churchRec.data.region, 'Greater Accra');

  // set SMS config from the console too
  const sms = await call('POST', '/admin/tenants/sms-config', { id: grace.id, apiKey: 'k', senderId: 'GraceChapel' }, token);
  assert.equal(sms.status, 200);
  assert.equal((await call('GET', '/admin/tenants', null, token)).body.find((t) => t.id === grace.id).smsSenderId, 'GraceChapel');
  assert.equal((await call('GET', '/sms/config', null, a.token)).body.configured, true); // the church's own owner sees it took effect

  // validation
  assert.equal((await call('POST', '/admin/tenants/update', { id: grace.id, name: '' }, token)).status, 400);
  assert.equal((await call('POST', '/admin/tenants/update', { id: 'no-such-id', name: 'X' }, token)).status, 404);
  assert.equal((await call('POST', '/admin/tenants/sms-config', { id: grace.id, apiKey: 'k', senderId: '!!' }, token)).status, 400);

  server.close();
});

test('platform admin: suspend cuts a church off at login and mid-session; reactivate restores it', async () => {
  const { server, call } = await setup();
  const a = (await call('POST', '/auth/register-church', { churchName: 'Grace Chapel', name: 'Ama', email: 'a@x.org', password: 'password1' })).body;
  const { token } = (await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'super-secret-1' })).body;
  const grace = (await call('GET', '/admin/tenants', null, token)).body.find((t) => t.name === 'Grace Chapel');

  // a call already in flight with an existing session token is cut off immediately, not just
  // refused on its next login
  assert.equal((await call('GET', '/sync/pull?since=0', null, a.token)).status, 200);
  const suspend = await call('POST', '/admin/tenants/set-plan', { id: grace.id, plan: 'suspended' }, token);
  assert.equal(suspend.status, 200);
  assert.equal((await call('GET', '/admin/tenants', null, token)).body.find((t) => t.id === grace.id).plan, 'suspended');
  assert.equal((await call('GET', '/sync/pull?since=0', null, a.token)).status, 403);

  // and a fresh login attempt is refused too, with a message rather than a bare "invalid credentials"
  const blocked = await call('POST', '/auth/login', { email: 'a@x.org', password: 'password1' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /suspended/i);

  // reactivating restores both
  await call('POST', '/admin/tenants/set-plan', { id: grace.id, plan: 'active' }, token);
  assert.equal((await call('GET', '/sync/pull?since=0', null, a.token)).status, 200);
  const relogin = await call('POST', '/auth/login', { email: 'a@x.org', password: 'password1' });
  assert.equal(relogin.status, 200);

  assert.equal((await call('POST', '/admin/tenants/set-plan', { id: grace.id, plan: 'not-a-plan' }, token)).status, 400);
  assert.equal((await call('POST', '/admin/tenants/set-plan', { id: 'no-such-id', plan: 'active' }, token)).status, 404);
  server.close();
});

test('platform admin: can view (read-only) a church\'s staff accounts, and delete a church entirely', async () => {
  const { server, call } = await setup();
  const a = (await call('POST', '/auth/register-church', { churchName: 'Grace Chapel', name: 'Ama', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'Kofi', email: 'kofi@x.org', password: 'password1', role: 'secretary' }, a.token);
  const { token } = (await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'super-secret-1' })).body;
  const grace = (await call('GET', '/admin/tenants', null, token)).body.find((t) => t.name === 'Grace Chapel');

  const staff = await call('GET', `/admin/tenants/staff?id=${grace.id}`, null, token);
  assert.equal(staff.status, 200);
  const names = staff.body.staff.map((s) => s.name).sort();
  assert.deepEqual(names, ['Ama', 'Kofi']);
  assert.equal(staff.body.staff.find((s) => s.name === 'Ama').role, 'owner');
  // read-only: this console has no route that edits a church's own staff accounts
  assert.equal((await call('GET', '/admin/tenants/staff?id=no-such-id', null, token)).status, 404);

  await call('POST', '/sync/push', { changes: [{ collection: 'members', id: 'm1', data: { name: 'A Member' }, updatedAt: 1 }] }, a.token);
  const del = await call('POST', '/admin/tenants/delete', { id: grace.id }, token);
  assert.equal(del.status, 200);
  assert.equal((await call('GET', '/admin/tenants', null, token)).body.find((t) => t.id === grace.id), undefined);
  // the church's own login is gone too, not just hidden from the console
  assert.equal((await call('POST', '/auth/login', { email: 'a@x.org', password: 'password1' })).status, 401);
  assert.equal((await call('POST', '/admin/tenants/delete', { id: 'no-such-id' }, token)).status, 404);
  server.close();
});

test('ensureSuperAdmin: re-running with a new password rotates it; missing email/password is a no-op', async () => {
  const db = openDb();
  ensureSuperAdmin(db, null, null); // no-op path: must not throw with nothing configured
  ensureSuperAdmin(db, 'root@churchmanager.app', 'first-password');
  const server = createApp(db, { secret: 't' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'first-password' })).status, 200);

  ensureSuperAdmin(db, 'root@churchmanager.app', 'second-password'); // rotate, same email
  assert.equal((await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'first-password' })).status, 401);
  assert.equal((await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'second-password' })).status, 200);

  assert.throws(() => ensureSuperAdmin(db, 'x@y.com', 'short'));
  server.close();
});

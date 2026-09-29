import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureSuperAdmin } from '../src/platformAdmin.js';

async function setup(createAppOpts = {}) {
  const db = openDb();
  ensureSuperAdmin(db, 'root@churchmanager.app', 'super-secret-1');
  const server = createApp(db, { secret: 't', appUrl: 'https://app.test', ...createAppOpts });
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

test('platform admin: can create a new church (owner gets no password, only a setup email/link)', async () => {
  let lastEmail = null;
  const sendWelcomeEmailImpl = async (msg) => { lastEmail = msg; };
  const { server, call } = await setup({ sendWelcomeEmailImpl });
  const { token } = (await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'super-secret-1' })).body;

  const created = await call('POST', '/admin/tenants/create', { churchName: 'New Hope', ownerName: 'Kwame', ownerEmail: 'kwame@x.org' }, token);
  assert.equal(created.status, 200);
  assert.equal(created.body.emailSent, true);
  assert.ok(created.body.setupUrl.startsWith('https://app.test/?resetToken='));
  assert.equal(lastEmail.to, 'kwame@x.org');
  assert.equal(lastEmail.churchName, 'New Hope');

  // the owner can't sign in with anything until they use the emailed link
  assert.equal((await call('POST', '/auth/login', { email: 'kwame@x.org', password: 'whatever12' })).status, 401);
  const setupToken = new URL(created.body.setupUrl).searchParams.get('resetToken');
  const reset = await call('POST', '/auth/reset-password', { token: setupToken, password: 'chosenpassword1' });
  assert.equal(reset.status, 200);
  const login = await call('POST', '/auth/login', { email: 'kwame@x.org', password: 'chosenpassword1' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'owner');

  // the church now shows up in the tenant list like any other
  const tenants = (await call('GET', '/admin/tenants', null, token)).body;
  assert.ok(tenants.some((t) => t.name === 'New Hope'));

  // validation + duplicate email
  assert.equal((await call('POST', '/admin/tenants/create', { churchName: '', ownerName: 'X', ownerEmail: 'x@x.org' }, token)).status, 400);
  assert.equal((await call('POST', '/admin/tenants/create', { churchName: 'Dup', ownerName: 'X', ownerEmail: 'kwame@x.org' }, token)).status, 409);
  server.close();
});

test('platform admin: can add and edit a church\'s non-owner staff, but never the owner', async () => {
  const { server, call } = await setup();
  const a = (await call('POST', '/auth/register-church', { churchName: 'Grace Chapel', name: 'Ama', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/sync/push', { changes: [{ collection: 'ministries', id: 'min1', data: { id: 'min1', name: 'Youth' }, updatedAt: 1 }] }, a.token);
  const { token } = (await call('POST', '/admin/login', { email: 'root@churchmanager.app', password: 'super-secret-1' })).body;
  const grace = (await call('GET', '/admin/tenants', null, token)).body.find((t) => t.name === 'Grace Chapel');

  const mins = await call('GET', `/admin/tenants/ministries?id=${grace.id}`, null, token);
  assert.equal(mins.status, 200);
  assert.deepEqual(mins.body, [{ id: 'min1', name: 'Youth' }]);

  // create a secretary
  const created = await call('POST', '/admin/tenants/staff/create', { tenantId: grace.id, name: 'Kofi', email: 'kofi@x.org', password: 'password1', role: 'secretary' }, token);
  assert.equal(created.status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'kofi@x.org', password: 'password1' })).status, 200);

  // a leader needs a ministry
  assert.equal((await call('POST', '/admin/tenants/staff/create', { tenantId: grace.id, name: 'L', email: 'l@x.org', password: 'password1', role: 'leader' }, token)).status, 400);
  const leader = await call('POST', '/admin/tenants/staff/create', { tenantId: grace.id, name: 'Leader', email: 'leader@x.org', password: 'password1', role: 'leader', ministryIds: ['min1'] }, token);
  assert.equal(leader.status, 200);

  // can't create another owner, and duplicate email is rejected
  assert.equal((await call('POST', '/admin/tenants/staff/create', { tenantId: grace.id, name: 'X', email: 'x@x.org', password: 'password1', role: 'owner' }, token)).status, 400);
  assert.equal((await call('POST', '/admin/tenants/staff/create', { tenantId: grace.id, name: 'X', email: 'kofi@x.org', password: 'password1', role: 'secretary' }, token)).status, 409);

  // edit: change role, reset password, then deactivate
  const kofiId = (await call('GET', `/admin/tenants/staff?id=${grace.id}`, null, token)).body.staff.find((s) => s.name === 'Kofi').id;
  const upd = await call('POST', '/admin/tenants/staff/update', { tenantId: grace.id, id: kofiId, role: 'treasurer', password: 'newpassword2' }, token);
  assert.equal(upd.status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'kofi@x.org', password: 'newpassword2' })).status, 200);
  assert.equal((await call('GET', `/admin/tenants/staff?id=${grace.id}`, null, token)).body.staff.find((s) => s.id === kofiId).role, 'treasurer');

  const deact = await call('POST', '/admin/tenants/staff/update', { tenantId: grace.id, id: kofiId, active: false }, token);
  assert.equal(deact.status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'kofi@x.org', password: 'newpassword2' })).status, 401);

  // the owner account is untouchable from here
  const amaId = (await call('GET', `/admin/tenants/staff?id=${grace.id}`, null, token)).body.staff.find((s) => s.name === 'Ama').id;
  const ownerEdit = await call('POST', '/admin/tenants/staff/update', { tenantId: grace.id, id: amaId, active: false }, token);
  assert.equal(ownerEdit.status, 403);

  // 404s: wrong church, no such user
  assert.equal((await call('POST', '/admin/tenants/staff/create', { tenantId: 'no-such-id', name: 'X', email: 'x2@x.org', password: 'password1', role: 'secretary' }, token)).status, 404);
  assert.equal((await call('POST', '/admin/tenants/staff/update', { tenantId: grace.id, id: 'no-such-id' }, token)).status, 404);
  server.close();
});

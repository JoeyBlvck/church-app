import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function setup() {
  const db = openDb();
  const server = createApp(db, { secret: 't', appUrl: 'https://app.test' });
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

async function seedChurch(call) {
  const owner = (await call('POST', '/auth/register-church',
    { churchName: 'Grace Chapel', name: 'Ama', email: 'ama@x.org', password: 'password1' })).body;
  await call('POST', '/sync/push', { changes: [
    { collection: 'members', id: 'm1', data: { id: 'm1', name: 'Kofi' }, updatedAt: Date.now(), deleted: false, baseSeq: 0 },
    { collection: 'settings', id: 'church', data: { id: 'church', motto: 'Faith and Works' }, updatedAt: Date.now(), deleted: false, baseSeq: 0 },
  ] }, owner.token);
  return owner;
}

test('factory reset: wipes every record as a tombstone, but keeps the tenant and staff logins intact', async () => {
  const { server, call } = await setup();
  const owner = await seedChurch(call);
  await call('POST', '/users', { name: 'Kwabena', email: 'kwabena@x.org', password: 'password1', role: 'secretary' }, owner.token);

  const before = (await call('GET', '/sync/pull?since=0', null, owner.token)).body;
  assert.equal(before.changes.filter((c) => !c.deleted).length, 2); // the member + settings rows just pushed

  const r = await call('POST', '/account/factory-reset', { password: 'password1', churchName: 'Grace Chapel' }, owner.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.wiped, 2);

  // Every record is now a tombstone, not just gone — this is what lets another device's own
  // next sync find out about the wipe instead of keeping stale local data forever.
  const after = (await call('GET', '/sync/pull?since=0', null, owner.token)).body;
  assert.equal(after.changes.length, 2);
  assert.ok(after.changes.every((c) => c.deleted === true));

  // The church itself and every staff login still work afterwards.
  const me = (await call('GET', '/me', null, owner.token)).body;
  assert.equal(me.church, 'Grace Chapel');
  const secretaryLogin = await call('POST', '/auth/login', { email: 'kwabena@x.org', password: 'password1' });
  assert.equal(secretaryLogin.status, 200);
  server.close();
});

test('factory reset: refuses without the exact current password', async () => {
  const { server, call } = await setup();
  const owner = await seedChurch(call);
  const r = await call('POST', '/account/factory-reset', { password: 'wrong-password', churchName: 'Grace Chapel' }, owner.token);
  assert.equal(r.status, 401);
  const after = (await call('GET', '/sync/pull?since=0', null, owner.token)).body;
  assert.ok(after.changes.some((c) => !c.deleted)); // nothing was touched
  server.close();
});

test('factory reset: refuses unless the church name is typed back exactly', async () => {
  const { server, call } = await setup();
  const owner = await seedChurch(call);
  const r = await call('POST', '/account/factory-reset', { password: 'password1', churchName: 'grace chapel' }, owner.token);
  assert.equal(r.status, 400);
  const after = (await call('GET', '/sync/pull?since=0', null, owner.token)).body;
  assert.ok(after.changes.some((c) => !c.deleted)); // nothing was touched
  server.close();
});

test('factory reset: leaders and other non-admin roles are forbidden from running it', async () => {
  const { server, call } = await setup();
  const owner = await seedChurch(call);
  await call('POST', '/users', { name: 'Efua', email: 'efua@x.org', password: 'password1', role: 'treasurer' }, owner.token);
  const treasurer = (await call('POST', '/auth/login', { email: 'efua@x.org', password: 'password1' })).body;
  const r = await call('POST', '/account/factory-reset', { password: 'password1', churchName: 'Grace Chapel' }, treasurer.token);
  assert.equal(r.status, 403);
  server.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function setup(t) {
  const server = createApp(openDb(), { secret: 't' });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  return { base, call };
}
const push = (call, token, changes) => call('POST', '/sync/push', { changes }, token);
const ch = (collection, id, data, updatedAt = 1, deleted = false) => ({ collection, id, data, updatedAt, deleted });

test('/checkin/config: only owner/admin can set it, owner/admin/secretary can read it', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  const tr = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;

  assert.equal((await call('GET', '/checkin/config', null, o.token)).body.serviceName, '');
  assert.equal((await call('POST', '/checkin/config', { serviceName: 'Sunday service' }, s.token)).status, 403); // secretary can't set it
  assert.equal((await call('GET', '/checkin/config', null, tr.token)).status, 403); // treasurer can't even read it

  const ok = await call('POST', '/checkin/config', { serviceName: 'Sunday service' }, o.token);
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/checkin/config', null, s.token)).body.serviceName, 'Sunday service'); // secretary CAN read it
});

test('GET /checkin/info: church name/logo for a valid tenant id; 404 for an unknown or suspended one', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace Chapel', name: 'a', email: 'a@x.org', password: 'password1' })).body;

  const info = await call('GET', `/checkin/info?t=${o.user.tenantId}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.churchName, 'Grace Chapel');
  assert.equal(info.body.logo, null);

  assert.equal((await call('GET', '/checkin/info?t=no-such-tenant')).status, 404);
});

test('POST /checkin: a matching phone checks the member in; unmatched or invalid phones are rejected without leaking who is a member', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/checkin/config', { serviceName: 'Sunday service' }, o.token);
  await push(call, o.token, [ch('members', 'm1', { name: 'Ama Mensah', phone: '0244000000' })]);

  const bad = await call('POST', '/checkin', { tenantId: o.user.tenantId, phone: 'not a phone' });
  assert.equal(bad.status, 400);

  const unmatched = await call('POST', '/checkin', { tenantId: o.user.tenantId, phone: '0201234567' });
  assert.equal(unmatched.status, 404);
  assert.match(unmatched.body.error, /welcome desk/i);

  const first = await call('POST', '/checkin', { tenantId: o.user.tenantId, phone: '0244000000' });
  assert.equal(first.status, 200);
  assert.equal(first.body.name, 'Ama Mensah');
  assert.equal(first.body.alreadyCheckedIn, false);

  // checking in again (e.g. the member scans the QR code twice) must not double-count
  const second = await call('POST', '/checkin', { tenantId: o.user.tenantId, phone: '0244000000' });
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyCheckedIn, true);

  const pulled = await call('GET', '/sync/pull?since=0', null, o.token);
  const att = pulled.body.changes.find((c) => c.collection === 'attendance');
  assert.deepEqual(att.data.presentIds, ['m1']);
  assert.equal(att.data.service, 'Sunday service');
});

test('POST /checkin: falls back to the WhatsApp check-in service name, then "Sunday service", when its own is unset', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await push(call, o.token, [ch('members', 'm1', { name: 'Kofi', phone: '0244000000' })]);

  // no qr_checkin_service and no whatsapp_checkin_service set at all -> "Sunday service"
  const r1 = await call('POST', '/checkin', { tenantId: o.user.tenantId, phone: '0244000000' });
  const pulled1 = await call('GET', '/sync/pull?since=0', null, o.token);
  assert.equal(pulled1.body.changes.find((c) => c.collection === 'attendance').data.service, 'Sunday service');

  // a WhatsApp check-in service name set on a fresh church (own qr_checkin_service still unset) is used as the fallback
  const o2 = (await call('POST', '/auth/register-church', { churchName: 'Bethel', name: 'b', email: 'b@x.org', password: 'password1' })).body;
  await call('POST', '/whatsapp/config', { phoneNumberId: 'pn1', accessToken: 'tok1', checkinService: 'Evening service' }, o2.token);
  await push(call, o2.token, [ch('members', 'm2', { name: 'Esi', phone: '0244000001' })]);
  await call('POST', '/checkin', { tenantId: o2.user.tenantId, phone: '0244000001' });
  const pulled2 = await call('GET', '/sync/pull?since=0', null, o2.token);
  assert.equal(pulled2.body.changes.find((c) => c.collection === 'attendance').data.service, 'Evening service');
});

test('POST /checkin: an unknown or suspended tenant is rejected the same as a bad giving link', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('POST', '/checkin', { tenantId: 'no-such-tenant', phone: '0244000000' })).status, 404);
});

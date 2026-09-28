import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function setup(t) {
  const server = createApp(openDb(), { secret: 't' });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, extraHeaders) => {
    const r = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  return { base, call };
}

test('POST /auth/login: a burst of wrong-password attempts from the same IP gets rate limited (429), not just rejected (401) forever', async (t) => {
  const { call } = await setup(t);
  await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' });

  let sawUnauthorized = 0, sawLimited = 0;
  for (let i = 0; i < 15; i++) {
    const r = await call('POST', '/auth/login', { email: 'a@x.org', password: 'wrong-password' });
    if (r.status === 401) sawUnauthorized++;
    if (r.status === 429) sawLimited++;
  }
  assert.ok(sawUnauthorized > 0, 'the first several attempts should still be ordinary 401s');
  assert.ok(sawLimited > 0, 'attempts past the limit should be 429s');
  assert.match((await call('POST', '/auth/login', { email: 'a@x.org', password: 'wrong-password' })).body.error, /too many/i);
});

test('rate limiting is per-IP: a different x-forwarded-for is not affected by another IP\'s burst', async (t) => {
  const { base } = await setup(t);
  const callAs = (ip) => async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const attacker = callAs('198.51.100.9');
  const normal = callAs('198.51.100.10');
  await attacker('POST', '/auth/register-church', { churchName: 'X', name: 'a', email: 'x@x.org', password: 'password1' });
  for (let i = 0; i < 12; i++) await attacker('POST', '/auth/login', { email: 'x@x.org', password: 'wrong' });
  const blocked = await attacker('POST', '/auth/login', { email: 'x@x.org', password: 'wrong' });
  assert.equal(blocked.status, 429);
  const stillFine = await normal('POST', '/auth/register-church', { churchName: 'Y', name: 'b', email: 'y@x.org', password: 'password1' });
  assert.equal(stillFine.status, 200);
});

test('POST /checkin: repeated phone-number guesses against a tenant get rate limited, not just answered 404 forever', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;

  let sawNotFound = 0, sawLimited = 0;
  for (let i = 0; i < 25; i++) {
    const r = await call('POST', '/checkin', { tenantId: o.user.tenantId, phone: `02440000${String(i).padStart(2, '0')}` });
    if (r.status === 404) sawNotFound++;
    if (r.status === 429) sawLimited++;
  }
  assert.ok(sawNotFound > 0);
  assert.ok(sawLimited > 0);
});

test('routes not in the rate-limited list (e.g. GET /health) are never limited', async (t) => {
  const { call } = await setup(t);
  for (let i = 0; i < 30; i++) assert.equal((await call('GET', '/health')).status, 200);
});

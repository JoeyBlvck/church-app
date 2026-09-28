import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { initializeTransaction, verifyTransaction, verifySignature, PaystackConfigError } from '../src/paystack.js';

// ---- unit: paystack.js against a mocked Paystack endpoint ----
test('initializeTransaction: posts amount in pesewas, GHS channels, and returns the authorization_url', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://paystack.com/pay/x', reference: 'give_1' } }) };
  };
  const data = await initializeTransaction(
    { secretKey: 'sk_test_1', email: 'a@b.com', amount: 50, currency: 'GHS', reference: 'give_1', callbackUrl: 'https://x/give.html' },
    { fetchImpl },
  );
  assert.equal(data.authorization_url, 'https://paystack.com/pay/x');
  assert.equal(calls[0].url, 'https://api.paystack.co/transaction/initialize');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer sk_test_1');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.amount, 5000); // GHS 50 -> 5000 pesewas
  assert.deepEqual(body.channels, ['mobile_money', 'card']);
  assert.equal(body.reference, 'give_1');
});

test('initializeTransaction: rejects with PaystackConfigError when no secret key is set', async () => {
  await assert.rejects(initializeTransaction({ secretKey: '', email: 'a@b.com', amount: 10, reference: 'r' }), PaystackConfigError);
});

test('verifyTransaction: GETs the verify endpoint and returns Paystack\'s data', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.paystack.co/transaction/verify/give_1');
    return { ok: true, json: async () => ({ status: true, data: { status: 'success', amount: 5000, channel: 'mobile_money' } }) };
  };
  const data = await verifyTransaction({ secretKey: 'sk_test_1', reference: 'give_1' }, { fetchImpl });
  assert.equal(data.status, 'success');
});

test('verifySignature: accepts a correctly-signed body and rejects a tampered one or wrong key', () => {
  const secret = 'sk_test_1', raw = JSON.stringify({ event: 'charge.success', data: { reference: 'give_1' } });
  const sig = createHmac('sha512', secret).update(raw).digest('hex');
  assert.equal(verifySignature(secret, raw, sig), true);
  assert.equal(verifySignature(secret, raw + 'x', sig), false);
  assert.equal(verifySignature('sk_test_wrong', raw, sig), false);
  assert.equal(verifySignature(secret, raw, ''), false);
});

// ---- integration: /paystack/config and /give/* routes ----
// `t` (the test's own TestContext) registers the server close as cleanup via t.after, so it's
// always released even if an assertion throws partway through — an assertion failure must not
// leave an open server dangling (that would hang the whole suite, since --test won't exit while
// a listening handle is still open).
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
    return { status: r.status, body: await r.json() };
  };
  return { server, base, call };
}
const push = (call, token, changes) => call('POST', '/sync/push', { changes }, token);
const ch = (collection, id, data, updatedAt = 1, deleted = false) => ({ collection, id, data, updatedAt, deleted });

test('/paystack/config: only owner/admin can set or read it; the secret key never comes back', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;

  assert.equal((await call('GET', '/paystack/config', null, o.token)).body.configured, false);
  assert.equal((await call('POST', '/paystack/config', { secretKey: 'sk_test_1', publicKey: 'pk_test_1' }, s.token)).status, 403);

  const bad = await call('POST', '/paystack/config', { secretKey: 'not-a-key', publicKey: 'pk_test_1' }, o.token);
  assert.equal(bad.status, 400);

  const ok = await call('POST', '/paystack/config', { secretKey: 'sk_test_1', publicKey: 'pk_test_1' }, o.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.testMode, true);
  const read = await call('GET', '/paystack/config', null, o.token);
  assert.equal(read.body.configured, true);
  assert.equal(read.body.publicKey, 'pk_test_1');
  assert.equal(JSON.stringify(read.body).includes('sk_test_1'), false);
  assert.equal((await call('GET', '/paystack/config', null, s.token)).status, 403);
});

test('/give/info, /give/init, /give/status: a full successful gift end to end, mocking Paystack', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace Chapel', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/paystack/config', { secretKey: 'sk_test_1', publicKey: 'pk_test_1' }, o.token);
  await push(call, o.token, [ch('ministries', 'yth', { name: 'Youth' }), ch('funds', 'bld', { name: 'Building Fund' })]);

  const info = await call('GET', '/give/info?t=' + o.user.tenantId);
  assert.equal(info.body.churchName, 'Grace Chapel');
  assert.equal(info.body.publicKey, 'pk_test_1');
  assert.deepEqual(info.body.ministries, [{ id: 'yth', name: 'Youth' }]);
  assert.deepEqual(info.body.funds, [{ id: 'bld', name: 'Building Fund' }]);

  const originalFetch = globalThis.fetch;
  let verifyCalls = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/transaction/initialize')) {
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://paystack.com/pay/x', reference: body.reference } }) };
    }
    if (String(url).includes('/transaction/verify/')) {
      verifyCalls++;
      return { ok: true, json: async () => ({ status: true, data: { status: 'success', amount: 10000, channel: 'mobile_money' } }) };
    }
    return originalFetch(url, opts);
  };
  try {
    const init = await call('POST', '/give/init', {
      tenantId: o.user.tenantId, amount: 100, purpose: 'tithe', ministryId: 'yth', donorName: 'Ama', donorPhone: '0244000000',
    });
    assert.equal(init.status, 200);
    assert.ok(init.body.reference.startsWith('give_'));
    assert.equal(init.body.authorizationUrl, 'https://paystack.com/pay/x');

    // Donor's browser bounces back — /give/status verifies with Paystack and finalizes inline.
    const status1 = await call('GET', '/give/status?ref=' + init.body.reference);
    assert.equal(status1.body.status, 'paid');
    assert.equal(status1.body.amount, 100);
    assert.equal(verifyCalls, 1);

    // Polling again must NOT double-post the transaction (idempotent).
    const status2 = await call('GET', '/give/status?ref=' + init.body.reference);
    assert.equal(status2.body.status, 'paid');
    assert.equal(verifyCalls, 1); // already paid — no second Paystack call needed

    const tx = await call('GET', '/sync/pull?since=0', null, o.token);
    const posted = tx.body.changes.filter((c) => c.collection === 'transactions');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].data.type, 'tithe');
    assert.equal(posted[0].data.amount, 100);
    assert.equal(posted[0].data.method, 'mobile money');
    assert.equal(posted[0].data.ministryId, 'yth');
    assert.match(posted[0].data.note, /Ama/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/give/init: rejects a bad/suspended tenant, an unconfigured church, a zero amount, and missing contact info', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;

  assert.equal((await call('POST', '/give/init', { tenantId: 'nope', amount: 10, donorPhone: '0244000000' })).status, 404);
  assert.equal((await call('POST', '/give/init', { tenantId: o.user.tenantId, amount: 10, donorPhone: '0244000000' })).status, 400); // not configured yet

  await call('POST', '/paystack/config', { secretKey: 'sk_test_1', publicKey: 'pk_test_1' }, o.token);
  assert.equal((await call('POST', '/give/init', { tenantId: o.user.tenantId, amount: 0, donorPhone: '0244000000' })).status, 400);
  assert.equal((await call('POST', '/give/init', { tenantId: o.user.tenantId, amount: 10 })).status, 400); // no email/phone
});

test('/give/webhook: verifies the HMAC signature against the right church\'s secret key before trusting the event', async (t) => {
  const { base, call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/paystack/config', { secretKey: 'sk_test_1', publicKey: 'pk_test_1' }, o.token);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/transaction/initialize')) {
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://x', reference: body.reference } }) };
    }
    if (String(url).includes('/transaction/verify/')) return { ok: true, json: async () => ({ status: true, data: { status: 'success', amount: 10000, channel: 'card' } }) };
    return originalFetch(url, opts);
  };
  let reference;
  try {
    const init = await call('POST', '/give/init', { tenantId: o.user.tenantId, amount: 20, donorEmail: 'donor@x.com' });
    reference = init.body.reference;
  } finally { globalThis.fetch = originalFetch; }

  const raw = JSON.stringify({ event: 'charge.success', data: { reference } });
  const badSig = createHmac('sha512', 'wrong-secret').update(raw).digest('hex');
  const rejected = await fetch(base + '/give/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': badSig }, body: raw,
  });
  assert.equal(rejected.status, 401);

  const goodSig = createHmac('sha512', 'sk_test_1').update(raw).digest('hex');
  const globalFetch2 = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/transaction/verify/')) return { ok: true, json: async () => ({ status: true, data: { status: 'success', amount: 2000, channel: 'card' } }) };
    return globalFetch2(url, opts);
  };
  try {
    const accepted = await fetch(base + '/give/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': goodSig }, body: raw,
    });
    assert.equal(accepted.status, 200);
    const status = await call('GET', '/give/status?ref=' + reference);
    assert.equal(status.body.status, 'paid');
  } finally { globalThis.fetch = globalFetch2; }
});

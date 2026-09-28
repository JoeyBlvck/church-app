import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { normalizeGhanaPhone, sendSms, SmsConfigError } from '../src/sms.js';

// ---- unit: phone normalization ----
test('normalizeGhanaPhone: accepts local, international and bare 9-digit forms; rejects junk', () => {
  assert.equal(normalizeGhanaPhone('0244000000'), '233244000000');
  assert.equal(normalizeGhanaPhone('024 400 0000'), '233244000000');
  assert.equal(normalizeGhanaPhone('+233244000000'), '233244000000');
  assert.equal(normalizeGhanaPhone('233244000000'), '233244000000');
  assert.equal(normalizeGhanaPhone('244000000'), '233244000000');
  assert.equal(normalizeGhanaPhone(''), null);
  assert.equal(normalizeGhanaPhone(undefined), null);
  assert.equal(normalizeGhanaPhone('12345'), null);
  assert.equal(normalizeGhanaPhone('not a phone'), null);
});

// ---- unit: sendSms against a mocked Arkesel endpoint ----
test('sendSms: posts to Arkesel with the api-key header and sender/message/recipients body', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ status: 'success', data: { id: 'msg_1' } }) };
  };
  const result = await sendSms({ apiKey: 'k1', senderId: 'GraceChapel', recipients: ['233244000000'], message: 'Hi' }, { fetchImpl });
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sms.arkesel.com/api/v2/sms/send');
  assert.equal(calls[0].opts.headers['api-key'], 'k1');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { sender: 'GraceChapel', message: 'Hi', recipients: ['233244000000'] });
});

test('sendSms: batches large recipient lists and keeps going after one batch fails', async () => {
  const recipients = Array.from({ length: 250 }, (_, i) => `23324400${String(i).padStart(4, '0')}`);
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 2) return { ok: false, status: 500, json: async () => ({ message: 'Arkesel had a hiccup' }) };
    return { ok: true, json: async () => ({ status: 'success' }) };
  };
  const result = await sendSms({ apiKey: 'k', senderId: 'Grace', recipients, message: 'Hi all' }, { fetchImpl });
  assert.equal(call, 3);              // 250 recipients / 100-per-batch = 3 batches, all attempted
  assert.equal(result.sent, 150);     // batches 1 and 3 succeeded (100 each)
  assert.equal(result.failed, 100);   // batch 2 failed
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /hiccup/);
});

test('sendSms: rejects with SmsConfigError when not configured', async () => {
  await assert.rejects(sendSms({ apiKey: '', senderId: '', recipients: ['233244000000'], message: 'Hi' }), SmsConfigError);
});

// ---- integration: /sms/config and /sms/send routes ----
async function setup() {
  const server = createApp(openDb(), { secret: 't' });
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
const push = (call, token, changes) => call('POST', '/sync/push', { changes }, token);
const ch = (collection, id, data, updatedAt = 1, deleted = false) => ({ collection, id, data, updatedAt, deleted });

test('/sms/config: only owner/admin can set or read it; the raw key never comes back', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;

  assert.equal((await call('GET', '/sms/config', null, o.token)).body.configured, false);
  assert.equal((await call('POST', '/sms/config', { apiKey: 's', senderId: 'x' }, s.token)).status, 403); // secretary can't configure

  const bad = await call('POST', '/sms/config', { apiKey: 'realkey', senderId: 'this-sender-id-is-too-long' }, o.token);
  assert.equal(bad.status, 400);

  const ok = await call('POST', '/sms/config', { apiKey: 'realkey', senderId: 'GraceChapel' }, o.token);
  assert.equal(ok.status, 200);
  const read = await call('GET', '/sms/config', null, o.token);
  assert.equal(read.body.configured, true);
  assert.equal(read.body.senderId, 'GraceChapel');
  assert.equal(JSON.stringify(read.body).includes('realkey'), false); // the api key itself is never echoed back
  assert.equal((await call('GET', '/sms/config', null, s.token)).status, 403); // secretary can't read it either
  server.close();
});

test('/sms/send: dedupes shared numbers, skips members with no usable phone, honors ministryIds filter (single or several), and is gated to owner/admin/secretary', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  const t = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;

  await push(call, o.token, [
    ch('members', 'm1', { name: 'Ama', phone: '0244000001', ministryIds: ['youth'] }),
    ch('members', 'm2', { name: 'Kofi', phone: '0244000001', ministryIds: ['choir'] }), // shares Ama's phone (household) — should be de-duped
    ch('members', 'm3', { name: 'Esi', phone: '', ministryIds: ['youth'] }),            // no phone — skipped
    ch('members', 'm4', { name: 'Kwesi', ministryIds: ['choir'] }),                     // no phone field at all — skipped
  ]);

  // no SMS config yet -> a clear error, not a crash
  const notConfigured = await call('POST', '/sms/send', { message: 'Service moved to 10am' }, o.token);
  assert.equal(notConfigured.status, 400);

  await call('POST', '/sms/config', { apiKey: 'k', senderId: 'GraceChapel' }, o.token);

  assert.equal((await call('POST', '/sms/send', { message: 'Hi' }, t.token)).status, 403); // treasurer can't send

  let sentBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === 'https://sms.arkesel.com/api/v2/sms/send') { sentBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ status: 'success' }) }; }
    return originalFetch(url, opts);
  };
  try {
    const whole = await call('POST', '/sms/send', { message: 'Harvest is this Sunday' }, o.token);
    assert.equal(whole.status, 200);
    assert.equal(whole.body.total, 4);
    assert.equal(whole.body.missing, 2);   // Esi (blank) + Kwesi (no field)
    assert.equal(whole.body.sent, 1);      // one de-duped number (Ama & Kofi share it)
    assert.deepEqual(sentBody.recipients, ['233244000001']);
    assert.equal(sentBody.sender, 'GraceChapel');

    const filtered = await call('POST', '/sms/send', { message: 'Choir practice moved', ministryIds: ['choir'] }, o.token);
    assert.equal(filtered.body.total, 2); // Kofi + Kwesi
    assert.equal(filtered.body.sent, 1);  // only Kofi has a usable phone

    // targeting two ministries at once (Youth OR Choir) reaches everyone with either — i.e. all four here
    const both = await call('POST', '/sms/send', { message: 'Joint youth & choir rehearsal', ministryIds: ['youth', 'choir'] }, o.token);
    assert.equal(both.body.total, 4);
    assert.equal(both.body.sent, 1); // still just the one de-duped, usable phone number among all four
  } finally {
    globalThis.fetch = originalFetch; // never leave the real fetch monkey-patched for other tests
  }
  server.close();
});

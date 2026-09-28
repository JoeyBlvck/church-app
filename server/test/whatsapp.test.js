import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { sendTemplateMessage, sendTextMessage, verifyWebhookChallenge, parseInboundMessage, WhatsAppConfigError } from '../src/whatsapp.js';

// ---- unit: whatsapp.js against a mocked Graph API endpoint ----
test('sendTemplateMessage: posts to {baseUrl}/{phoneNumberId}/messages with a Bearer token and the one body variable', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; };
  await sendTemplateMessage({ baseUrl: 'https://graph.facebook.com/v20.0', phoneNumberId: 'pn1', accessToken: 'tok1',
    to: '233244000000', templateName: 'church_notice', templateLang: 'en_US', bodyText: 'Service moved to 10am' }, { fetchImpl });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v20.0/pn1/messages');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer tok1');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '233244000000');
  assert.equal(body.template.name, 'church_notice');
  assert.equal(body.template.language.code, 'en_US');
  assert.equal(body.template.components[0].parameters[0].text, 'Service moved to 10am');
});

test('sendTemplateMessage: rejects with WhatsAppConfigError when no template name is set', async () => {
  await assert.rejects(sendTemplateMessage({ baseUrl: 'x', phoneNumberId: 'pn1', accessToken: 'tok1', to: '233244000000', bodyText: 'hi' }), WhatsAppConfigError);
});

test('sendTemplateMessage/sendTextMessage: rejects with WhatsAppConfigError when not configured', async () => {
  await assert.rejects(sendTemplateMessage({ phoneNumberId: '', accessToken: '', to: '233244000000', templateName: 't', bodyText: 'hi' }), WhatsAppConfigError);
  await assert.rejects(sendTextMessage({ phoneNumberId: '', accessToken: '', to: '233244000000', text: 'hi' }), WhatsAppConfigError);
});

test('sendTextMessage: sends a plain-text body (no template)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({}) }; };
  await sendTextMessage({ phoneNumberId: 'pn1', accessToken: 'tok1', to: '233244000000', text: "You're checked in!" }, { fetchImpl });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.type, 'text');
  assert.equal(body.text.body, "You're checked in!");
});

test('sendTemplateMessage: surfaces the Graph API\'s own error message on failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Template not found' } }) });
  await assert.rejects(
    sendTemplateMessage({ phoneNumberId: 'pn1', accessToken: 'tok1', to: '233244000000', templateName: 'missing', bodyText: 'hi' }, { fetchImpl }),
    /Template not found/,
  );
});

test('verifyWebhookChallenge: only answers a matching subscribe handshake', () => {
  assert.equal(verifyWebhookChallenge({ mode: 'subscribe', token: 'secret', challenge: 'abc123' }, 'secret'), 'abc123');
  assert.equal(verifyWebhookChallenge({ mode: 'subscribe', token: 'wrong', challenge: 'abc123' }, 'secret'), null);
  assert.equal(verifyWebhookChallenge({ mode: 'unsubscribe', token: 'secret', challenge: 'abc123' }, 'secret'), null);
  assert.equal(verifyWebhookChallenge({ mode: 'subscribe', token: 'secret', challenge: 'abc123' }, ''), null);
});

test('parseInboundMessage: extracts phoneNumberId/from/text from Meta\'s webhook shape; ignores non-text events', () => {
  const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, messages: [{ type: 'text', from: '233244000000', text: { body: 'IN' } }] } }] }] };
  assert.deepEqual(parseInboundMessage(payload), { phoneNumberId: 'pn1', from: '233244000000', text: 'IN' });
  assert.equal(parseInboundMessage({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, statuses: [{ status: 'delivered' }] } }] }] }), null);
  assert.equal(parseInboundMessage({}), null);
});

// ---- integration: /whatsapp/config, /whatsapp/send, /whatsapp/webhook routes ----
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

test('/whatsapp/config: only owner/admin can set or read it; the access token never comes back', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;

  assert.equal((await call('GET', '/whatsapp/config', null, o.token)).body.configured, false);
  assert.equal((await call('POST', '/whatsapp/config', { phoneNumberId: 'pn1', accessToken: 'tok1' }, s.token)).status, 403);

  const bad = await call('POST', '/whatsapp/config', { phoneNumberId: 'pn1' }, o.token);
  assert.equal(bad.status, 400);

  const ok = await call('POST', '/whatsapp/config', { phoneNumberId: 'pn1', accessToken: 'tok1', templateName: 'church_notice', templateLang: 'en_US' }, o.token);
  assert.equal(ok.status, 200);
  const read = await call('GET', '/whatsapp/config', null, o.token);
  assert.equal(read.body.configured, true);
  assert.equal(read.body.phoneNumberId, 'pn1');
  assert.equal(read.body.templateName, 'church_notice');
  assert.equal(JSON.stringify(read.body).includes('tok1'), false);
  assert.equal((await call('GET', '/whatsapp/config', null, s.token)).status, 403);
});

test('/whatsapp/send: dedupes shared numbers, skips members with no usable phone, requires a template, and is gated to owner/admin/secretary', async (t) => {
  const { call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  const t2 = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;

  await push(call, o.token, [
    ch('members', 'm1', { name: 'Ama', phone: '0244000001', ministryIds: ['youth'] }),
    ch('members', 'm2', { name: 'Kofi', phone: '0244000001', ministryIds: ['choir'] }), // shares Ama's phone
    ch('members', 'm3', { name: 'Esi', phone: '', ministryIds: ['youth'] }),
  ]);

  const notConfigured = await call('POST', '/whatsapp/send', { message: 'Service moved to 10am' }, o.token);
  assert.equal(notConfigured.status, 400);

  await call('POST', '/whatsapp/config', { phoneNumberId: 'pn1', accessToken: 'tok1' }, o.token); // no template yet
  const noTemplate = await call('POST', '/whatsapp/send', { message: 'Service moved to 10am' }, o.token);
  assert.equal(noTemplate.status, 400);
  assert.match(noTemplate.body.error, /template/i);

  await call('POST', '/whatsapp/config', { phoneNumberId: 'pn1', accessToken: 'tok1', templateName: 'church_notice', templateLang: 'en_US' }, o.token);
  assert.equal((await call('POST', '/whatsapp/send', { message: 'Hi' }, t2.token)).status, 403); // treasurer can't send

  let sentBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/pn1/messages')) { sentBodies.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.' + sentBodies.length }] }) }; }
    return originalFetch(url, opts);
  };
  try {
    const whole = await call('POST', '/whatsapp/send', { message: 'Harvest is this Sunday' }, o.token);
    assert.equal(whole.status, 200);
    assert.equal(whole.body.total, 3);
    assert.equal(whole.body.missing, 1); // Esi has a blank phone
    assert.equal(whole.body.sent, 1);    // one de-duped number (Ama & Kofi share it)
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0].to, '233244000001');
    assert.equal(sentBodies[0].template.components[0].parameters[0].text, 'Harvest is this Sunday');
  } finally { globalThis.fetch = originalFetch; }
});

test('/whatsapp/webhook: GET verification handshake answers only a matching token, with the raw challenge text', async (t) => {
  const { base } = await setup(t);
  const ok = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=dev-whatsapp-verify-token&hub.challenge=abc123`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'abc123');
  const bad = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`);
  assert.equal(bad.status, 403);
});

test('/whatsapp/webhook: POST — "IN" from a known member checks them into today\'s whole-church attendance and replies once; unrecognized numbers get no reply', async (t) => {
  const { base, call } = await setup(t);
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/whatsapp/config', { phoneNumberId: 'pn1', accessToken: 'tok1', checkinService: 'Sunday service' }, o.token);
  await push(call, o.token, [ch('members', 'm1', { name: 'Ama Mensah', phone: '0244000000' })]);

  const inbound = (from, text) => fetch(`${base}/whatsapp/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, messages: [{ type: 'text', from, text: { body: text } }] } }] }] }),
  });

  const sentTexts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/pn1/messages')) { sentTexts.push(JSON.parse(opts.body).text.body); return { ok: true, json: async () => ({}) }; }
    return originalFetch(url, opts);
  };
  try {
    const r1 = await inbound('233244000000', 'in');
    assert.equal(r1.status, 200);
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0], /checked in, Ama/);

    // replying again must not double-count or send a duplicate "just checked in" message
    await inbound('233244000000', 'IN');
    assert.equal(sentTexts.length, 2);
    assert.match(sentTexts[1], /already checked in/);

    // an unrecognized number gets no reply at all
    await inbound('233209999999', 'IN');
    assert.equal(sentTexts.length, 2);

    const known = await call('GET', '/whatsapp/config', null, o.token); // sanity: still configured after all this
    assert.equal(known.body.configured, true);

    const pulled = await call('GET', '/sync/pull?since=0', null, o.token);
    const att = pulled.body.changes.find((c) => c.collection === 'attendance');
    assert.deepEqual(att.data.presentIds, ['m1']);
    assert.equal(att.data.service, 'Sunday service');
  } finally { globalThis.fetch = originalFetch; }
});

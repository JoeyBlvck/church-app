import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

// sendPasswordResetEmailImpl stands in for a real Brevo send here (see server/src/email.js) — it just
// records the last message this test's server tried to send, so a test can pull the one-time
// token out of it exactly the way a real recipient would pull it out of their inbox.
async function setup() {
  const db = openDb();
  let lastEmail = null;
  const sendPasswordResetEmailImpl = async (msg) => { lastEmail = msg; };
  const server = createApp(db, { secret: 't', appUrl: 'https://app.test', sendPasswordResetEmailImpl });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const tokenFromLastEmail = () => new URL(lastEmail.resetUrl).searchParams.get('resetToken');
  return { server, call, tokenFromLastEmail, getLastEmail: () => lastEmail };
}

test('password reset: full round trip — request, use the emailed link, sign in with the new password', async () => {
  const { server, call, tokenFromLastEmail } = await setup();
  await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' });

  const r = await call('POST', '/auth/request-password-reset', { email: 'ama@x.org' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });

  const token = tokenFromLastEmail();
  assert.ok(token);

  const reset = await call('POST', '/auth/reset-password', { token, password: 'newpassword2' });
  assert.equal(reset.status, 200);

  assert.equal((await call('POST', '/auth/login', { email: 'ama@x.org', password: 'password1' })).status, 401);
  const login = await call('POST', '/auth/login', { email: 'ama@x.org', password: 'newpassword2' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.email, 'ama@x.org');
  server.close();
});

test('password reset: an unknown email still replies ok (no way to tell whether it has an account), and never sends an email', async () => {
  const { server, call, getLastEmail } = await setup();
  const r = await call('POST', '/auth/request-password-reset', { email: 'nobody@x.org' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(getLastEmail(), null);
  server.close();
});

test('password reset: a token can only be used once', async () => {
  const { server, call, tokenFromLastEmail } = await setup();
  await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' });
  await call('POST', '/auth/request-password-reset', { email: 'ama@x.org' });
  const token = tokenFromLastEmail();
  assert.equal((await call('POST', '/auth/reset-password', { token, password: 'newpassword2' })).status, 200);
  const second = await call('POST', '/auth/reset-password', { token, password: 'anotherpass3' });
  assert.equal(second.status, 400);
  server.close();
});

test('password reset: an invalid or made-up token is rejected', async () => {
  const { server, call } = await setup();
  const r = await call('POST', '/auth/reset-password', { token: 'not-a-real-token', password: 'newpassword2' });
  assert.equal(r.status, 400);
  server.close();
});

test('password reset: requesting a new link invalidates the previous one', async () => {
  const { server, call, tokenFromLastEmail } = await setup();
  await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' });
  await call('POST', '/auth/request-password-reset', { email: 'ama@x.org' });
  const firstToken = tokenFromLastEmail();
  await call('POST', '/auth/request-password-reset', { email: 'ama@x.org' });
  const secondToken = tokenFromLastEmail();
  assert.notEqual(firstToken, secondToken);
  assert.equal((await call('POST', '/auth/reset-password', { token: firstToken, password: 'newpassword2' })).status, 400);
  assert.equal((await call('POST', '/auth/reset-password', { token: secondToken, password: 'newpassword2' })).status, 200);
  server.close();
});

test('password reset: a short new password is rejected', async () => {
  const { server, call, tokenFromLastEmail } = await setup();
  await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' });
  await call('POST', '/auth/request-password-reset', { email: 'ama@x.org' });
  const token = tokenFromLastEmail();
  const r = await call('POST', '/auth/reset-password', { token, password: 'short' });
  assert.equal(r.status, 400);
  server.close();
});

test('password reset: a deactivated staff account cannot request a reset link', async () => {
  const { server, call, getLastEmail } = await setup();
  const owner = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' })).body;
  const staff = (await call('POST', '/users', { email: 'staff@x.org', name: 'Kofi', role: 'secretary', password: 'password1' }, owner.token)).body;
  await call('POST', '/users/update', { id: staff.id, active: false }, owner.token);
  const r = await call('POST', '/auth/request-password-reset', { email: 'staff@x.org' });
  assert.equal(r.status, 200); // still the same generic reply — never reveals the account is deactivated
  assert.equal(getLastEmail(), null);
  server.close();
});

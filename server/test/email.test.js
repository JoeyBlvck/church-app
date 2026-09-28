import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPasswordResetEmail, EmailConfigError } from '../src/email.js';

const prevKey = process.env.BREVO_API_KEY, prevFrom = process.env.EMAIL_FROM;
test.before(() => { process.env.BREVO_API_KEY = 'test-key'; process.env.EMAIL_FROM = 'noreply@x.org'; });
test.after(() => {
  if (prevKey !== undefined) process.env.BREVO_API_KEY = prevKey; else delete process.env.BREVO_API_KEY;
  if (prevFrom !== undefined) process.env.EMAIL_FROM = prevFrom; else delete process.env.EMAIL_FROM;
});

function fakeFetch(sent) {
  return async (url, opts) => {
    sent.url = url;
    sent.opts = opts;
    sent.body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({}) };
  };
}

test('sendPasswordResetEmail: posts to Brevo with the reset link and the recipient\'s name', async () => {
  const sent = {};
  await sendPasswordResetEmail(
    { to: 'ama@x.org', name: 'Ama', resetUrl: 'https://app.test/?resetToken=abc123' },
    { fetchImpl: fakeFetch(sent) },
  );
  assert.match(sent.url, /brevo\.com/);
  assert.equal(sent.opts.headers['api-key'], 'test-key');
  assert.equal(sent.body.to[0].email, 'ama@x.org');
  assert.match(sent.body.subject, /reset/i);
  assert.ok(sent.body.textContent.includes('https://app.test/?resetToken=abc123'));
  assert.ok(sent.body.htmlContent.includes('https://app.test/?resetToken=abc123'));
  assert.ok(sent.body.htmlContent.includes('Ama'));
});

test('sendPasswordResetEmail: still sends without a name (falls back to a plain greeting)', async () => {
  const sent = {};
  await sendPasswordResetEmail(
    { to: 'ama@x.org', resetUrl: 'https://app.test/?resetToken=abc123' },
    { fetchImpl: fakeFetch(sent) },
  );
  assert.ok(sent.body.textContent.startsWith('Hi,'));
});

test('sendPasswordResetEmail: escapes the recipient name in the HTML body', async () => {
  const sent = {};
  await sendPasswordResetEmail(
    { to: 'x@x.org', name: '<script>alert(1)</script>', resetUrl: 'https://app.test/?resetToken=abc' },
    { fetchImpl: fakeFetch(sent) },
  );
  assert.ok(!sent.body.htmlContent.includes('<script>'));
  assert.ok(sent.body.htmlContent.includes('&lt;script&gt;'));
});

test('sendPasswordResetEmail: throws a clear EmailConfigError when Brevo is not configured and no stub is given', async () => {
  const prevK = process.env.BREVO_API_KEY, prevF = process.env.EMAIL_FROM;
  delete process.env.BREVO_API_KEY; delete process.env.EMAIL_FROM;
  try {
    await assert.rejects(
      () => sendPasswordResetEmail({ to: 'ama@x.org', name: 'Ama', resetUrl: 'https://app.test/?resetToken=abc' }),
      EmailConfigError,
    );
  } finally {
    if (prevK !== undefined) process.env.BREVO_API_KEY = prevK; else delete process.env.BREVO_API_KEY;
    if (prevF !== undefined) process.env.EMAIL_FROM = prevF; else delete process.env.EMAIL_FROM;
  }
});

test('sendPasswordResetEmail: throws EmailConfigError when Brevo rejects the request', async () => {
  await assert.rejects(
    () => sendPasswordResetEmail(
      { to: 'ama@x.org', resetUrl: 'https://app.test/?resetToken=abc' },
      { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Key not found' }) }) },
    ),
    EmailConfigError,
  );
});

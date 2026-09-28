import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPasswordResetEmail, EmailConfigError } from '../src/email.js';

test('sendPasswordResetEmail: builds a message carrying the reset link and the recipient\'s name', async () => {
  let sent = null;
  await sendPasswordResetEmail(
    { to: 'ama@x.org', name: 'Ama', resetUrl: 'https://app.test/?resetToken=abc123' },
    { sendMailImpl: async (msg) => { sent = msg; } },
  );
  assert.equal(sent.to, 'ama@x.org');
  assert.match(sent.subject, /reset/i);
  assert.ok(sent.text.includes('https://app.test/?resetToken=abc123'));
  assert.ok(sent.html.includes('https://app.test/?resetToken=abc123'));
  assert.ok(sent.html.includes('Ama'));
});

test('sendPasswordResetEmail: still sends without a name (falls back to a plain greeting)', async () => {
  let sent = null;
  await sendPasswordResetEmail(
    { to: 'ama@x.org', resetUrl: 'https://app.test/?resetToken=abc123' },
    { sendMailImpl: async (msg) => { sent = msg; } },
  );
  assert.ok(sent.text.startsWith('Hi,'));
});

test('sendPasswordResetEmail: escapes the recipient name in the HTML body', async () => {
  let sent = null;
  await sendPasswordResetEmail(
    { to: 'x@x.org', name: '<script>alert(1)</script>', resetUrl: 'https://app.test/?resetToken=abc' },
    { sendMailImpl: async (msg) => { sent = msg; } },
  );
  assert.ok(!sent.html.includes('<script>'));
  assert.ok(sent.html.includes('&lt;script&gt;'));
});

test('sendPasswordResetEmail: throws a clear EmailConfigError when SMTP is not configured and no stub is given', async () => {
  const prevUser = process.env.SMTP_USER, prevPass = process.env.SMTP_PASS;
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  try {
    await assert.rejects(
      () => sendPasswordResetEmail({ to: 'ama@x.org', name: 'Ama', resetUrl: 'https://app.test/?resetToken=abc' }),
      EmailConfigError,
    );
  } finally {
    if (prevUser !== undefined) process.env.SMTP_USER = prevUser; else delete process.env.SMTP_USER;
    if (prevPass !== undefined) process.env.SMTP_PASS = prevPass; else delete process.env.SMTP_PASS;
  }
});

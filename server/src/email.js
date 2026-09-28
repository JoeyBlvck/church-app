// Password-reset emails. Sent over plain SMTP (server/src/smtp.js — a small dependency-free
// client this project writes and tests itself, in keeping with the rest of the server's
// zero-npm-dependency design) so this works with whatever mailbox the operator already has — a
// personal Gmail account plus an app password is enough to start (see README "Deploying") — rather
// than one of the REST-API providers (Resend, Brevo, SendGrid, ...) the rest of this app's
// integrations use (sms.js, paystack.js, whatsapp.js): every one of those requires a verified
// custom domain before it will send to an arbitrary recipient, which is a real blocker before a
// domain is bought.
//
// Configure with SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS (+ optional EMAIL_FROM/EMAIL_FROM_NAME);
// SMTP_HOST/SMTP_PORT default to Gmail's own server. Leave SMTP_USER/SMTP_PASS unset and this
// throws EmailConfigError — server/src/app.js catches that (and any other send failure) so a
// misconfigured or down mail server never changes the response a password-reset request gets.
import { sendMail, SmtpError } from './smtp.js';

export class EmailConfigError extends Error {}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// `sendMailImpl` is injectable (same DI pattern as sms.js's fetchImpl/paystack.js's fetchImpl) so
// tests — and server/src/app.js's own end-to-end tests — never need real SMTP credentials or a
// network call just to exercise the password-reset flow.
export async function sendPasswordResetEmail({ to, name, resetUrl }, { sendMailImpl } = {}) {
  const { SMTP_HOST = 'smtp.gmail.com', SMTP_PORT = '465', SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_FROM_NAME = 'The ChurchFlow' } = process.env;
  if (!sendMailImpl && (!SMTP_USER || !SMTP_PASS))
    throw new EmailConfigError('Email sending is not configured on this server (SMTP_USER/SMTP_PASS).');
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = `${greeting}\n\nSomeone (hopefully you) asked to reset the password on your ChurchFlow account.\n\n` +
    `Reset it here: ${resetUrl}\n\n` +
    `This link works once and expires in an hour. If you didn't ask for this, you can ignore this email — your password hasn't changed.`;
  const html = `<p>${escapeHtml(greeting)}</p>` +
    `<p>Someone (hopefully you) asked to reset the password on your ChurchFlow account.</p>` +
    `<p><a href="${resetUrl}">Click here to choose a new password</a>.</p>` +
    `<p>This link works once and expires in an hour. If you didn't ask for this, you can ignore this email — your password hasn't changed.</p>`;
  const from = `"${EMAIL_FROM_NAME}" <${EMAIL_FROM || SMTP_USER}>`;
  const send = sendMailImpl ?? ((msg) => sendMail({ host: SMTP_HOST, port: Number(SMTP_PORT), user: SMTP_USER, pass: SMTP_PASS, ...msg }));
  try {
    await send({ from, to, subject: 'Reset your ChurchFlow password', text, html });
  } catch (e) {
    // Wrap smtp.js's own error so callers (and their logs) always see a message that names what
    // actually happened, whether that's this module's own config check above or a protocol/
    // connection failure from smtp.js itself.
    throw e instanceof SmtpError ? new EmailConfigError(`Could not send email: ${e.message}`) : e;
  }
}

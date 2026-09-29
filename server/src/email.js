// Password-reset and account-setup emails, sent through Brevo's transactional email HTTP API
// (https://developers.brevo.com/reference/sendtransacemail — POST, `api-key` header, JSON body).
//
// This used to go out over raw SMTP to Gmail (server/src/smtp.js, since removed) — a
// dependency-free client this project wrote and tested itself, in keeping with the rest of the
// server's zero-npm-dependency design. That approach was sound in principle but doesn't work on
// Railway: Railway blocks outbound SMTP (ports 25/465/587) on every plan except Pro
// (https://docs.railway.com/networking/outbound-networking), so the connection attempt never
// even reaches Gmail — it just times out or is refused at the network level. Brevo's API runs
// over plain HTTPS (port 443, like every other integration in this file's neighbors — sms.js,
// paystack.js, whatsapp.js — already use), which no host blocks.
//
// Unlike most transactional-email providers (Resend, SendGrid, ...), Brevo lets a single sender
// address be verified with a one-time code sent to that inbox — no custom domain or DNS records
// needed — and its free tier (300 emails/day) is more than enough for a beta. See README
// "Deploying" for the two-step setup: create a Brevo account, verify one sender address, drop the
// API key in BREVO_API_KEY.
//
// Configure with BREVO_API_KEY (+ optional EMAIL_FROM/EMAIL_FROM_NAME — EMAIL_FROM must be the
// address verified as a Brevo sender). Leave BREVO_API_KEY unset and this throws
// EmailConfigError — server/src/app.js catches that (and any other send failure) so a
// misconfigured or down mail provider never changes the response a password-reset request (or an
// admin-console "add church") gets.
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';

export class EmailConfigError extends Error {}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared by sendPasswordResetEmail and sendWelcomeEmail below — both are just "here's a one-time
// link" emails with different wording, so this is the one place that actually talks to Brevo
// (config checks, the fetch call, error shapes). `fetchImpl` is injectable (same DI pattern as
// sms.js's fetchImpl/paystack.js's fetchImpl) so tests — and server/src/app.js's own end-to-end
// tests — never need a real Brevo account or a network call to exercise either flow.
async function sendViaBrevo({ to, name, subject, text, html }, { fetchImpl = fetch } = {}) {
  const { BREVO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME = 'The ChurchFlow' } = process.env;
  if (!BREVO_API_KEY) throw new EmailConfigError('Email sending is not configured on this server (BREVO_API_KEY).');
  if (!EMAIL_FROM) throw new EmailConfigError('Email sending is not configured on this server (EMAIL_FROM — must be a Brevo-verified sender address).');
  let res, json;
  try {
    res = await fetchImpl(BREVO_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
        to: [{ email: to, name: name || undefined }],
        subject, textContent: text, htmlContent: html,
      }),
    });
  } catch (e) {
    throw new EmailConfigError(`Could not reach Brevo: ${e.message}`);
  }
  if (!res.ok) {
    json = await res.json().catch(() => ({}));
    throw new EmailConfigError(`Brevo rejected the email: HTTP ${res.status} ${json.message || json.code || ''}`.trim());
  }
}

export async function sendPasswordResetEmail({ to, name, resetUrl }, opts = {}) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = `${greeting}\n\nSomeone (hopefully you) asked to reset the password on your ChurchFlow account.\n\n` +
    `Reset it here: ${resetUrl}\n\n` +
    `This link works once and expires in an hour. If you didn't ask for this, you can ignore this email — your password hasn't changed.`;
  const html = `<p>${escapeHtml(greeting)}</p>` +
    `<p>Someone (hopefully you) asked to reset the password on your ChurchFlow account.</p>` +
    `<p><a href="${resetUrl}">Click here to choose a new password</a>.</p>` +
    `<p>This link works once and expires in an hour. If you didn't ask for this, you can ignore this email — your password hasn't changed.</p>`;
  await sendViaBrevo({ to, name, subject: 'Reset your ChurchFlow password', text, html }, opts);
}

// Sent when the platform admin console creates a new church on someone's behalf (POST
// /admin/tenants/create) — the operator only ever enters the owner's name and email, never a
// password: this is the invite that lets the owner set their own. Reuses the exact same
// one-time-link mechanism as a password reset (server/src/app.js's issueResetToken +
// POST /auth/reset-password), just with different wording, since "set a password with a link
// only you received by email" is the same proof either way.
export async function sendWelcomeEmail({ to, name, churchName, setupUrl }, opts = {}) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = `${greeting}\n\nA ChurchFlow account has been set up for ${churchName}, with you as the owner.\n\n` +
    `Choose your password here: ${setupUrl}\n\n` +
    `This link works once and expires in an hour. If anything looks off, just reply to this email.`;
  const html = `<p>${escapeHtml(greeting)}</p>` +
    `<p>A ChurchFlow account has been set up for <b>${escapeHtml(churchName)}</b>, with you as the owner.</p>` +
    `<p><a href="${setupUrl}">Click here to choose your password</a> and sign in.</p>` +
    `<p>This link works once and expires in an hour. If anything looks off, just reply to this email.</p>`;
  await sendViaBrevo({ to, name, subject: `Set up your ChurchFlow account for ${churchName}`, text, html }, opts);
}

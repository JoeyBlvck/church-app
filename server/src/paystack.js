// Paystack integration for online mobile money / card giving (Ghana: MTN MoMo, Telecel Cash,
// AirtelTigo, or card). Each church connects its OWN Paystack account (its own secret/public
// key pair, saved via POST /paystack/config — see server/src/app.js) — a successful gift is
// paid straight into that church's own Paystack balance, never pooled through this app's own
// account, the same way server/src/sms.js keeps each church's own Arkesel key server-side only.
// Overridable via PAYSTACK_URL for local/staging testing against a fake endpoint; production
// deployments should leave it unset and get the real Paystack API.
import { createHmac, timingSafeEqual } from 'node:crypto';

const PAYSTACK_URL = process.env.PAYSTACK_URL || 'https://api.paystack.co';

export class PaystackConfigError extends Error {}

// Paystack expects the smallest currency unit (pesewas for GHS, i.e. amount * 100); everywhere
// else in this app (finance.js, the transactions ledger) an "amount" is the ordinary major-unit
// figure a person would type in, e.g. 50 for GHS 50 — so that conversion happens only here, at
// the boundary, never stored anywhere.
const toSubunit = (amount) => Math.round(amount * 100);

// Starts a checkout: returns the authorization_url the giving page redirects the donor to.
// `email` is required by Paystack even when the donor only gave a phone number — callers pass a
// synthesized placeholder in that case (see app.js).
export async function initializeTransaction(
  { secretKey, email, amount, currency = 'GHS', reference, callbackUrl, metadata },
  { fetchImpl = fetch } = {},
) {
  if (!secretKey) throw new PaystackConfigError('Online giving is not set up for this church yet.');
  const res = await fetchImpl(`${PAYSTACK_URL}/transaction/initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
    body: JSON.stringify({
      email, amount: toSubunit(amount), currency, reference, callback_url: callbackUrl,
      channels: currency === 'GHS' ? ['mobile_money', 'card'] : undefined, metadata,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) throw new Error(json.message || `Paystack returned HTTP ${res.status}`);
  return json.data; // { authorization_url, access_code, reference }
}

// Confirms what actually happened to a reference, straight from Paystack — never trust a
// client-reported "it worked" or even a webhook payload's own amount/status without this,
// since both are values an attacker could otherwise forge.
export async function verifyTransaction({ secretKey, reference }, { fetchImpl = fetch } = {}) {
  if (!secretKey) throw new PaystackConfigError('Online giving is not set up for this church yet.');
  const res = await fetchImpl(`${PAYSTACK_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) throw new Error(json.message || `Paystack returned HTTP ${res.status}`);
  return json.data; // { status: 'success'|'failed'|..., amount (subunits), currency, channel, reference, ... }
}

// Paystack signs each webhook body with HMAC-SHA512 of the exact raw request bytes, keyed by
// the SAME secret key used to create the transaction — since this is a multi-tenant app with a
// different secret key per church, the caller must already know which tenant a webhook claims
// to be for (by reading its unverified reference and looking up the giving_intents row) before
// it can pick the right key to check the signature against.
export function verifySignature(secretKey, rawBody, signatureHeader) {
  if (!secretKey || !signatureHeader) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(String(signatureHeader), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

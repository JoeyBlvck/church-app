// WhatsApp Business API integration (broadcast notices + check-in-by-reply). Each church connects
// its OWN WhatsApp Business API access — a phone number ID + access token, either straight from
// Meta (developers.facebook.com, after completing Meta Business Verification) or through a BSP
// such as Arkesel acting as the go-between — the same "bring your own account" pattern this app
// already uses for SMS (server/src/sms.js) and Paystack (server/src/paystack.js): Church Manager
// never sends on a church's behalf through a shared number, so there's no per-message cost or
// compliance burden on Joey Studios.
//
// The request shape below (POST {baseUrl}/{phoneNumberId}/messages, Bearer token, a
// `messaging_product`/`to`/`template-or-text` JSON body) is Meta's own documented WhatsApp Cloud
// API shape; a BSP that proxies the Cloud API (Arkesel included, per its own developer guide)
// takes the same shape at its own base URL, which is why `baseUrl` is configurable per tenant
// (server/src/app.js's /whatsapp/config) rather than hard-coded to graph.facebook.com.
const DEFAULT_BASE_URL = 'https://graph.facebook.com/v20.0';

export class WhatsAppConfigError extends Error {}

async function post(baseUrl, phoneNumberId, accessToken, body, { fetchImpl = fetch } = {}) {
  if (!phoneNumberId || !accessToken) throw new WhatsAppConfigError('WhatsApp is not set up for this church yet — connect it under Settings.');
  const res = await fetchImpl(`${baseUrl || DEFAULT_BASE_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `WhatsApp API returned HTTP ${res.status}`);
  return json;
}

// A broadcast/notice: outside the 24-hour customer-service window (i.e. the recipient hasn't
// messaged the church's WhatsApp number recently), Meta requires a pre-approved message
// template — free text is rejected. `templateName`/`templateLang` are whatever the church had
// approved in Meta Business Manager; the notice's own text fills that template's one body
// variable, so a church only ever needs one simple single-variable template approved once
// (e.g. named "church_notice", body "{{1}}") to send any future notice through it.
export async function sendTemplateMessage({ baseUrl, phoneNumberId, accessToken, to, templateName, templateLang = 'en_US', bodyText }, opts) {
  if (!templateName) throw new WhatsAppConfigError('No WhatsApp template is set for this church yet — add one under Settings.');
  return post(baseUrl, phoneNumberId, accessToken, {
    to, type: 'template',
    template: { name: templateName, language: { code: templateLang }, components: [{ type: 'body', parameters: [{ type: 'text', text: bodyText }] }] },
  }, opts);
}

// A free-form reply: only valid within 24 hours of the recipient's own last message — used here
// for the automatic "you're checked in" / "text IN to check in" reply to an inbound message
// (server/src/app.js's POST /whatsapp/webhook), which is always well inside that window since
// it's a direct reply to a message that just arrived.
export function sendTextMessage({ baseUrl, phoneNumberId, accessToken, to, text }, opts) {
  return post(baseUrl, phoneNumberId, accessToken, { to, type: 'text', text: { body: text } }, opts);
}

// The one-time handshake Meta makes against a newly configured webhook URL (a GET request with
// hub.mode=subscribe, hub.verify_token, hub.challenge) — it must be answered with the raw
// challenge string, not JSON, and only when the token matches what the church was told to enter
// in their own Meta App's webhook settings. One shared token for the whole app (not per-tenant):
// it only proves this server owns the endpoint, it carries no tenant-identifying information
// either way (see server/src/app.js for how an inbound event is actually routed to a tenant, by
// the phone_number_id already stored on that tenant's own row).
export function verifyWebhookChallenge({ mode, token, challenge }, expectedToken) {
  if (mode === 'subscribe' && expectedToken && token === expectedToken) return challenge;
  return null;
}

// Pulls out the handful of fields server/src/app.js's webhook route actually needs from Meta's
// (verbose, deeply nested) webhook payload shape. Returns null for a payload that isn't a
// user-sent text message (status updates, media messages, etc. are ignored in v1).
export function parseInboundMessage(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg || msg.type !== 'text') return null;
  return { phoneNumberId: value?.metadata?.phone_number_id ?? null, from: msg.from, text: msg.text?.body ?? '' };
}

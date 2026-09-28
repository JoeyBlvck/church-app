// Arkesel bulk SMS integration (https://sms.arkesel.com/api/v2/sms/send — POST, `api-key`
// header, JSON body { sender, message, recipients: [...] }). The API key/sender ID live only
// in the tenants table (server/src/db.js), never synced to client devices via the generic
// records/settings collection, so this module is only ever called from server/src/app.js.
// Overridable via ARKESEL_URL for local/staging testing against a fake endpoint; production
// deployments should leave it unset and get the real Arkesel API.
const ARKESEL_URL = process.env.ARKESEL_URL || 'https://sms.arkesel.com/api/v2/sms/send';
const BATCH_SIZE = 100; // conservative — Arkesel doesn't publish a documented per-request cap

// Ghana-first phone normalization: turns a locally-entered number ("024 400 0000",
// "0244000000") or one already in international shape ("+233244000000", "233244000000")
// into the digits-only international form Arkesel's `recipients` array expects
// ("233244000000"). Returns null for anything that doesn't look like a plausible Ghanaian
// mobile number, so callers can count/skip those rather than sending garbage to the API.
export function normalizeGhanaPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('233') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`;
  if (digits.length === 9) return `233${digits}`; // e.g. pasted without the leading 0
  return null;
}

export class SmsConfigError extends Error {}

// Sends `message` to every (already normalized, deduplicated) number in `recipients`,
// chunking into batches of BATCH_SIZE. Best-effort per batch: a batch either counts as fully
// sent or fully failed (Arkesel's response doesn't give per-recipient status), and every
// batch is attempted even if an earlier one failed — a temporary hiccup on one batch
// shouldn't stop the rest of the church from getting the notice. `fetchImpl` is injectable so
// tests can stub the network call instead of hitting the real Arkesel API.
export async function sendSms({ apiKey, senderId, recipients, message }, { fetchImpl = fetch } = {}) {
  if (!apiKey || !senderId) throw new SmsConfigError('SMS is not set up for this church yet — add an Arkesel API key and sender ID under Settings.');
  const errors = [];
  let sent = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetchImpl(ARKESEL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ sender: senderId, message, recipients: batch }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || (json.status && json.status !== 'success')) {
        errors.push(json.message || json.error || `Arkesel returned HTTP ${res.status}`);
        continue;
      }
      sent += batch.length;
    } catch (e) {
      errors.push(e.message || 'Could not reach Arkesel.');
    }
  }
  return { sent, failed: recipients.length - sent, errors };
}

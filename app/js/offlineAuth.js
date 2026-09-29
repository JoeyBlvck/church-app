// Lets someone sign back in with no internet at all, by checking their password against a
// locally-saved copy instead of asking the server. The real password is never stored anywhere —
// only a salted PBKDF2 hash (the same one-way approach a real server uses for its own password
// column), kept on this device only, refreshed every time this account signs in online or
// changes its password. This can't lock someone out after repeated wrong guesses the way the
// real server does — there's no server to ask while offline — so it trades a little of that
// protection for being able to open the app with zero signal. Reasonable as long as staff pick
// real passwords; if a device with this saved is lost, treat it like any other lost device with
// a saved password (change that account's password once back online).

const ITERATIONS = 200_000;

function toB64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function fromB64(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
const credKey = (email) => `cred:${email.trim().toLowerCase()}`;

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toB64(new Uint8Array(bits));
}

// Constant-time-ish string compare — the hash is already stored locally in plain sight, so this
// mainly guards against a lazy '===' timing quirk rather than a realistic remote attack.
function sameHash(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Called after every successful ONLINE login, registration, and password change, so this
// device's saved copy always matches the account's current password.
export async function rememberOfflineCredential(store, email, password, session) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  await store.setMeta(credKey(email), {
    salt: toB64(salt), hash, iterations: ITERATIONS,
    token: session.token, user: session.user, savedAt: Date.now(),
  });
}

// Verifies a password against this device's saved copy for that email, with no network
// involved. Returns the cached {token, user} to restore the session on success, or null if
// there's no saved copy for that email or the password doesn't match it.
export async function checkOfflineCredential(store, email, password) {
  const rec = await store.getMeta(credKey(email));
  if (!rec) return null;
  const hash = await derive(password, fromB64(rec.salt), rec.iterations);
  return sameHash(hash, rec.hash) ? rec : null;
}

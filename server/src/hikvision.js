// Hikvision ISAPI client for pulling attendance (access-control) events off a clock-in
// terminal on the local network, plus the pure logic for turning those events into
// attendance data. Kept dependency-free and framework-agnostic like the rest of the app.
//
// Hikvision terminals speak ISAPI (their standard third-party integration protocol) over
// plain HTTP, protected by HTTP Digest authentication (RFC 2617) by default. This module
// implements just enough of Digest to call one endpoint: the access-control event search,
// which returns each face/fingerprint/card verification as a JSON record.
//
// NOTE ON FIELD NAMES: the request/response shapes below follow Hikvision's publicly
// documented ISAPI AcsEvent schema, which is consistent across most access-control and
// time-attendance terminals. Firmware does vary a little between models. Use `probe()`
// (see hikvision-bridge.js --probe) against your actual device once you have it, and if
// any field name differs, adjust EVENT_FIELDS below rather than rewriting the module.

import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');

// ---- HTTP Digest authentication (RFC 2617) ----
// Hikvision devices reject the first request with 401 + WWW-Authenticate, then accept a
// second request carrying a computed Authorization header. This is that round trip.
export function parseWwwAuthenticate(header) {
  const out = {};
  for (const m of String(header ?? '').matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

export function digestAuthorization({ method, uri, username, password, challenge, cnonce = randomBytes(8).toString('hex'), nc = '00000001' }) {
  const { realm, nonce, qop, opaque } = challenge;
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

// One digest-authenticated request: try plain, retry with auth on a 401 challenge.
export async function digestRequest({ baseUrl, path, method = 'GET', body, username, password, fetchImpl = globalThis.fetch }) {
  const url = baseUrl.replace(/\/$/, '') + path;
  const init = { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined };
  let res = await fetchImpl(url, init);
  if (res.status === 401) {
    const challenge = parseWwwAuthenticate(res.headers.get('www-authenticate'));
    if (!challenge.nonce) throw new Error('device did not send a usable digest challenge');
    const auth = digestAuthorization({ method, uri: path, username, password, challenge });
    res = await fetchImpl(url, { ...init, headers: { ...init.headers, authorization: auth } });
  }
  if (!res.ok) throw Object.assign(new Error(`device HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// ---- AcsEvent search: pull check-in/out events for a time window, paginated ----
const PAGE_SIZE = 30, MAX_PAGES = 50; // 1500 events per poll is far beyond what one church needs

export async function fetchAcsEvents({ baseUrl, username, password, startTime, endTime, fetchImpl = globalThis.fetch }) {
  const events = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await digestRequest({
      baseUrl, path: '/ISAPI/AccessControl/AcsEvent?format=json', method: 'POST', username, password, fetchImpl,
      body: { AcsEventCond: { searchID: randomBytes(8).toString('hex'), searchResultPosition: page * PAGE_SIZE, maxResults: PAGE_SIZE, startTime, endTime } },
    });
    const batch = parseAcsEvents(json);
    events.push(...batch);
    const total = json?.AcsEvent?.numOfMatches ?? json?.AcsEvent?.totalMatches ?? batch.length;
    if (batch.length < PAGE_SIZE || events.length >= total) break;
  }
  return events;
}

// Pure: normalize one page of the device's response into plain check-in events.
// Defensive about shape so a firmware quirk degrades gracefully instead of throwing.
export function parseAcsEvents(json) {
  const list = json?.AcsEvent?.InfoList ?? json?.InfoList ?? [];
  return list
    .map((item) => ({
      deviceUserId: item.employeeNoString ?? (item.employeeNo != null ? String(item.employeeNo) : undefined),
      time: item.time,
      name: item.name,
    }))
    .filter((e) => e.deviceUserId && e.time);
}

// Pure: turn a batch of events into the member IDs to mark present, plus whatever device
// IDs didn't match a known member (surfaced so the office can link them — see README).
export function matchEventsToMembers(events, members) {
  const byDeviceId = new Map(members.filter((m) => m.deviceUserId).map((m) => [String(m.deviceUserId), m]));
  const presentIds = new Set(), unmatched = new Set();
  for (const e of events) {
    const m = byDeviceId.get(String(e.deviceUserId));
    if (m) presentIds.add(m.id); else unmatched.add(e.deviceUserId);
  }
  return { presentIds: [...presentIds], unmatched: [...unmatched] };
}

// ---- UserInfo search: pull the device's enrolled-person list (name + person/employee
// number), paginated the same way AcsEvent search is. Used by the "pull enrolled users"
// feature (app/serve.js → app/js/views/settings.js), which turns the result into a
// spreadsheet for staff to review before it creates any member — this module never
// creates members itself.
//
// NOTE ON FIELD NAMES: as with AcsEvent above, this follows Hikvision's publicly documented
// ISAPI UserInfo/Search schema, but firmware varies a little by model — verify against your
// actual device (see the README's "Hikvision clock-in integration" section) before relying
// on the exact field names (`employeeNo`, `name`) if anything looks off.
export async function fetchEnrolledUsers({ baseUrl, username, password, fetchImpl = globalThis.fetch }) {
  const users = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await digestRequest({
      baseUrl, path: '/ISAPI/AccessControl/UserInfo/Search?format=json', method: 'POST', username, password, fetchImpl,
      body: { UserInfoSearchCond: { searchID: randomBytes(8).toString('hex'), searchResultPosition: page * PAGE_SIZE, maxResults: PAGE_SIZE } },
    });
    const batch = parseUserInfoSearch(json);
    users.push(...batch);
    const total = json?.UserInfoSearch?.numOfMatches ?? json?.UserInfoSearch?.totalMatches ?? batch.length;
    if (batch.length < PAGE_SIZE || users.length >= total) break;
  }
  return users;
}

// Pure: normalize one page of the device's enrolled-user response. Defensive about shape —
// a record with no person number is dropped (there's nothing to match it by), a missing
// name just comes through blank so staff can fill it in on the spreadsheet.
export function parseUserInfoSearch(json) {
  const list = json?.UserInfoSearch?.UserInfo ?? json?.UserInfo ?? [];
  return list
    .map((item) => ({
      deviceUserId: item.employeeNo != null ? String(item.employeeNo) : undefined,
      name: item.name ?? '',
    }))
    .filter((u) => u.deviceUserId);
}

// The clock-in device, built into the offline edition. The church PC and the Hikvision terminal sit
// on the same network (no internet needed), so the server asks the device for new scans itself every
// 30 seconds and files them as attendance -- no second program, no staff login for a bridge, no
// spreadsheet to carry over. This is the same logic as server/hikvision-bridge.js (which stays for
// the hosted/cloud edition), but writing straight into this computer's own database.
//
// Only started in the offline edition (see index.js). Settings live in DATA_DIR/clockin.json (the
// device password is kept there and never sent back to the browser); "where we got up to" lives in
// DATA_DIR/clockin-state.json.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetchAcsEvents, fetchEnrolledUsers, matchEventsToMembers } from './hikvision.js';
import { ministryOf } from './permissions.js';
// In the packaged app these two sit at local-server/app/js (scripts/prepare-offline.mjs copies them).
import { attendanceTargetForDay, mergeArrivals, parseClockMinutes, serviceStartFor } from '../../app/js/importers.js';

const pad = (n) => String(n).padStart(2, '0');
// The device wants a bare "YYYY-MM-DDTHH:mm:ss" in its own wall-clock time; the PC and the device are
// in the same place, so the PC's local time is the right thing to send.
export const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const OVERLAP_MS = 10 * 60_000;   // re-ask for the last 10 minutes each time: covers a device clock a little behind the PC
const MAX_LOOKBACK_DAYS = 7;       // after the PC was off for a while, catch up this far and no further

// "192.168.1.50", "192.168.1.50:8080" or "http://192.168.1.50/" -> "http://192.168.1.50:8080". Only
// http/https; anything else (or nonsense) throws a message fit to show the person typing it.
export function normalizeHost(value) {
  let s = String(value ?? '').trim();
  if (!s) throw new Error('Enter the device address, like 192.168.1.50.');
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That address does not look right. It should be something like 192.168.1.50.'); }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) throw new Error('That address does not look right. It should be something like 192.168.1.50.');
  return u.origin;
}

// What went wrong, in words the person at the church can act on.
export function friendlyError(e, host = '') {
  const m = String(e?.message ?? e);
  if (e?.status === 401 || /HTTP 401/.test(m)) return 'The device refused the username or password. Use the login you use on the device\'s own web page.';
  if (e?.status === 404 || /HTTP 404/.test(m)) return 'Something answered at that address, but it is not a clock-in device. The device may have a new address; use "Find my device".';
  if (/digest challenge/.test(m)) return 'Something answered at that address, but it is not a clock-in device. The device may have a new address; use "Find my device".';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed? ?out/i.test(m)) return `The device${host ? ` at ${host}` : ''} did not answer. Check that it is switched on and on the same network as this computer.`;
  if (/fetch failed|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ECONNRESET/i.test(m + (e?.cause?.code ?? '')))
    return `This computer cannot reach the device${host ? ` at ${host}` : ''}. Check that it is switched on and on the same network, and that the address is right.`;
  return `The device gave an unexpected answer (${m}).`;
}

export function createClockIn({ db, dataDir, fetchImpl = globalThis.fetch, now = () => new Date(), pollTimeoutMs = 8000, log = () => {} }) {
  const configPath = path.join(dataDir, 'clockin.json');
  const statePath = path.join(dataDir, 'clockin-state.json');
  const withTimeout = (ms) => (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });

  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  const writeJson = (p, v, mode) => { const tmp = `${p}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode }); fs.renameSync(tmp, p); };

  const readConfig = () => ({ enabled: false, host: '', username: 'admin', password: '', pollSeconds: 30, sundayService: '', ...readJson(configPath, {}) });
  const status = { lastPollAt: null, lastOk: null, lastError: null, lastRecorded: 0, lastRecordedAt: null, unmatched: [], skippedDays: [] };

  const q = {
    tenant: db.prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1'),
    all: db.prepare('SELECT id, data FROM records WHERE tenant_id = ? AND collection = ? AND deleted = 0'),
    bump: db.prepare('UPDATE tenants SET seq = seq + 1 WHERE id = ? RETURNING seq'),
    upsert: db.prepare(`INSERT INTO records (tenant_id, collection, id, data, updated_at, deleted, seq, ministry_id)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, collection, id) DO UPDATE SET
        data=excluded.data, updated_at=excluded.updated_at, deleted=excluded.deleted,
        seq=excluded.seq, ministry_id=excluded.ministry_id`),
  };
  const list = (tid, collection) => q.all.all(tid, collection).map((r) => ({ ...JSON.parse(r.data), id: r.id }));

  function publicConfig() {
    const c = readConfig();
    return { enabled: !!c.enabled, host: c.host, username: c.username, hasPassword: !!c.password, pollSeconds: c.pollSeconds, sundayService: c.sundayService };
  }

  function setConfig(body = {}) {
    const c = readConfig();
    if (body.host !== undefined) c.host = String(body.host).trim() ? normalizeHost(body.host) : '';
    if (body.username !== undefined) c.username = String(body.username).trim();
    if (body.password) c.password = String(body.password);              // blank = keep the saved one
    if (body.sundayService !== undefined) c.sundayService = String(body.sundayService).trim();
    if (body.pollSeconds !== undefined) c.pollSeconds = Math.min(600, Math.max(10, Number(body.pollSeconds) || 30));
    if (body.enabled !== undefined) c.enabled = !!body.enabled;
    if (c.enabled && (!c.host || !c.username || !c.password)) throw new Error('Fill in the device address, username and password before switching it on.');
    writeJson(configPath, c, 0o600);
    restart();
    return publicConfig();
  }

  // Checks the address and login with a real, tiny request: "scans in the last hour". Uses what was
  // typed (falling back to what is saved) without saving anything.
  async function test(body = {}) {
    const c = readConfig();
    const host = normalizeHost(body.host || c.host);
    const username = (body.username ?? c.username) || '';
    const password = body.password || c.password;
    if (!username || !password) throw new Error('Enter the device username and password.');
    const end = now();
    try {
      const events = await fetchAcsEvents({ baseUrl: host, username, password, startTime: localStamp(new Date(end.getTime() - 3_600_000)), endTime: localStamp(end), fetchImpl: withTimeout(pollTimeoutMs) });
      return { ok: true, host, scansLastHour: events.length };
    } catch (e) { return { ok: false, host, error: friendlyError(e, host) }; }
  }

  // The people enrolled on the device (name + device number), so the office can turn them into members.
  async function enrolledUsers() {
    const c = readConfig();
    if (!c.host || !c.username || !c.password) throw new Error('Set up and save the clock-in device first.');
    try { return await fetchEnrolledUsers({ baseUrl: c.host, username: c.username, password: c.password, fetchImpl: withTimeout(pollTimeoutMs) }); }
    catch (e) { throw new Error(friendlyError(e, c.host)); }
  }

  // One poll: ask the device for scans since last time, file each day's scans as attendance.
  async function pollOnce() {
    const c = readConfig();
    if (!c.host || !c.username || !c.password) throw new Error('The clock-in device is not set up yet.');
    const t = now();
    status.lastPollAt = t.getTime();
    const tid = q.tenant.get()?.id;
    if (!tid) return { recorded: 0 };                                   // no church set up yet
    const floor = startOfDay(new Date(t.getTime() - MAX_LOOKBACK_DAYS * 86_400_000));
    const saved = readJson(statePath, {}).since;
    let from = saved ? new Date(Math.max(new Date(saved).getTime() - OVERLAP_MS, floor.getTime())) : startOfDay(t);
    if (Number.isNaN(from.getTime())) from = startOfDay(t);

    const events = await fetchAcsEvents({ baseUrl: c.host, username: c.username, password: c.password, startTime: localStamp(from), endTime: localStamp(t), fetchImpl: withTimeout(pollTimeoutMs) });
    let recorded = 0;
    const unmatched = new Set(), skippedDays = new Set();
    if (events.length) {
      const members = list(tid, 'members');
      const ministries = list(tid, 'ministries');
      const cs = list(tid, 'settings').find((x) => x.id === 'church') ?? {};
      const byDay = new Map();
      for (const e of events) { const d = String(e.time).slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e); }
      db.exec('BEGIN');
      try {
        for (const [date, dayEvents] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
          const target = attendanceTargetForDay(date, ministries, { sundayService: c.sundayService || 'Sunday service' });
          const { presentIds, unmatched: um, arrivals } = matchEventsToMembers(dayEvents, members);
          um.forEach((x) => unmatched.add(x));
          if (!presentIds.length) continue;
          if (!target) { skippedDays.add(date); continue; }             // no service/meeting that day
          const { service, ministryId } = target;
          const existing = list(tid, 'attendance').find((a) => a.date === date && a.service === service && (a.ministryId ?? undefined) === ministryId);
          const firsts = arrivals.map(({ id, times }) => {
            const mins = times.map(parseClockMinutes).filter((n) => n != null);
            return { id, minutes: mins.length ? Math.min(...mins) : null };
          });
          const lists = mergeArrivals(existing, firsts, { start: serviceStartFor(date, cs.serviceTimes), graceMinutes: cs.lateGraceMinutes ?? 30 });
          const unchanged = existing && ['presentIds', 'lateIds', 'excusedIds'].every((k) => JSON.stringify(existing[k] ?? []) === JSON.stringify(lists[k]));
          if (unchanged) continue;
          const rec = { ...existing, id: existing?.id ?? randomUUID(), date, service, ministryId, ...lists };
          const { seq } = q.bump.get(tid);
          q.upsert.run(tid, 'attendance', rec.id, JSON.stringify(rec), Date.now(), 0, seq, ministryOf('attendance', rec) ?? null);
          recorded += presentIds.filter((id) => !(existing?.presentIds ?? []).includes(id) && !(existing?.lateIds ?? []).includes(id)).length;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    writeJson(statePath, { since: localStamp(t) });
    status.lastOk = t.getTime();
    status.lastError = null;
    status.unmatched = [...unmatched];
    status.skippedDays = [...skippedDays];
    if (recorded) { status.lastRecorded = recorded; status.lastRecordedAt = t.getTime(); }
    return { recorded };
  }

  // The background loop. Errors never stop it (a device that is switched off overnight just shows as
  // "can't reach the device" until morning); they are remembered for the Settings card to show.
  let timer = null, running = false, stopped = true;
  async function tick() {
    if (running) return;
    running = true;
    try { await pollOnce(); }
    catch (e) { status.lastError = friendlyError(e, readConfig().host); log(`clock-in poll failed: ${e.message}`); }
    finally { running = false; }
  }
  function schedule() {
    if (stopped) return;
    const c = readConfig();
    timer = setTimeout(async () => { await tick(); schedule(); }, (c.pollSeconds || 30) * 1000);
    timer.unref?.();
  }
  function start() {
    stopped = false;
    clearTimeout(timer);
    const c = readConfig();
    if (!c.enabled || !c.host) return;
    tick().finally(schedule);
  }
  function stop() { stopped = true; clearTimeout(timer); }
  function restart() { stop(); start(); }

  async function pollNow() { await tick(); return getStatus(); }

  function getStatus() {
    const c = readConfig();
    return { ...publicConfig(), configured: !!(c.host && c.username && c.password), ...status };
  }

  return { start, stop, getConfig: publicConfig, setConfig, test, enrolledUsers, pollNow, status: getStatus, pollOnce };
}

// "Find my device": looks at every address on this computer's own network(s) for something that
// answers like a Hikvision terminal (a Digest login challenge on its ISAPI address). Only private
// networks, and only the /24 the computer is on (254 quick look-ups).
export async function findDevices({ fetchImpl = globalThis.fetch, interfaces = os.networkInterfaces(), timeoutMs = 1200, concurrency = 64 } = {}) {
  const bases = new Set();
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (!(x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31))) continue;
      bases.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  const ips = [...bases].flatMap((b) => Array.from({ length: 254 }, (_, i) => `${b}.${i + 1}`));
  const found = [];
  let next = 0;
  async function worker() {
    while (next < ips.length) {
      const ip = ips[next++];
      try {
        const res = await fetchImpl(`http://${ip}/ISAPI/System/deviceInfo`, { signal: AbortSignal.timeout(timeoutMs) });
        const www = res.headers.get('www-authenticate') ?? '';
        if (res.status === 401 && /digest/i.test(www)) found.push({ ip, host: `http://${ip}`, realm: /realm="([^"]*)"/i.exec(www)?.[1] ?? '' });
      } catch { /* nothing there */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  return found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

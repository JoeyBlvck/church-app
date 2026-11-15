import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createClockIn, normalizeHost, friendlyError, findDevices } from '../src/clockin.js';

// 2026-11-15 is a Sunday, 2026-11-16 a Monday.
const SUNDAY = '2026-11-15', MONDAY = '2026-11-16';
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0);

function fakeDevice(getEvents) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const events = getEvents();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ AcsEvent: { totalMatches: events.length, InfoList: events } }));
    });
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

function setup({ now = () => at(2026, 11, 15, 10, 0), fetchImpl } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchflow-ci-'));
  const db = openDb(':memory:');
  db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?,?,?)').run('t1', 'Grace', 1);
  const put = (collection, rec) => {
    const { seq } = db.prepare('UPDATE tenants SET seq = seq + 1 WHERE id = ? RETURNING seq').get('t1');
    db.prepare('INSERT INTO records (tenant_id, collection, id, data, updated_at, deleted, seq, ministry_id) VALUES (?,?,?,?,?,0,?,NULL)')
      .run('t1', collection, rec.id, JSON.stringify(rec), 1, seq);
  };
  const all = (collection) => db.prepare('SELECT data FROM records WHERE tenant_id = ? AND collection = ? AND deleted = 0').all('t1', collection).map((r) => JSON.parse(r.data));
  const tenantSeq = () => db.prepare('SELECT seq FROM tenants WHERE id = ?').get('t1').seq;
  const ci = createClockIn({ db, dataDir, now, fetchImpl });
  return { dataDir, db, put, all, tenantSeq, ci };
}

test('normalizeHost: accepts a bare IP, adds http://, drops paths, refuses other schemes', () => {
  assert.equal(normalizeHost('192.168.1.50'), 'http://192.168.1.50');
  assert.equal(normalizeHost(' http://192.168.1.50:8080/ISAPI '), 'http://192.168.1.50:8080');
  assert.throws(() => normalizeHost(''), /device address/);
  assert.throws(() => normalizeHost('ftp://192.168.1.50'), /does not look right/);
});

test('friendlyError: names the likely cause in plain words', () => {
  assert.match(friendlyError({ status: 401, message: 'device HTTP 401' }), /username or password/);
  assert.match(friendlyError({ status: 404, message: 'device HTTP 404' }, 'http://1.2.3.4'), /new address/);
  assert.match(friendlyError(new TypeError('fetch failed'), 'http://1.2.3.4'), /cannot reach the device at http:\/\/1\.2\.3\.4/);
  assert.match(friendlyError(Object.assign(new Error('x'), { name: 'TimeoutError' })), /did not answer/);
});

test('poll: first scan decides on time vs late, repeat polls change nothing, unknown IDs are reported', async () => {
  const events = [
    { time: `${SUNDAY}T07:55:10`, employeeNoString: '7' },   // Ama: before 08:00 start
    { time: `${SUNDAY}T08:45:00`, employeeNoString: '9' },   // Kofi: after 08:30 (start + 30 min grace)
    { time: `${SUNDAY}T09:30:00`, employeeNoString: '7' },   // Ama again: no effect
    { time: `${SUNDAY}T08:10:00`, employeeNoString: '99' },  // not linked to anyone
  ];
  const device = fakeDevice(() => events);
  const host = await listen(device);
  const { ci, put, all, tenantSeq } = setup();
  put('members', { id: 'ama', name: 'Ama', deviceUserId: '7' });
  put('members', { id: 'kofi', name: 'Kofi', deviceUserId: '9' });
  put('settings', { id: 'church', serviceTimes: { sunday: '08:00' }, lateGraceMinutes: 30 });
  ci.setConfig({ host, username: 'admin', password: 'secret', enabled: false });

  const r1 = await ci.pollOnce();
  assert.equal(r1.recorded, 2);
  const att = all('attendance');
  assert.equal(att.length, 1);
  assert.equal(att[0].date, SUNDAY);
  assert.equal(att[0].service, 'Sunday service');
  assert.deepEqual(att[0].presentIds, ['ama']);
  assert.deepEqual(att[0].lateIds, ['kofi']);
  assert.deepEqual(ci.status().unmatched, ['99']);

  const seqBefore = tenantSeq();
  const r2 = await ci.pollOnce();
  assert.equal(r2.recorded, 0);
  assert.equal(tenantSeq(), seqBefore, 'an unchanged poll must not write anything');
  assert.equal(all('attendance').length, 1);
  device.close();
});

test('poll: a day with no service or meeting is skipped, and a ministry meeting day is filed under that ministry', async () => {
  const events = [{ time: `${MONDAY}T18:05:00`, employeeNoString: '7' }];
  const device = fakeDevice(() => events);
  const host = await listen(device);
  const { ci, put, all, dataDir } = setup({ now: () => at(2026, 11, 16, 19, 0) });
  put('members', { id: 'ama', name: 'Ama', deviceUserId: '7' });
  ci.setConfig({ host, username: 'admin', password: 'secret' });

  await ci.pollOnce();
  assert.equal(all('attendance').length, 0);
  assert.deepEqual(ci.status().skippedDays, [MONDAY]);

  put('ministries', { id: 'choir', name: 'Choir', meetDays: ['Monday'] });
  fs.rmSync(path.join(dataDir, 'clockin-state.json'));          // forget where we got up to, so the same scan is asked for again
  await ci.pollOnce();
  const att = all('attendance');
  assert.equal(att.length, 1);
  assert.equal(att[0].service, 'Choir meeting');
  assert.equal(att[0].ministryId, 'choir');
  assert.deepEqual(att[0].presentIds, ['ama']);
  device.close();
});

test('config: the password is never handed back, and switching on needs every field', () => {
  const { ci } = setup();
  assert.throws(() => ci.setConfig({ enabled: true, host: '192.168.1.5' }), /Fill in/);
  const c = ci.setConfig({ host: '192.168.1.5', username: 'admin', password: 'pw12345', pollSeconds: 5 });
  assert.equal(c.host, 'http://192.168.1.5');
  assert.equal(c.hasPassword, true);
  assert.equal(c.pollSeconds, 10, 'polling is never faster than every 10 seconds');
  assert.equal('password' in c, false);
  assert.equal(ci.setConfig({ username: 'ops' }).hasPassword, true, 'a blank password keeps the saved one');
  assert.equal('password' in ci.status(), false);
});

test('test connection: reports scans in the last hour, or a plain-words reason it failed', async () => {
  const device = fakeDevice(() => [{ time: `${SUNDAY}T09:30:00`, employeeNoString: '7' }]);
  const host = await listen(device);
  const { ci } = setup();
  const ok = await ci.test({ host, username: 'admin', password: 'x' });
  assert.deepEqual({ ok: ok.ok, n: ok.scansLastHour }, { ok: true, n: 1 });
  device.close();

  const down = setup({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const bad = await down.ci.test({ host: '192.168.1.99', username: 'admin', password: 'x' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cannot reach the device/);
});

test('find my device: lists addresses that answer with a Digest login, skips the rest', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('http://192.168.1.50/')) return { status: 401, headers: new Headers({ 'www-authenticate': 'Digest realm="DS-K1T344", nonce="abc"' }) };
    if (url.startsWith('http://192.168.1.7/')) return { status: 401, headers: new Headers({ 'www-authenticate': 'Basic realm="router"' }) };
    throw new Error('no route');
  };
  const interfaces = { en0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], pub: [{ family: 'IPv4', internal: false, address: '8.8.8.8' }] };
  const found = await findDevices({ fetchImpl, interfaces, timeoutMs: 50 });
  assert.deepEqual(found, [{ ip: '192.168.1.50', host: 'http://192.168.1.50', realm: 'DS-K1T344' }]);
});

test('routes: owner only, and absent on the hosted server', async () => {
  const db = openDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchflow-ci-'));
  const ci = createClockIn({ db, dataDir });
  const app = createApp(db, { secret: 't', clockin: ci, findDevicesImpl: async () => [], localEdition: true });
  const hosted = createApp(db, { secret: 't' });
  const base = await listen(app), baseHosted = await listen(hosted);
  const call = (b, method, p, token, body) => fetch(b + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  const reg = await (await call(base, 'POST', '/auth/register-church', null, { churchName: 'Grace', name: 'Pastor', email: 'p@g.org', password: 'password1' })).json();

  assert.equal((await call(base, 'GET', '/clockin/status')).status, 401);
  const st = await call(base, 'GET', '/clockin/status', reg.token);
  assert.equal(st.status, 200);
  assert.equal((await st.json()).configured, false);
  const bad = await call(base, 'POST', '/clockin/config', reg.token, { enabled: true });
  assert.equal(bad.status, 400);
  const saved = await call(base, 'POST', '/clockin/config', reg.token, { host: '192.168.1.5', username: 'admin', password: 'pw12345' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).configured, true);
  assert.equal((await call(base, 'POST', '/clockin/find', reg.token)).status, 200);
  assert.equal((await call(baseHosted, 'GET', '/clockin/status', reg.token)).status, 404);
  app.close(); hosted.close();
});

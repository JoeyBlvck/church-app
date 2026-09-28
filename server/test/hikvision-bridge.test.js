import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { fileStore } from '../src/fileStore.js';
import { createRepo } from '../../app/js/sync.js';
import { memoryStore } from '../../app/js/store.js';
import { pollOnce } from '../hikvision-bridge.js';

// A device fake that always accepts (digest auth itself is covered in hikvision.test.js) —
// this test is about the bridge's own logic: matching events to members and recording
// attendance idempotently.
function fakeDevice(events) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ AcsEvent: { numOfMatches: events.length, InfoList: events } })));
  });
}

test('bridge: matches clock-in events to members and records attendance idempotently', async () => {
  const chServer = createApp(openDb(), { secret: 't' });
  await new Promise((r) => chServer.listen(0, r));
  const apiUrl = `http://127.0.0.1:${chServer.address().port}`;

  // Set up the church, two members with device IDs, and a dedicated bridge login.
  const admin = createRepo(memoryStore(), { baseUrl: apiUrl });
  await admin.registerChurch({ churchName: 'Grace', name: 'Pastor', email: 'p@g.org', password: 'password1' });
  const ama = await admin.save('members', { name: 'Ama Mensah', deviceUserId: '7' });
  const kofi = await admin.save('members', { name: 'Kofi Boateng', deviceUserId: '9' });
  await admin.sync();
  await admin.createStaff({ name: 'Clock-in', email: 'clockin@g.org', password: 'password1', role: 'secretary' });

  const device = fakeDevice([
    { time: new Date().toISOString(), employeeNoString: '7' },
    { time: new Date().toISOString(), employeeNoString: '9' },
  ]);
  await new Promise((r) => device.listen(0, r));
  const config = { device: { host: `http://127.0.0.1:${device.address().port}`, username: 'x', password: 'x' },
    churchManager: { apiUrl, email: 'clockin@g.org', password: 'password1' }, service: 'Sunday service' };

  const dir = await mkdtemp(join(tmpdir(), 'hikbridge-'));
  const store = fileStore(join(dir, 'state.json'));
  const repo = createRepo(store, { baseUrl: apiUrl });
  await repo.login(config.churchManager.email, config.churchManager.password);

  await pollOnce(config, repo, store);
  const after1 = await admin.sync().then(() => admin.list('attendance'));
  assert.equal(after1.length, 1);
  assert.deepEqual(after1[0].presentIds.sort(), [ama, kofi].sort());
  assert.equal(after1[0].service, 'Sunday service');

  // Polling again (device still reporting the same two check-ins) must not duplicate the
  // attendance record or the member IDs in it.
  await pollOnce(config, repo, store);
  const after2 = await admin.sync().then(() => admin.list('attendance'));
  assert.equal(after2.length, 1);
  assert.deepEqual(after2[0].presentIds.sort(), [ama, kofi].sort());

  await rm(dir, { recursive: true, force: true });
  chServer.close(); device.close();
});

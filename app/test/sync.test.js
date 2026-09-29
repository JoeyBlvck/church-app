import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../server/src/db.js';
import { createApp } from '../../server/src/app.js';
import { memoryStore } from '../js/store.js';
import { createRepo } from '../js/sync.js';

async function world() {
  const server = createApp(openDb(), { secret: 't' });
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let online = true;
  const fetchImpl = (...a) => (online ? fetch(...a) : Promise.reject(new TypeError('offline')));
  let t = 1000;
  const device = () => createRepo(memoryStore(), { baseUrl, fetchImpl, now: () => ++t });
  return { server, device, setOnline: (v) => (online = v) };
}

test('works offline, then syncs to a second device', async () => {
  const w = await world();
  const office = w.device(), phone = w.device();
  await office.registerChurch({ churchName: 'Grace', name: 'Pastor', email: 'p@g.org', password: 'password1' });

  w.setOnline(false);
  const id = await office.save('members', { name: 'Ama Mensah', phone: '0244000000' });
  assert.equal((await office.list('members')).length, 1);      // readable offline
  assert.equal(await office.pending(), 1);
  await assert.rejects(office.sync());                          // sync fails offline, data kept
  assert.equal(await office.pending(), 1);

  w.setOnline(true);
  await office.sync();
  assert.equal(await office.pending(), 0);

  await phone.login('p@g.org', 'password1');
  await phone.sync();
  assert.equal((await phone.get('members', id)).name, 'Ama Mensah');
  w.server.close();
});

test('concurrent edits resolve by server-assigned version, not by device clock; deletes propagate', async () => {
  const w = await world();
  const a = w.device(), b = w.device();
  await a.registerChurch({ churchName: 'G', name: 'P', email: 'p@g.org', password: 'password1' });
  await b.login('p@g.org', 'password1');
  const id = await a.save('members', { name: 'Kofi' });
  await a.sync(); await b.sync();

  await a.save('members', { id, name: 'Kofi A' });   // both edit the same version they last saw
  await b.save('members', { id, name: 'Kofi B' });
  await b.sync();                                    // b commits first: it wins and gets a new version
  const r = await a.sync();                          // a is still on the old version: rejected as a conflict
  assert.equal(r.conflicted, 1);
  assert.equal((await a.get('members', id)).name, 'Kofi B');
  assert.equal(await a.pending(), 0);                // the losing edit isn't retried forever

  await b.remove('members', id); await b.sync(); await a.sync();
  assert.equal(await a.get('members', id), undefined);
  w.server.close();
});

test('finance ledger is append-only end-to-end: edits are rejected, corrections are new linked entries', async () => {
  const w = await world();
  const a = w.device();
  await a.registerChurch({ churchName: 'G', name: 'P', email: 'p@g.org', password: 'password1' });
  const id = await a.save('transactions', { type: 'tithe', amount: 50 });
  await a.sync();

  // Editing a posted entry in place is rejected by the server as a conflict; the client
  // immediately restores the original instead of holding on to a write that can never succeed.
  await a.save('transactions', { id, type: 'tithe', amount: 999 });
  const r = await a.sync();
  assert.equal(r.conflicted, 1);
  assert.equal((await a.get('transactions', id)).amount, 50);

  // A correction is two brand-new entries instead: a reversal, then the corrected value.
  await a.save('transactions', { type: 'tithe', amount: 50, reverses: id });
  const correctedId = await a.save('transactions', { type: 'tithe', amount: 75, correctsId: id });
  await a.sync();
  assert.equal((await a.get('transactions', id)).amount, 50);         // original still on record, untouched
  assert.equal((await a.get('transactions', correctedId)).amount, 75);
  w.server.close();
});

test('leader device only receives and may only write its ministry', async () => {
  const w = await world();
  const admin = w.device(), leader = w.device();
  await admin.registerChurch({ churchName: 'G', name: 'P', email: 'p@g.org', password: 'password1' });
  await admin.save('ministries', { id: 'youth', name: 'Youth' });
  await admin.save('ministries', { id: 'choir', name: 'Choir' });
  await admin.save('members', { name: 'Y1', ministryIds: ['youth'] });
  await admin.save('members', { name: 'C1', ministryIds: ['choir'] });
  await admin.save('transactions', { amount: 500, type: 'tithe' });
  await admin.sync();
  await admin.createStaff({ name: 'L', email: 'l@g.org', password: 'password1', role: 'leader', ministryIds: ['youth'] });

  await leader.login('l@g.org', 'password1');
  await leader.sync();
  assert.deepEqual((await leader.list('members')).map((m) => m.name), ['Y1']);
  assert.equal((await leader.list('transactions')).length, 0);

  await leader.save('transactions', { amount: 10, ministryId: 'choir' }); // not theirs
  const r = await leader.sync();
  assert.equal(r.rejected, 1);
  assert.equal(await leader.pending(), 0);
  w.server.close();
});

test('switching to another church wipes local data', async () => {
  const w = await world();
  const d = w.device();
  await d.registerChurch({ churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' });
  await d.save('members', { name: 'Secret' });
  const other = w.device();
  await other.registerChurch({ churchName: 'B', name: 'b', email: 'b@x.org', password: 'password1' });
  // same device logs into a different church
  await d.login('b@x.org', 'password1');
  assert.equal((await d.list('members')).length, 0);
  w.server.close();
});

test('resync drops stale local copies (e.g. leader moved out of a ministry)', async () => {
  const w = await world();
  const admin = w.device(), leader = w.device();
  await admin.registerChurch({ churchName: 'G', name: 'P', email: 'p@g.org', password: 'password1' });
  await admin.save('ministries', { id: 'youth', name: 'Youth' });
  const mid = await admin.save('members', { name: 'Y1', ministryIds: ['youth'] });
  await admin.sync();
  await admin.createStaff({ name: 'L', email: 'l@g.org', password: 'password1', role: 'leader', ministryIds: ['youth'] });
  await leader.login('l@g.org', 'password1'); await leader.sync();
  assert.equal((await leader.list('members')).length, 1);
  await admin.save('members', { id: mid, name: 'Y1', ministryIds: [] }); await admin.sync();   // no longer in Youth
  await leader.sync();
  assert.equal((await leader.list('members')).length, 1);           // stale copy lingers after normal sync
  await leader.resync();
  assert.equal((await leader.list('members')).length, 0);           // fixed by resync
  assert.ok(JSON.parse(await leader.backup()).records.length >= 1); // backup still works (ministry)
  w.server.close();
});

test('signing out keeps local data and the offline-login copy; a different church still wipes it', async () => {
  const w = await world();
  const laptop = w.device();
  await laptop.registerChurch({ churchName: 'Grace', name: 'Pastor', email: 'p@g.org', password: 'password1' });
  await laptop.save('members', { name: 'Ama Mensah' });
  await laptop.sync();

  await laptop.logout();
  assert.equal(await laptop.user(), undefined);
  assert.equal((await laptop.list('members')).length, 1); // local data survives a plain sign-out

  w.setOnline(false);
  await assert.rejects(laptop.login('p@g.org', 'wrong-password'));       // wrong password still rejected offline
  await assert.rejects(laptop.loginOffline('p@g.org', 'wrong-password'));
  const user = await laptop.loginOffline('p@g.org', 'password1');         // right password, no network at all
  assert.equal(user.email, 'p@g.org');
  assert.equal((await laptop.list('members')).length, 1);                 // still there — no wipe, no re-sync needed

  await laptop.logout();
  w.setOnline(true);
  const other = w.device();
  await other.registerChurch({ churchName: 'Bethel', name: 'Pastor B', email: 'b@x.org', password: 'password1' });
  await laptop.login('b@x.org', 'password1');                             // a DIFFERENT church signs in on the same device
  assert.equal((await laptop.list('members')).length, 0);                 // wiped, even though the sign-out happened first
  w.server.close();
});

test('offline login refuses an account this device has never seen, and picks up a changed password', async () => {
  const w = await world();
  const laptop = w.device();
  await laptop.registerChurch({ churchName: 'Grace', name: 'Pastor', email: 'p@g.org', password: 'password1' });
  w.setOnline(false);
  await assert.rejects(laptop.loginOffline('stranger@nowhere.org', 'whatever1'));
  w.setOnline(true);

  await laptop.changePassword('password1', 'password2');
  await laptop.logout();
  w.setOnline(false);
  await assert.rejects(laptop.loginOffline('p@g.org', 'password1'));      // old password no longer works offline either
  const user = await laptop.loginOffline('p@g.org', 'password2');
  assert.equal(user.email, 'p@g.org');
  w.server.close();
});

test('profile edit updates the cached session, and church settings (logo/motto/…) sync to every device', async () => {
  const w = await world();
  const office = w.device(), phone = w.device();
  await office.registerChurch({ churchName: 'Grace', name: 'Pastor Ama', email: 'p@g.org', password: 'password1' });

  const updated = await office.updateProfile('Pastor Ama Owusu', 'ama@g.org');
  assert.equal(updated.name, 'Pastor Ama Owusu');
  assert.equal((await office.user()).email, 'ama@g.org');           // cached session reflects the change immediately
  await assert.rejects(office.login('p@g.org', 'password1'));        // the old email no longer works
  await office.login('ama@g.org', 'password1');                      // the new one does

  await office.save('settings', { id: 'church', motto: 'Faith and Works', region: 'Greater Accra', district: 'Adenta Municipal',
    heroImage: 'data:image/jpeg;base64,AAAA', heroImageOpacity: 40 });
  await office.sync();
  await phone.login('ama@g.org', 'password1');
  await phone.sync();
  const churchSettings = (await phone.list('settings')).find((s) => s.id === 'church');
  assert.equal(churchSettings.motto, 'Faith and Works');
  assert.equal(churchSettings.region, 'Greater Accra');
  // the dashboard hero's background photo + opacity are ordinary fields on this same settings
  // record — no dedicated server route needed, unlike the user's own profile photo (a real
  // users-table column, since it's per-account rather than per-church).
  assert.equal(churchSettings.heroImage, 'data:image/jpeg;base64,AAAA');
  assert.equal(churchSettings.heroImageOpacity, 40);
  w.server.close();
});

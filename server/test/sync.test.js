import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function setup() {
  const server = createApp(openDb(), { secret: 't' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  return { server, call };
}
const push = (call, token, changes) => call('POST', '/sync/push', { changes }, token);
const ch = (collection, id, data, updatedAt = 1, deleted = false) => ({ collection, id, data, updatedAt, deleted });

test('multi-tenant isolation', async () => {
  const { server, call } = await setup();
  const a = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  const b = (await call('POST', '/auth/register-church', { churchName: 'B', name: 'b', email: 'b@x.org', password: 'password1' })).body;
  await push(call, a.token, [ch('members', 'm1', { name: 'Ama' })]);
  const pulled = await call('GET', '/sync/pull?since=0', null, b.token);
  assert.equal(pulled.body.changes.length, 0);
  assert.equal((await call('GET', '/sync/pull?since=0', null, a.token)).body.changes.length, 1);
  server.close();
});

test('server-assigned versions: conflicts are decided by seq, not by client clock', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  const created = await push(call, o.token, [ch('members', 'm1', { name: 'New' }, 200)]);
  assert.equal(created.body.results[0].status, 'ok');
  const seq1 = created.body.results[0].seq;

  // A write based on an out-of-date version is a conflict even though its clock timestamp
  // is later — a bad or fast device clock can no longer win by simply claiming a later time.
  const stale = await push(call, o.token, [{ ...ch('members', 'm1', { name: 'Old' }, 9999), baseSeq: 0 }]);
  assert.equal(stale.body.results[0].status, 'conflict');
  assert.equal(stale.body.results[0].data.name, 'New');   // the authoritative copy comes straight back
  assert.equal(stale.body.results[0].seq, seq1);

  // Writing from the version you actually have succeeds and is assigned the next version.
  const ok = await push(call, o.token, [{ ...ch('members', 'm1', { name: 'Correct' }, 300), baseSeq: seq1 }]);
  assert.equal(ok.body.results[0].status, 'ok');
  const seq2 = ok.body.results[0].seq;
  assert.ok(seq2 > seq1);

  // Deletes are tombstones and follow the same versioning.
  await push(call, o.token, [{ ...ch('members', 'm1', { name: 'Correct' }, 400, true), baseSeq: seq2 }]);
  const p = (await call('GET', '/sync/pull?since=0', null, o.token)).body;
  assert.equal(p.changes.at(-1).deleted, true);
  server.close();
});

test('ministry leader is scoped to their ministry', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await push(call, o.token, [
    ch('ministries', 'youth', { name: 'Youth' }), ch('ministries', 'choir', { name: 'Choir' }),
    ch('members', 'm1', { name: 'Kofi', ministryIds: ['youth'] }),
    ch('members', 'm2', { name: 'Esi', ministryIds: ['choir'] }),
    ch('transactions', 't1', { amount: 50, type: 'tithe' }),                       // church-wide
    ch('transactions', 't2', { amount: 20, type: 'offering', ministryId: 'youth' }),
    ch('transactions', 't3', { amount: 30, type: 'offering', ministryId: 'choir' }),
    ch('attendance', 'whole1', { service: 'Sunday service', presentIds: ['m1', 'm2'] }),   // whole-church — reflects into every ministry a present member belongs to
    ch('attendance', 'att-youth', { service: 'Youth meeting', ministryId: 'youth', presentIds: ['m1'] }),
    ch('attendance', 'att-choir', { service: 'Choir practice', ministryId: 'choir', presentIds: ['m2'] }), // a different ministry's own meeting — stays out of view
  ]);
  await call('POST', '/users', { name: 'L', email: 'l@x.org', password: 'password1', role: 'leader', ministryIds: ['youth'] }, o.token);
  const l = (await call('POST', '/auth/login', { email: 'l@x.org', password: 'password1' })).body;

  const seen = (await call('GET', '/sync/pull?since=0', null, l.token)).body.changes.map((c) => c.id).sort();
  assert.deepEqual(seen, ['att-youth', 'm1', 't2', 'whole1', 'youth']);

  const w = await push(call, l.token, [
    ch('members', 'm3', { name: 'New', ministryIds: ['youth'] }),
    ch('members', 'm2', { name: 'Hijack', ministryIds: ['youth'] }, 999),   // existing choir member
    ch('transactions', 't9', { amount: 5, ministryId: 'choir' }),
    ch('ministries', 'youth', { name: 'Renamed' }, 999),                     // leaders can't edit ministries
    ch('households', 'h1', { name: 'X' }),
  ]);
  assert.deepEqual(w.body.results.map((r) => r.status), ['ok', 'forbidden', 'forbidden', 'forbidden', 'forbidden']);
  server.close();
});

test('leader roster-only writes: can add/remove own ministry from a member without other edit rights', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  const setupPush = await push(call, o.token, [
    ch('ministries', 'youth', { name: 'Youth' }),
    ch('members', 'm1', { name: 'Kofi', ministryIds: ['youth'] }),   // already youth's
    ch('members', 'm2', { name: 'Ama', ministryIds: [] }),           // not in any ministry yet
    ch('members', 'm4', { name: 'Yaw', ministryIds: [] }),           // not in any ministry yet
  ]);
  const seq = Object.fromEntries(setupPush.body.results.map((r) => [r.id, r.seq]));
  await call('POST', '/users', { name: 'L', email: 'l2@x.org', password: 'password1', role: 'leader', ministryIds: ['youth'] }, o.token);
  const l = (await call('POST', '/auth/login', { email: 'l2@x.org', password: 'password1' })).body;

  // Adding an unaffiliated member to the roster, and removing an existing member from it, are
  // both plain roster changes — nothing else about the record differs — so both succeed even
  // though m2 wasn't "theirs" beforehand.
  const r = await push(call, l.token, [
    { ...ch('members', 'm2', { name: 'Ama', ministryIds: ['youth'] }, 999), baseSeq: seq.m2 },
    { ...ch('members', 'm1', { name: 'Kofi', ministryIds: [] }, 999), baseSeq: seq.m1 },
  ]);
  assert.deepEqual(r.body.results.map((x) => x.status), ['ok', 'ok']);

  // A brand-new member record (no existing row) added straight into the leader's ministry.
  const created = await push(call, l.token, [ch('members', 'm3', { name: 'New', ministryIds: ['youth'] })]);
  assert.equal(created.body.results[0].status, 'ok');

  // But the roster exception never doubles as a way to sneak in a personal-info edit: adding
  // someone to the ministry AND renaming them in the same write is refused outright.
  const sneaky = await push(call, l.token, [{ ...ch('members', 'm4', { name: 'Sneaky Rename', ministryIds: ['youth'] }, 1000), baseSeq: seq.m4 }]);
  assert.equal(sneaky.body.results[0].status, 'forbidden');
  server.close();
});

test('treasurer sees finance only; auth failures', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await push(call, o.token, [ch('transactions', 't1', { amount: 1 }), ch('attendance', 'a1', { count: 3 })]);
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  const t = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;
  assert.deepEqual((await call('GET', '/sync/pull?since=0', null, t.token)).body.changes.map((c) => c.id), ['t1']);
  assert.equal((await call('GET', '/users', null, t.token)).status, 403);
  assert.equal((await call('GET', '/sync/pull?since=0')).status, 401);
  assert.equal((await call('POST', '/auth/login', { email: 'a@x.org', password: 'wrong' })).status, 401);
  server.close();
});

test('pledges: treasurer yes, secretary/leader no; future timestamps are clamped for storage', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;
  const t = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;
  assert.equal((await push(call, t.token, [ch('pledges', 'p1', { memberId: 'm1', amount: 100 })])).body.results[0].status, 'ok');
  assert.equal((await push(call, s.token, [ch('pledges', 'p2', { amount: 1 })])).body.results[0].status, 'forbidden');
  assert.deepEqual((await call('GET', '/sync/pull?since=0', null, s.token)).body.changes, []);   // no finance for secretary
  // A device clock set 10 years ahead can no longer corrupt conflict resolution (that's now
  // seq-based — see the versions test above); it can still corrupt the stored date, so that
  // gets clamped on the way in.
  const future = await push(call, o.token, [ch('members', 'm9', { name: 'Future' }, Date.now() + 3.15e11)]);
  assert.equal(future.body.results[0].status, 'ok');
  const stored = (await call('GET', '/sync/pull?since=0', null, o.token)).body.changes.find((c) => c.id === 'm9');
  assert.ok(stored.updatedAt <= Date.now() + 5 * 60_000 + 1000);
  const r = await push(call, o.token, [{ ...ch('members', 'm9', { name: 'Honest' }, Date.now() + 10 * 60_000), baseSeq: future.body.results[0].seq }]);
  assert.equal(r.body.results[0].status, 'ok');
  server.close();
});

test('programme calendar: everyone can read, only owner/admin/secretary can write', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  await call('POST', '/users', { name: 'L', email: 'l@x.org', password: 'password1', role: 'leader', ministryIds: ['youth'] }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;
  const t = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;
  const l = (await call('POST', '/auth/login', { email: 'l@x.org', password: 'password1' })).body;
  assert.equal((await push(call, s.token, [ch('programmes', 'p1', { name: 'Harvest', date: '2026-12-01', recurring: true })])).body.results[0].status, 'ok');
  assert.equal((await push(call, t.token, [ch('programmes', 'p2', { name: 'Convention', date: '2026-11-01' })])).body.results[0].status, 'forbidden');
  assert.equal((await push(call, l.token, [ch('programmes', 'p3', { name: 'Camp', date: '2026-08-01' })])).body.results[0].status, 'forbidden');
  // everyone (owner, secretary, treasurer, leader) can read the calendar back
  for (const token of [o.token, s.token, t.token, l.token]) {
    assert.deepEqual((await call('GET', '/sync/pull?since=0', null, token)).body.changes.map((c) => c.id).filter((id) => id === 'p1'), ['p1']);
  }
  server.close();
});

test('programme registrations: everyone can read, only owner/admin/secretary can write', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  await call('POST', '/users', { name: 'L', email: 'l@x.org', password: 'password1', role: 'leader', ministryIds: ['youth'] }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;
  const t = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;
  const l = (await call('POST', '/auth/login', { email: 'l@x.org', password: 'password1' })).body;
  await push(call, s.token, [ch('programmes', 'p1', { name: 'Harvest', date: '2026-12-01' })]);
  assert.equal((await push(call, s.token, [ch('registrations', 'r1', { programmeId: 'p1', name: 'Guest One', status: 'registered' })])).body.results[0].status, 'ok');
  assert.equal((await push(call, t.token, [ch('registrations', 'r2', { programmeId: 'p1', name: 'Guest Two', status: 'registered' })])).body.results[0].status, 'forbidden');
  assert.equal((await push(call, l.token, [ch('registrations', 'r3', { programmeId: 'p1', name: 'Guest Three', status: 'registered' })])).body.results[0].status, 'forbidden');
  // everyone (owner, secretary, treasurer, leader) can read the registration back
  for (const token of [o.token, s.token, t.token, l.token]) {
    assert.deepEqual((await call('GET', '/sync/pull?since=0', null, token)).body.changes.map((c) => c.id).filter((id) => id === 'r1'), ['r1']);
  }
  server.close();
});

test('accounts & funds: owner/admin/treasurer only — secretary and leader can neither read nor write', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  await call('POST', '/users', { name: 'L', email: 'l@x.org', password: 'password1', role: 'leader', ministryIds: ['youth'] }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;
  const t = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;
  const l = (await call('POST', '/auth/login', { email: 'l@x.org', password: 'password1' })).body;
  assert.equal((await push(call, t.token, [ch('accounts', 'a1', { name: 'Main account', type: 'bank', openingBalance: 0 })])).body.results[0].status, 'ok');
  assert.equal((await push(call, t.token, [ch('funds', 'f1', { name: 'Building Fund', goal: 5000 })])).body.results[0].status, 'ok');
  assert.equal((await push(call, s.token, [ch('accounts', 'a2', { name: 'Petty cash', type: 'cash' })])).body.results[0].status, 'forbidden');
  assert.equal((await push(call, l.token, [ch('funds', 'f2', { name: 'Missions' })])).body.results[0].status, 'forbidden');
  // only owner/admin/treasurer ever receive accounts/funds records at all
  assert.deepEqual((await call('GET', '/sync/pull?since=0', null, o.token)).body.changes.map((c) => c.id).filter((id) => id === 'a1'), ['a1']);
  assert.deepEqual((await call('GET', '/sync/pull?since=0', null, t.token)).body.changes.map((c) => c.id).filter((id) => id === 'f1'), ['f1']);
  assert.deepEqual((await call('GET', '/sync/pull?since=0', null, s.token)).body.changes.map((c) => c.id).filter((id) => id === 'a1'), []);
  assert.deepEqual((await call('GET', '/sync/pull?since=0', null, l.token)).body.changes.map((c) => c.id).filter((id) => id === 'f1'), []);
  // a leader can still post their own ministry's transactions, tagging one to an account/fund
  // they can't otherwise see is simply not something the UI offers them — nothing here forbids
  // the write itself, since accountId/fundId are just plain fields on a transaction.
  assert.equal((await push(call, l.token, [ch('transactions', 'tx1', { type: 'tithe', amount: 10, ministryId: 'youth', accountId: 'a1' })])).body.results[0].status, 'ok');
  server.close();
});

test('church settings (logo, motto, location…): everyone can read, only owner/admin can write', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  await call('POST', '/users', { name: 'T', email: 't@x.org', password: 'password1', role: 'treasurer' }, o.token);
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;
  const t = (await call('POST', '/auth/login', { email: 't@x.org', password: 'password1' })).body;
  assert.equal((await push(call, o.token, [ch('settings', 'church', { motto: 'Faith and works', region: 'Greater Accra' })])).body.results[0].status, 'ok');
  assert.equal((await push(call, s.token, [ch('settings', 'church', { motto: 'Hijacked' })])).body.results[0].status, 'forbidden');
  assert.equal((await push(call, t.token, [ch('settings', 'church', { motto: 'Hijacked' })])).body.results[0].status, 'forbidden');
  for (const token of [o.token, s.token, t.token]) {
    const rows = (await call('GET', '/sync/pull?since=0', null, token)).body.changes;
    assert.equal(rows.find((r) => r.id === 'church')?.data.motto, 'Faith and works');
  }
  server.close();
});

test('finance ledger is append-only, even for the owner', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'A', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  const created = await push(call, o.token, [ch('transactions', 't1', { amount: 50, type: 'tithe' })]);
  assert.equal(created.body.results[0].status, 'ok');
  const seq = created.body.results[0].seq;
  // Even the owner, resubmitting with the correct current version, cannot edit a posted
  // entry — reported as a conflict, carrying the original back, so a client that tried
  // this restores it instead of leaving the doomed edit sitting locally.
  const edit = await push(call, o.token, [{ ...ch('transactions', 't1', { amount: 999, type: 'tithe' }, 2), baseSeq: seq }]);
  assert.equal(edit.body.results[0].status, 'conflict');
  assert.equal(edit.body.results[0].data.amount, 50);
  // Nor delete it.
  const del = await push(call, o.token, [{ ...ch('transactions', 't1', { amount: 50, type: 'tithe' }, 3, true), baseSeq: seq }]);
  assert.equal(del.body.results[0].status, 'conflict');
  // A correction is a new entry instead; the original is untouched.
  const correction = await push(call, o.token, [ch('transactions', 't2', { amount: 50, type: 'tithe', reverses: 't1' }, 4)]);
  assert.equal(correction.body.results[0].status, 'ok');
  const rows = (await call('GET', '/sync/pull?since=0', null, o.token)).body.changes;
  assert.equal(rows.find((r) => r.id === 't1').data.amount, 50); // original never changed
  server.close();
});

test('staff management: deactivate, change role, reset password, change own password', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'a', email: 'a@x.org', password: 'password1' })).body;
  const id = (await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token)).body.id;
  const s = (await call('POST', '/auth/login', { email: 's@x.org', password: 'password1' })).body;
  assert.equal((await call('GET', '/me', null, o.token)).body.church, 'Grace');
  assert.equal((await call('POST', '/users/update', { id, role: 'leader' }, o.token)).status, 400);      // leader needs a ministry
  assert.equal((await call('POST', '/users/update', { id, role: 'treasurer', password: 'newpass123' }, o.token)).status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 's@x.org', password: 'newpass123' })).status, 200);
  assert.equal((await call('POST', '/users/update', { id, active: false }, s.token)).status, 403);        // non-admin
  await call('POST', '/users/update', { id, active: false }, o.token);
  assert.equal((await call('GET', '/sync/pull?since=0', null, s.token)).status, 401);                    // deactivated = locked out at once
  assert.equal((await call('POST', '/users/update', { id: o.user.id, active: false }, o.token)).status, 403); // owner protected
  assert.equal((await call('POST', '/auth/change-password', { current: 'nope', next: 'password2' }, o.token)).status, 401);
  assert.equal((await call('POST', '/auth/change-password', { current: 'password1', next: 'password2' }, o.token)).status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'a@x.org', password: 'password2' })).status, 200);
  server.close();
});

test('a user can edit their own profile (name/email), but not steal another account\'s email', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'a@x.org', password: 'password1' })).body;
  await call('POST', '/users', { name: 'S', email: 's@x.org', password: 'password1', role: 'secretary' }, o.token);
  assert.equal((await call('POST', '/auth/update-profile', { name: '', email: 'a2@x.org' }, o.token)).status, 400); // name required
  const updated = await call('POST', '/auth/update-profile', { name: 'Ama Owusu', email: 'ama@x.org' }, o.token);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.name, 'Ama Owusu');
  assert.equal(updated.body.user.email, 'ama@x.org');
  assert.equal((await call('POST', '/auth/login', { email: 'ama@x.org', password: 'password1' })).status, 200); // new email logs in
  assert.equal((await call('POST', '/auth/update-profile', { name: 'Ama', email: 's@x.org' }, o.token)).status, 409); // taken by another user
  assert.equal((await call('POST', '/auth/update-profile', { name: 'x', email: 'y@x.org' }, null)).status, 401); // must be signed in
  server.close();
});

test('a user can set and remove their own profile photo; leaving it out keeps whatever is on file', async () => {
  const { server, call } = await setup();
  const o = (await call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'a@x.org', password: 'password1' })).body;
  assert.equal(o.user.photo, null); // none set at registration
  const withPhoto = await call('POST', '/auth/update-profile', { name: 'Ama', email: 'a@x.org', photo: 'data:image/jpeg;base64,AAAA' }, o.token);
  assert.equal(withPhoto.body.user.photo, 'data:image/jpeg;base64,AAAA');
  // a save that doesn't mention `photo` at all (e.g. just changing your name) leaves it alone
  const nameOnly = await call('POST', '/auth/update-profile', { name: 'Ama Owusu', email: 'a@x.org' }, o.token);
  assert.equal(nameOnly.body.user.photo, 'data:image/jpeg;base64,AAAA');
  // logging back in reflects the same photo (it's a real column, not something only the update response carries)
  assert.equal((await call('POST', '/auth/login', { email: 'a@x.org', password: 'password1' })).body.user.photo, 'data:image/jpeg;base64,AAAA');
  // explicitly sending null removes it
  const removed = await call('POST', '/auth/update-profile', { name: 'Ama Owusu', email: 'a@x.org', photo: null }, o.token);
  assert.equal(removed.body.user.photo, null);
  server.close();
});

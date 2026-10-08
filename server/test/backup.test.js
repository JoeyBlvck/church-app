import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createBackupManager, applyPendingRestore, isBackupName, listDrives, BackupError } from '../src/backup.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'churchflow-bk-'));

function setupDb() {
  const dir = tmp(), dataDir = path.join(dir, 'data'), backupDir = path.join(dir, 'Backups');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'church.db');
  const db = openDb(dbPath);
  return { dir, dataDir, backupDir, dbPath, db };
}

test('backup names: only real backups are recognised', () => {
  assert.ok(isBackupName('churchflow-backup-2026-10-08-093000.db'));
  assert.ok(isBackupName('churchflow-backup-2026-10-08-093000-daily.db'));
  assert.ok(isBackupName('churchflow-backup-2026-10-08-093000-before-restore.db'));
  assert.ok(!isBackupName('church.db'));
  assert.ok(!isBackupName('.churchflow-backup-2026-10-08-093000.db.partial'));
});

test('drive list: Windows letters that exist, never C:, nothing on other systems', () => {
  assert.deepEqual(listDrives('win32', (p) => ['C:\\', 'E:\\', 'F:\\'].includes(p)), ['E:\\', 'F:\\']);
  assert.deepEqual(listDrives('linux'), []);
});

test('Back up now writes a complete, openable copy of the database to the default folder', () => {
  const { dataDir, backupDir, dbPath, db } = setupDb();
  db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?,?,?)').run('t1', 'Grace Chapel', 1);
  const bk = createBackupManager({ db, dbPath, dataDir, defaultDir: backupDir });
  const results = bk.run();
  assert.equal(results.length, 1); assert.ok(results[0].ok, results[0].error);
  const files = fs.readdirSync(backupDir);
  assert.equal(files.length, 1); assert.ok(isBackupName(files[0]));
  assert.ok(!fs.readdirSync(dataDir).some((n) => n.startsWith('.snapshot')), 'the temporary snapshot is cleaned up');
  const copy = new DatabaseSync(path.join(backupDir, files[0]), { readOnly: true });
  assert.equal(copy.prepare('SELECT name FROM tenants').get().name, 'Grace Chapel');
  copy.close();
});

test('a second folder (the USB drive) gets its own copy, and a missing drive is reported without losing the good copy', () => {
  const { dir, dataDir, backupDir, dbPath, db } = setupDb();
  const usb = path.join(dir, 'usb', 'ChurchFlow Backups');
  const bk = createBackupManager({ db, dbPath, dataDir, defaultDir: backupDir });
  bk.setExtraDir(usb);
  const ok = bk.run();
  assert.deepEqual(ok.map((r) => r.ok), [true, true]);
  assert.equal(fs.readdirSync(usb).length, 1);
  // "unplug" the drive: its parent is now a plain file, so the folder can't be created
  fs.rmSync(path.join(dir, 'usb'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'usb'), 'not a folder');
  const after = bk.run();
  assert.equal(after[0].ok, true); assert.equal(after[1].ok, false); assert.match(after[1].error, /backup drive|USB|Not allowed|Could not/i);
  assert.equal(bk.status().last.results[1].ok, false);
});

test('a folder that cannot be written to is refused when it is chosen, not on the day it is needed', () => {
  const { dir, dataDir, backupDir, dbPath, db } = setupDb();
  fs.writeFileSync(path.join(dir, 'blocker'), 'x');
  const bk = createBackupManager({ db, dbPath, dataDir, defaultDir: backupDir });
  assert.throws(() => bk.setExtraDir(path.join(dir, 'blocker', 'sub')), BackupError);
  assert.throws(() => bk.setExtraDir('relative/path'), BackupError);
  assert.equal(bk.status().extraDir, null);
  bk.setExtraDir(path.join(dir, 'good')); assert.equal(bk.status().extraDir, path.join(dir, 'good'));
  bk.setExtraDir(null); assert.equal(bk.status().extraDir, null);
});

test('the daily backup runs once per day per folder, and again the next day', () => {
  const { dataDir, backupDir, dbPath, db } = setupDb();
  let when = new Date(2026, 9, 8, 9, 0, 0);
  const bk = createBackupManager({ db, dbPath, dataDir, defaultDir: backupDir, now: () => when });
  assert.ok(bk.runDailyIfDue());
  when = new Date(2026, 9, 8, 15, 0, 0);
  assert.equal(bk.runDailyIfDue(), null, 'already backed up today');
  assert.equal(fs.readdirSync(backupDir).length, 1);
  when = new Date(2026, 9, 9, 8, 0, 0);
  assert.ok(bk.runDailyIfDue());
  assert.equal(fs.readdirSync(backupDir).length, 2);
});

test('old backups are pruned to the newest 60 per folder', () => {
  const { dataDir, backupDir, dbPath, db } = setupDb();
  let day = 0;
  const bk = createBackupManager({ db, dbPath, dataDir, defaultDir: backupDir, now: () => new Date(2026, 0, 1 + day, 8, 0, 0) });
  for (day = 0; day < 65; day++) bk.run({ reason: 'daily' });
  const files = fs.readdirSync(backupDir).filter(isBackupName).sort();
  assert.equal(files.length, 60);
  assert.ok(files[0].includes('2026-01-06'), 'the five oldest are gone');
});

test('restore: refuses files that are not ChurchFlow backups and changes nothing', () => {
  const { dir, dataDir, backupDir, dbPath, db } = setupDb();
  const bk = createBackupManager({ db, dbPath, dataDir, defaultDir: backupDir });
  assert.throws(() => bk.stageRestore(path.join(dir, 'missing.db')), /could not be found/);
  const junk = path.join(dir, 'junk.db'); fs.writeFileSync(junk, 'this is not sqlite');
  assert.throws(() => bk.stageRestore(junk), /not a ChurchFlow backup/);
  const other = path.join(dir, 'other.db'); const o = new DatabaseSync(other); o.exec('CREATE TABLE x (a)'); o.close();
  assert.throws(() => bk.stageRestore(other), /not a ChurchFlow backup/);
  assert.ok(!fs.existsSync(`${dbPath}.restore-pending`));
});

test('restore: stages the chosen backup after saving the current data, and the launcher swaps it in keeping the old file', () => {
  const { dataDir, backupDir, dbPath, db } = setupDb();
  db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?,?,?)').run('t1', 'Before', 1);
  const bk = createBackupManager({ db, dbPath, dataDir, defaultDir: backupDir });
  bk.run();
  const chosen = bk.status().files[0].path;
  db.prepare("UPDATE tenants SET name = 'After' WHERE id = 't1'").run(); // changed since the backup
  bk.stageRestore(chosen);
  assert.ok(fs.existsSync(`${dbPath}.restore-pending`));
  assert.ok(fs.readdirSync(backupDir).some((n) => n.includes('before-restore')), 'a safety copy of the current data was made first');
  db.close();
  assert.equal(applyPendingRestore(dbPath), true);
  const now = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(now.prepare("SELECT name FROM tenants WHERE id = 't1'").get().name, 'Before');
  now.close();
  assert.ok(fs.readdirSync(dataDir).some((n) => n.startsWith('church.db.replaced-')), 'the replaced database is kept, not deleted');
  assert.equal(applyPendingRestore(dbPath), false, 'nothing left to apply');
});

// ---- over HTTP ----
async function boot({ withBackup = true } = {}) {
  const s = setupDb();
  const bk = withBackup ? createBackupManager({ db: s.db, dbPath: s.dbPath, dataDir: s.dataDir, defaultDir: s.backupDir }) : null;
  let restarts = 0;
  const server = createApp(s.db, { secret: 't', backup: bk, localEdition: withBackup, onRestartRequested: () => { restarts++; } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { ...s, bk, server, call, restarts: () => restarts };
}

test('over HTTP: owner can back up and see the list; a leader cannot; not found on the hosted server', async () => {
  const t = await boot();
  const reg = await t.call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' });
  const owner = reg.body.token;
  assert.equal((await t.call('GET', '/backup/status')).status, 401);
  const run = await t.call('POST', '/backup/run', {}, owner);
  assert.equal(run.status, 200); assert.ok(run.body.results[0].ok);
  const st = await t.call('GET', '/backup/status', null, owner);
  assert.equal(st.body.files.length, 1); assert.equal(st.body.enabled, true);
  await t.call('POST', '/users', { name: 'Kofi', email: 'k@x.org', password: 'password1', role: 'leader', ministryIds: ['m1'] }, owner);
  const leader = (await t.call('POST', '/auth/login', { email: 'k@x.org', password: 'password1' })).body.token;
  assert.equal((await t.call('GET', '/backup/status', null, leader)).status, 403);
  assert.equal((await t.call('POST', '/backup/run', {}, leader)).status, 403);
  t.server.close();

  const hosted = await boot({ withBackup: false });
  const reg2 = await hosted.call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' });
  assert.equal((await hosted.call('GET', '/backup/status', null, reg2.body.token)).status, 404);
  hosted.server.close();
});

test('over HTTP: restoring a bad path gives a plain error; a good one asks the server to restart', async () => {
  const t = await boot();
  const owner = (await t.call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' })).body.token;
  const bad = await t.call('POST', '/backup/restore', { path: path.join(t.dir, 'nope.db') }, owner);
  assert.equal(bad.status, 400); assert.match(bad.body.error, /could not be found/);
  await t.call('POST', '/backup/run', {}, owner);
  const file = (await t.call('GET', '/backup/status', null, owner)).body.files[0].path;
  const ok = await t.call('POST', '/backup/restore', { path: file }, owner);
  assert.deepEqual(ok.body, { ok: true, restarting: true });
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(t.restarts(), 1);
  t.server.close();
});

test('the offline edition holds exactly one church', async () => {
  const t = await boot();
  const first = await t.call('POST', '/auth/register-church', { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' });
  assert.equal(first.status, 200);
  const second = await t.call('POST', '/auth/register-church', { churchName: 'Other', name: 'Kwame', email: 'kw@x.org', password: 'password1' });
  assert.equal(second.status, 403); assert.match(second.body.error, /already set up/);
  assert.equal((await t.call('GET', '/health')).body.localEdition, true);
  t.server.close();
});

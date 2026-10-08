// Backups for the offline ("one PC") edition of The ChurchFlow.
//
// With no cloud copy, the church's whole record lives in one SQLite file on one computer, so
// losing that computer would lose everything. This module keeps dated copies of it:
//   - a copy in a default folder on the same PC (Documents\ChurchFlow Backups),
//   - and, if the church sets one up in Settings, a second copy on a USB / external drive,
// once a day automatically, plus on demand ("Back up now"). It can also put a chosen backup back.
//
// Copies are made with SQLite's own "VACUUM INTO", which writes a consistent snapshot even while
// the app is in the middle of saving something -- never a plain file copy of a live database.
// A copy is written under a temporary name and renamed only once it is complete, so a USB stick
// pulled out mid-write leaves no half-finished file that looks like a real backup.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const RESTART_EXIT_CODE = 75; // "restart me": the launcher (local.js) swaps in a staged restore and starts the server again
const KEEP_NEWEST = 60;               // per folder -- two months of dailies, plus any manual ones
const FILE_RE = /^churchflow-backup-(\d{4}-\d{2}-\d{2})-(\d{6})(?:-([a-z-]+))?\.db$/;
const REQUIRED_TABLES = ['tenants', 'users', 'records'];

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockOf = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// A leftover live-database sidecar, or a half-written copy, must never be mistaken for a backup.
export const isBackupName = (name) => FILE_RE.test(name);

// Windows drive letters other than C: that currently exist -- where a USB stick or external disk
// shows up. Elsewhere (dev machines, Linux/macOS) there is no such thing, so it's an empty list.
export function listDrives(platform = process.platform, exists = fs.existsSync) {
  if (platform !== 'win32') return [];
  const out = [];
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') if (exists(`${letter}:\\`)) out.push(`${letter}:\\`);
  return out;
}

// Replaces the live database with a backup that restoreFrom() staged. Runs BEFORE the server opens
// the database (see local.js), because a database file can't be swapped out from under a running
// server. The database being replaced is kept (renamed, never deleted) so nothing is ever lost to a
// restore by accident.
export function applyPendingRestore(dbPath, now = new Date()) {
  const pending = `${dbPath}.restore-pending`;
  if (!fs.existsSync(pending)) return false;
  const stamp = `${dayOf(now)}-${clockOf(now)}`;
  if (fs.existsSync(dbPath)) fs.renameSync(dbPath, `${dbPath}.replaced-${stamp}`);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, `${dbPath}.replaced-${stamp}${ext}`);
  fs.renameSync(pending, dbPath);
  return true;
}

export function createBackupManager({ db, dbPath, dataDir, defaultDir, now = () => new Date() }) {
  const settingsFile = path.join(dataDir, 'backup-settings.json');
  // Kept in its own small file, NOT in the database, so restoring an older backup never rolls back
  // which drive the church chose or when the last backup ran.
  const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
  const writeSettings = (s) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); };

  const targets = () => {
    const s = readSettings();
    return [{ kind: 'computer', dir: defaultDir }, ...(s.extraDir ? [{ kind: 'drive', dir: s.extraDir }] : [])];
  };

  function listIn(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter(isBackupName).map((name) => {
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch { return null; }
      return { name, dir, path: full, size: st.size, modified: st.mtimeMs, day: name.match(FILE_RE)[1] };
    }).filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
  }

  function prune(dir) {
    for (const f of listIn(dir).slice(KEEP_NEWEST)) { try { fs.unlinkSync(f.path); } catch { /* in use or read-only: leave it, try again next time */ } }
  }

  // Writes one snapshot of the database, then copies it into each of `which` (default: every target).
  // Returns a per-folder result so a missing USB stick is reported rather than hiding a good copy.
  function run({ reason = 'manual', which = targets() } = {}) {
    const when = now();
    const name = `churchflow-backup-${dayOf(when)}-${clockOf(when)}${reason === 'manual' ? '' : `-${reason}`}.db`;
    fs.mkdirSync(dataDir, { recursive: true });
    const snapshot = path.join(dataDir, `.snapshot-${process.pid}-${Date.now()}.db`);
    const results = [];
    try {
      db.prepare('VACUUM INTO ?').run(snapshot);
      for (const t of which) {
        try {
          fs.mkdirSync(t.dir, { recursive: true });
          const tmp = path.join(t.dir, `.${name}.partial`);
          fs.copyFileSync(snapshot, tmp);
          fs.renameSync(tmp, path.join(t.dir, name));
          prune(t.dir);
          results.push({ kind: t.kind, dir: t.dir, ok: true, file: name });
        } catch (e) {
          results.push({ kind: t.kind, dir: t.dir, ok: false, error: friendlyFsError(e, t) });
        }
      }
    } finally { try { fs.unlinkSync(snapshot); } catch { /* already gone */ } }
    const s = readSettings();
    s.last = { at: when.getTime(), reason, results };
    writeSettings(s);
    return results;
  }

  // Once-a-day: any target with no backup dated today gets one. Called on a timer, so a PC that is
  // only switched on for Sunday still backs up the first time the app is open each day.
  function runDailyIfDue() {
    const today = dayOf(now());
    const missing = targets().filter((t) => !listIn(t.dir).some((f) => f.day === today));
    if (!missing.length) return null;
    return run({ reason: 'daily', which: missing });
  }

  let timer = null;
  function start({ firstCheckMs = 30_000, everyMs = 10 * 60_000 } = {}) {
    const tick = () => { try { runDailyIfDue(); } catch (e) { console.error('daily backup failed:', e.message); } };
    setTimeout(tick, firstCheckMs).unref();
    timer = setInterval(tick, everyMs); timer.unref();
  }
  const stop = () => { clearInterval(timer); timer = null; };

  function status() {
    const s = readSettings();
    return {
      enabled: true,
      defaultDir,
      extraDir: s.extraDir ?? null,
      last: s.last ?? null,
      files: targets().flatMap((t) => listIn(t.dir).map((f) => ({ ...f, kind: t.kind }))).sort((a, b) => b.name.localeCompare(a.name)),
      drives: listDrives(),
    };
  }

  // The second folder -- normally on a USB / external drive. Proven writable right away, so a
  // typo or a drive that isn't plugged in is found now and not on the day it's needed.
  function setExtraDir(dir) {
    const s = readSettings();
    if (!dir) { delete s.extraDir; writeSettings(s); return; }
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new BackupError('Pick a drive or a full folder path, such as E:\\ChurchFlow Backups.');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${Date.now()}`);
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    } catch (e) { throw new BackupError(friendlyFsError(e, { kind: 'drive', dir })); }
    s.extraDir = dir; writeSettings(s);
  }

  // Checks that `file` really is a ChurchFlow database, takes a safety copy of the current one,
  // and stages the file for the launcher to swap in on the next start. Throws BackupError with a
  // plain-language reason if anything is off -- nothing is changed unless every check passes.
  function stageRestore(file) {
    if (typeof file !== 'string' || !file) throw new BackupError('No backup file was chosen.');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new BackupError('That backup file could not be found. If it is on a USB drive, check that the drive is plugged in.');
    let check;
    try {
      check = new DatabaseSync(file, { readOnly: true });
      const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
      if (missing.length) throw new BackupError('That file is not a ChurchFlow backup.');
      const integrity = check.prepare('PRAGMA integrity_check').get();
      if (Object.values(integrity)[0] !== 'ok') throw new BackupError('That backup file is damaged and cannot be used.');
    } catch (e) {
      if (e instanceof BackupError) throw e;
      throw new BackupError('That file is not a ChurchFlow backup.');
    } finally { try { check?.close(); } catch { /* ignore */ } }
    // The data that is about to be replaced is saved first, in every folder that is reachable.
    run({ reason: 'before-restore' });
    const pending = `${dbPath}.restore-pending`;
    fs.copyFileSync(file, pending);
    return { staged: true };
  }

  return { run, runDailyIfDue, start, stop, status, setExtraDir, stageRestore, list: () => status().files };
}

export class BackupError extends Error { constructor(message) { super(message); this.status = 400; } }

function friendlyFsError(e, t) {
  const where = t.kind === 'drive' ? 'the backup drive' : 'the backup folder';
  if (e.code === 'ENOENT' || e.code === 'ENODEV' || e.code === 'ENXIO') return `Could not reach ${where} (${t.dir}). Is the USB drive plugged in?`;
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') return `Not allowed to write to ${where} (${t.dir}). It may be read-only or protected.`;
  if (e.code === 'ENOSPC') return `${where[0].toUpperCase()}${where.slice(1)} (${t.dir}) is full.`;
  return `Could not save a backup to ${t.dir}: ${e.message}`;
}

// Launcher for the offline ("one PC") edition. The desktop app (src-tauri/src/lib.rs) starts this
// with the bundled Node and keeps its standard input open; everything else is decided here:
//
//   - where the data lives (DATA_DIR -- the church's database, its signing secret, the server log),
//   - a signing secret that is generated once, on first run, and kept beside the database,
//   - applying a restore the church asked for (the database file can only be swapped while the
//     server is stopped, so the server exits and this launcher swaps it in, then starts it again),
//   - restarting the server if it stops by itself unexpectedly, and
//   - stopping the server when the desktop app closes (the app closing ends the standard input).
//
// Environment: DATA_DIR and BACKUP_DIR (required), PORT (default 47821).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPendingRestore, RESTART_EXIT_CODE } from './backup.js';

const dataDir = process.env.DATA_DIR;
const backupDir = process.env.BACKUP_DIR;
if (!dataDir || !backupDir) { console.error('DATA_DIR and BACKUP_DIR are required'); process.exit(2); }
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'church.db');
const secretFile = path.join(dataDir, 'jwt.secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const secret = fs.readFileSync(secretFile, 'utf8').trim();

// One log file, trimmed when it grows large, so "something looks wrong" can be looked into later.
const logFile = path.join(dataDir, 'server.log');
try { if (fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, `${logFile}.old`); } catch { /* no log yet */ }
const log = fs.openSync(logFile, 'a');
const stamp = (msg) => fs.writeSync(log, `[${new Date().toISOString()}] launcher: ${msg}\n`);

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
let child = null, stopping = false, quickFailures = 0;

function startServer() {
  if (applyPendingRestore(dbPath)) stamp('restored the chosen backup');
  const startedAt = Date.now();
  child = spawn(process.execPath, ['--no-warnings', serverEntry], {
    env: { ...process.env, LOCAL_EDITION: '1', DB_PATH: dbPath, DATA_DIR: dataDir, BACKUP_DIR: backupDir,
      PORT: process.env.PORT ?? '47821', JWT_SECRET: secret, NODE_ENV: 'production' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.on('exit', (code) => {
    child = null;
    if (stopping) process.exit(0);
    if (code === RESTART_EXIT_CODE) { stamp('restarting for a restore'); quickFailures = 0; return startServer(); }
    // Stopped on its own. Try again, but not in a tight loop if it fails straight away every time.
    quickFailures = Date.now() - startedAt < 5000 ? quickFailures + 1 : 0;
    stamp(`server stopped (code ${code}); restarting`);
    if (quickFailures >= 5) { stamp('giving up: the server keeps failing at start-up'); process.exit(1); }
    setTimeout(startServer, 1000 * Math.min(quickFailures + 1, 5));
  });
}

// The desktop app holds our standard input open for as long as it runs; when it closes (or crashes)
// that input ends, and the server must not be left running with nobody to talk to it.
function shutdown() { stopping = true; if (child) child.kill(); else process.exit(0); }
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.resume();
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startServer();

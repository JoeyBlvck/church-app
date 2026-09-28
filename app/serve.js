// Tiny static server for local development: node serve.js
//
// Also serves one small same-origin JSON API route, POST /api/device/pull-users: this
// script runs on the church's own computer, on the same local network as any Hikvision
// clock-in terminal (per the architecture note in README.md — the hosted sync server can't
// reach a church's LAN device, but this dev/production static server can). It reads
// server/hikvision.config.json (same shape as the bridge's config) and calls into
// server/src/hikvision.js's ISAPI client to fetch the device's enrolled-person list, so
// Settings → "Clock-in device" can turn it into a spreadsheet for staff to review — this
// route never creates or touches any member record itself.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
// NOTE: server/src/hikvision.js is loaded lazily inside pullDeviceUsers() below, not imported here.
// This file is deployed on its own (no sibling server/ folder) when hosted — e.g. Railway builds
// the `app` service from just this directory — so a top-level import of it would crash the whole
// static server on startup there. It only exists on a church's own computer running this script
// locally alongside the full repo, which is the only place the clock-in device is reachable anyway.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };
const root = new URL('.', import.meta.url).pathname;
const configPath = join(root, '..', 'server', 'hikvision.config.json');

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

async function pullDeviceUsers(res) {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { return sendJson(res, 404, { error: 'No server/hikvision.config.json found on this computer. Copy server/hikvision.config.example.json, fill in the clock-in device\'s address and admin login, and try again.' }); }
  let fetchEnrolledUsers;
  try { ({ fetchEnrolledUsers } = await import('../server/src/hikvision.js')); }
  catch { return sendJson(res, 404, { error: 'The clock-in device feature needs the full project checkout (server/ folder) on this computer — it\'s not available on the hosted copy of the app.' }); }
  try {
    const users = await fetchEnrolledUsers({ baseUrl: config.device?.host, username: config.device?.username, password: config.device?.password });
    sendJson(res, 200, { users });
  } catch (e) { sendJson(res, 502, { error: `Could not reach the clock-in device: ${e.message}. Check that this computer is on the same network as it, and that server/hikvision.config.json has the right address and login.` }); }
}

// PORT is set by hosting platforms (Railway, etc.) that assign the port dynamically; falls back to 5173 locally.
const port = Number(process.env.PORT ?? 5173);

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && pathname === '/api/device/pull-users') return pullDeviceUsers(res);
  const p = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = join(root, p === '/' ? 'index.html' : p);
    if (!file.startsWith(root)) throw 0;
    const buf = await readFile(file);
    // no-store: dev server, always serve the current file on disk (never a stale browser-cached copy).
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(buf);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, () => console.log(`app on http://localhost:${port}`));

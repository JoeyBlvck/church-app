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
import { fetchEnrolledUsers } from '../server/src/hikvision.js';
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
  try {
    const users = await fetchEnrolledUsers({ baseUrl: config.device?.host, username: config.device?.username, password: config.device?.password });
    sendJson(res, 200, { users });
  } catch (e) { sendJson(res, 502, { error: `Could not reach the clock-in device: ${e.message}. Check that this computer is on the same network as it, and that server/hikvision.config.json has the right address and login.` }); }
}

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
}).listen(5173, () => console.log('app on http://localhost:5173'));

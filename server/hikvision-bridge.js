#!/usr/bin/env node
// Bridge between a Hikvision clock-in terminal (face/fingerprint/card) and The ChurchFlow.
// Runs on a computer on the SAME LOCAL NETWORK as the device — it's just another
// local-first "device" from The ChurchFlow's point of view, using the exact same sync
// client (app/js/sync.js) the browser app uses, so pushes get the same optimistic-
// concurrency and permission handling for free.
//
// Setup (see README.md "Hikvision clock-in integration" for the full walkthrough):
//   1. In The ChurchFlow, create a staff account for the bridge to sign in as (Staff →
//      Add account), role "secretary" is enough — it can write attendance.
//   2. In Members, set each member's "Clock-in device ID" to their employee/person
//      number on the Hikvision terminal (Members → open a member → Edit).
//   3. Copy hikvision.config.example.json to hikvision.config.json and fill it in.
//   4. Run:  node server/hikvision-bridge.js            (polls continuously)
//            node server/hikvision-bridge.js --once      (one poll, then exit — for cron)
//            node server/hikvision-bridge.js --probe     (dumps raw device events, no
//                                                          ChurchFlow calls — use this
//                                                          first to confirm the device's
//                                                          JSON matches what this script
//                                                          expects; see hikvision.js)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRepo } from '../app/js/sync.js';
import { fileStore } from './src/fileStore.js';
import { fetchAcsEvents, matchEventsToMembers } from './src/hikvision.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

async function loadConfig() {
  const path = join(here, 'hikvision.config.json');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`Missing or invalid ${path} — copy hikvision.config.example.json and fill it in.`); }
}

async function probe(config) {
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const events = await fetchAcsEvents({
    baseUrl: config.device.host, username: config.device.username, password: config.device.password,
    startTime: startOfDay.toISOString(), endTime: now.toISOString(),
  });
  console.log(`Fetched ${events.length} event(s) from the device today:`);
  console.log(JSON.stringify(events, null, 2));
  if (!events.length) console.log('\nNo events yet today — have someone clock in, then re-run --probe.');
}

async function pollOnce(config, repo, store) {
  await repo.sync();
  const nowISO = new Date().toISOString();
  const since = (await store.getMeta('hikvisionSince')) ?? new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

  const events = await fetchAcsEvents({ baseUrl: config.device.host, username: config.device.username, password: config.device.password, startTime: since, endTime: nowISO });
  if (events.length) {
    const members = await repo.list('members');
    const { presentIds, unmatched } = matchEventsToMembers(events, members);
    if (unmatched.length) console.warn(`Clock-in IDs not linked to any member (add these in Members → Edit → "Clock-in device ID"): ${unmatched.join(', ')}`);
    if (presentIds.length) {
      const date = nowISO.slice(0, 10), service = config.service ?? 'Clock-in';
      const existing = (await repo.list('attendance')).find((a) => a.date === date && a.service === service && !a.ministryId);
      const merged = new Set([...(existing?.presentIds ?? []), ...presentIds]);
      await repo.save('attendance', { ...existing, date, service, presentIds: [...merged] });
      console.log(`${new Date().toLocaleTimeString()}: recorded ${presentIds.length} check-in(s) for "${service}" on ${date}.`);
    }
  }
  await store.setMeta('hikvisionSince', nowISO);
  await repo.sync();
}

async function main() {
  const config = await loadConfig();
  if (args.has('--probe')) return probe(config);

  const statePath = join(here, config.stateFile ?? '.hikvision-state.json');
  const store = fileStore(statePath);
  const repo = createRepo(store, { baseUrl: config.churchManager.apiUrl });

  if (!(await repo.user())) {
    console.log(`Signing in as ${config.churchManager.email}...`);
    await repo.login(config.churchManager.email, config.churchManager.password);
  }

  if (args.has('--once')) { await pollOnce(config, repo, store); return; }

  const seconds = config.pollSeconds ?? 30;
  console.log(`Polling ${config.device.host} every ${seconds}s. Ctrl+C to stop.`);
  for (;;) {
    try { await pollOnce(config, repo, store); }
    catch (e) { console.error('Poll failed (will retry):', e.message); }
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

export { pollOnce, loadConfig };

// Only auto-run when executed directly (`node hikvision-bridge.js`), not when imported
// by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

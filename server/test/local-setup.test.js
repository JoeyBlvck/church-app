import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

// The offline edition's first-run setup and owner recovery code -- and that none of it exists on the
// hosted server.
async function boot({ localEdition }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchflow-setup-'));
  const db = openDb(path.join(dir, 'church.db'));
  const server = createApp(db, { secret: 't', localEdition });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { call, close: () => server.close() };
}
const REG = { churchName: 'Grace', name: 'Ama', email: 'ama@x.org', password: 'password1' };

test('health says setup is needed until the church exists (offline edition only)', async () => {
  const t = await boot({ localEdition: true });
  assert.equal((await t.call('GET', '/health')).body.setupNeeded, true);
  await t.call('POST', '/auth/register-church', REG);
  assert.equal((await t.call('GET', '/health')).body.setupNeeded, false);
  t.close();
  const hosted = await boot({ localEdition: false });
  assert.equal('setupNeeded' in (await hosted.call('GET', '/health')).body, false);
  hosted.close();
});

test('registering on the offline edition returns a recovery code once; the hosted server never does', async () => {
  const t = await boot({ localEdition: true });
  const reg = await t.call('POST', '/auth/register-church', REG);
  assert.match(reg.body.recoveryCode, /^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
  assert.equal((await t.call('POST', '/auth/register-church', { ...REG, email: 'b@x.org' })).status, 403);
  t.close();
  const hosted = await boot({ localEdition: false });
  assert.equal((await hosted.call('POST', '/auth/register-church', REG)).body.recoveryCode, undefined);
  assert.equal((await hosted.call('POST', '/auth/recover', { email: REG.email, code: 'AAAA-AAAA-AAAA-AAAA', password: 'password2' })).status, 404);
  hosted.close();
});

test('recovery code: sets a new password, is single-use, and is replaced by a fresh one', async () => {
  const t = await boot({ localEdition: true });
  const { recoveryCode } = (await t.call('POST', '/auth/register-church', REG)).body;
  const bad = await t.call('POST', '/auth/recover', { email: REG.email, code: 'AAAA-AAAA-AAAA-AAAA', password: 'newpassword1' });
  assert.equal(bad.status, 400);
  assert.equal((await t.call('POST', '/auth/recover', { email: REG.email, code: recoveryCode, password: 'short' })).status, 400, 'password must be 8+ characters');
  // typed in lower case, without dashes -- still accepted
  const ok = await t.call('POST', '/auth/recover', { email: REG.email.toUpperCase(), code: recoveryCode.toLowerCase().replaceAll('-', ' '), password: 'newpassword1' });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.body.recoveryCode, recoveryCode);
  assert.equal((await t.call('POST', '/auth/login', { email: REG.email, password: 'password1' })).status, 401);
  assert.equal((await t.call('POST', '/auth/login', { email: REG.email, password: 'newpassword1' })).status, 200);
  assert.equal((await t.call('POST', '/auth/recover', { email: REG.email, code: recoveryCode, password: 'another-pass1' })).status, 400, 'the used code no longer works');
  assert.equal((await t.call('POST', '/auth/recover', { email: REG.email, code: ok.body.recoveryCode, password: 'another-pass1' })).status, 200);
  t.close();
});

test('a new recovery code needs the current password and replaces the old one', async () => {
  const t = await boot({ localEdition: true });
  const reg = (await t.call('POST', '/auth/register-church', REG)).body;
  assert.equal((await t.call('POST', '/auth/new-recovery-code', { password: 'wrong' }, reg.token)).status, 400);
  assert.equal((await t.call('POST', '/auth/new-recovery-code', { password: 'password1' })).status, 401);
  const fresh = await t.call('POST', '/auth/new-recovery-code', { password: 'password1' }, reg.token);
  assert.equal(fresh.status, 200);
  assert.equal((await t.call('POST', '/auth/recover', { email: REG.email, code: reg.recoveryCode, password: 'newpassword1' })).status, 400);
  assert.equal((await t.call('POST', '/auth/recover', { email: REG.email, code: fresh.body.recoveryCode, password: 'newpassword1' })).status, 200);
  t.close();
});

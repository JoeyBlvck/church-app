import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { fetchAcsEvents, parseAcsEvents, matchEventsToMembers, digestAuthorization, fetchEnrolledUsers, parseUserInfoSearch } from '../src/hikvision.js';

const md5 = (s) => createHash('md5').update(s).digest('hex');

// A minimal stand-in for a Hikvision terminal: requires real HTTP Digest auth (so the
// client's auth code is genuinely exercised, not just mocked away), then serves a page
// of AcsEvent-shaped JSON per Hikvision's documented ISAPI response.
function fakeDevice(username, password, pages) {
  const nonce = randomBytes(8).toString('hex'), realm = 'IPC';
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    const auth = req.headers.authorization;
    const valid = auth && (() => {
      const f = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
      const ha1 = md5(`${username}:${realm}:${password}`), ha2 = md5(`${req.method}:${f.uri}`);
      const expected = md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
      return f.response === expected;
    })();
    if (!valid) {
      res.writeHead(401, { 'www-authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}"` }).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const pos = JSON.parse(body).AcsEventCond.searchResultPosition;
      const page = pages[pos / 30] ?? { InfoList: [] };
      // Mirrors a real device's response shape: totalMatches is the grand total across ALL
      // pages, numOfMatches is only how many are in THIS page -- the two differ whenever
      // there's more than one page, which is exactly what caught the pagination bug.
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        AcsEvent: { totalMatches: pages.flatMap((p) => p.InfoList).length, numOfMatches: page.InfoList.length, InfoList: page.InfoList },
      }));
    });
  });
  return { server, getCalls: () => calls };
}

test('digest auth: the device rejects a wrong password and accepts the right one', async () => {
  const { server } = fakeDevice('admin', 'correct-horse', [{ InfoList: [{ time: '2026-09-22T08:00:00+00:00', employeeNoString: '7', name: 'Kofi' }] }]);
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const events = await fetchAcsEvents({ baseUrl, username: 'admin', password: 'correct-horse', startTime: 'x', endTime: 'y' });
  assert.deepEqual(events, [{ deviceUserId: '7', time: '2026-09-22T08:00:00+00:00', name: 'Kofi' }]);

  await assert.rejects(fetchAcsEvents({ baseUrl, username: 'admin', password: 'wrong', startTime: 'x', endTime: 'y' }), /HTTP 401/);
  server.close();
});

test('fetchAcsEvents pages through multiple result pages', async () => {
  const page0 = { InfoList: Array.from({ length: 30 }, (_, i) => ({ time: `2026-09-22T08:${String(i).padStart(2, '0')}:00+00:00`, employeeNoString: String(i) })) };
  const page1 = { InfoList: [{ time: '2026-09-22T09:00:00+00:00', employeeNoString: '30' }] };
  const { server } = fakeDevice('admin', 'pw', [page0, page1]);
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const events = await fetchAcsEvents({ baseUrl, username: 'admin', password: 'pw', startTime: 'x', endTime: 'y' });
  assert.equal(events.length, 31);
  assert.equal(events.at(-1).deviceUserId, '30');
  server.close();
});

test('fetchAcsEvents keeps paging past a page that is entirely non-check-in noise', async () => {
  // A real DS-K1T344MBFWX-E1's log is mostly door/system events with no employeeNoString --
  // parseAcsEvents() filters those out, so a full page of them filters down to an EMPTY
  // batch. Pagination must keep going anyway (this is the exact bug that made a real
  // clock-in vanish: the old code stopped as soon as the filtered batch looked "short").
  const page0 = { InfoList: Array.from({ length: 30 }, (_, i) => ({ time: `2026-09-22T08:${String(i).padStart(2, '0')}:00+00:00` /* no employeeNoString */ })) };
  const page1 = { InfoList: [{ time: '2026-09-22T09:00:00+00:00', employeeNoString: '2', name: 'Joel' }] };
  const { server } = fakeDevice('admin', 'pw', [page0, page1]);
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const events = await fetchAcsEvents({ baseUrl, username: 'admin', password: 'pw', startTime: 'x', endTime: 'y' });
  assert.deepEqual(events, [{ deviceUserId: '2', time: '2026-09-22T09:00:00+00:00', name: 'Joel' }]);
  server.close();
});

test('parseAcsEvents is defensive about missing/odd fields', () => {
  assert.deepEqual(parseAcsEvents({}), []);
  assert.deepEqual(parseAcsEvents({ AcsEvent: { InfoList: [{ time: 't1', employeeNoString: '5' }, { time: 't2' }, { employeeNoString: '9' }] } }),
    [{ deviceUserId: '5', time: 't1', name: undefined }]);
  // some firmware versions use a numeric employeeNo instead of employeeNoString
  assert.deepEqual(parseAcsEvents({ InfoList: [{ time: 't3', employeeNo: 42 }] }), [{ deviceUserId: '42', time: 't3', name: undefined }]);
});

test('matchEventsToMembers matches by device ID and reports the rest as unmatched', () => {
  const members = [{ id: 'm1', deviceUserId: '7' }, { id: 'm2', deviceUserId: '9' }, { id: 'm3' }];
  const events = [{ deviceUserId: '7' }, { deviceUserId: '7' }, { deviceUserId: '9' }, { deviceUserId: '404' }];
  const { presentIds, unmatched } = matchEventsToMembers(events, members);
  assert.deepEqual(presentIds.sort(), ['m1', 'm2']);
  assert.deepEqual(unmatched, ['404']);
});

// A minimal stand-in for a device's UserInfo/Search endpoint. Digest auth itself is already
// exercised above via fetchAcsEvents (both go through the same digestRequest helper), so this
// fake just accepts any request and focuses on the enrolled-user pagination/shape.
function fakeUserDevice(pages) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const pos = JSON.parse(body).UserInfoSearchCond.searchResultPosition;
      const page = pages[pos / 30] ?? { UserInfo: [] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        UserInfoSearch: { totalMatches: pages.flatMap((p) => p.UserInfo).length, numOfMatches: page.UserInfo.length, UserInfo: page.UserInfo },
      }));
    });
  });
}

test('fetchEnrolledUsers returns the device\'s enrolled name/ID list', async () => {
  const { server } = (() => { const server = fakeUserDevice([{ UserInfo: [{ employeeNo: '1', name: 'Ama Mensah' }, { employeeNo: '2', name: 'Kofi Boateng' }] }] ); return { server }; })();
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const users = await fetchEnrolledUsers({ baseUrl, username: 'admin', password: 'pw' });
  assert.deepEqual(users, [{ deviceUserId: '1', name: 'Ama Mensah' }, { deviceUserId: '2', name: 'Kofi Boateng' }]);
  server.close();
});

test('fetchEnrolledUsers pages through multiple result pages', async () => {
  const page0 = { UserInfo: Array.from({ length: 30 }, (_, i) => ({ employeeNo: String(i), name: `Person ${i}` })) };
  const page1 = { UserInfo: [{ employeeNo: '30', name: 'Person 30' }] };
  const server = fakeUserDevice([page0, page1]);
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const users = await fetchEnrolledUsers({ baseUrl, username: 'admin', password: 'pw' });
  assert.equal(users.length, 31);
  assert.equal(users.at(-1).deviceUserId, '30');
  server.close();
});

test('parseUserInfoSearch is defensive about missing/odd fields', () => {
  assert.deepEqual(parseUserInfoSearch({}), []);
  // a record with no person number is dropped — there's nothing to match it by
  assert.deepEqual(parseUserInfoSearch({ UserInfoSearch: { UserInfo: [{ employeeNo: '5', name: 'Ama' }, { name: 'No ID' }, { employeeNo: '9' }] } }),
    [{ deviceUserId: '5', name: 'Ama' }, { deviceUserId: '9', name: '' }]);
  // some firmware wraps the list directly instead of under UserInfoSearch, and employeeNo can be numeric
  assert.deepEqual(parseUserInfoSearch({ UserInfo: [{ employeeNo: 42, name: 'Kofi' }] }), [{ deviceUserId: '42', name: 'Kofi' }]);
});

test('digestAuthorization produces the RFC 2617 response for a known vector', () => {
  const header = digestAuthorization({
    method: 'POST', uri: '/ISAPI/AccessControl/AcsEvent?format=json', username: 'admin', password: 'pw',
    challenge: { realm: 'IPC', nonce: 'abc123', qop: 'auth' }, cnonce: 'deadbeef', nc: '00000001',
  });
  const ha1 = md5('admin:IPC:pw'), ha2 = md5('POST:/ISAPI/AccessControl/AcsEvent?format=json');
  const expected = md5(`${ha1}:abc123:00000001:deadbeef:auth:${ha2}`);
  assert.match(header, new RegExp(`response="${expected}"`));
});

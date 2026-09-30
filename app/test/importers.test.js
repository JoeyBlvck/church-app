import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsToMemberRecords, matchMemberRow, planMemberImport, extractAttendanceEntries, matchIdentifier, planAttendanceImport,
  looksLikeHikvisionLog, parseHikvisionLog, planHikvisionImport, dayNameFor, attendanceTargetForDay } from '../js/importers.js';

// ---- member spreadsheet import ----

test('rowsToMemberRecords maps headers case-insensitively and drops blank cells', () => {
  const csvRows = [
    ['Name', 'Device ID', 'Phone', 'Email', 'Gender', 'Status', 'Birthday', 'Household'],
    ['Ama Mensah', '7', '', 'ama@example.com', 'female', '', '', ''],
    ['', '', '', '', '', '', '', ''], // fully-blank row is skipped entirely
  ];
  assert.deepEqual(rowsToMemberRecords(csvRows), [{ name: 'Ama Mensah', deviceUserId: '7', email: 'ama@example.com', gender: 'female' }]);
});

test('rowsToMemberRecords ignores unrecognized columns and is case-insensitive', () => {
  const csvRows = [['NAME', 'notes', 'STATUS'], ['Kofi', 'ignored', 'visitor']];
  assert.deepEqual(rowsToMemberRecords(csvRows), [{ name: 'Kofi', status: 'visitor' }]);
});

test('matchMemberRow matches by device ID first, then by case-insensitive name', () => {
  const members = [{ id: 'm1', name: 'Ama Mensah', deviceUserId: '7' }, { id: 'm2', name: 'Kofi Boateng' }];
  assert.equal(matchMemberRow({ name: 'someone else', deviceUserId: '7' }, members).id, 'm1');
  assert.equal(matchMemberRow({ name: 'kofi boateng' }, members).id, 'm2');
  assert.equal(matchMemberRow({ name: 'Nobody' }, members), null);
});

test('planMemberImport: creates, updates, and skips rows missing a name', () => {
  const members = [{ id: 'm1', name: 'Ama Mensah', deviceUserId: '7', phone: '0240000000' }];
  const rows = [
    { name: 'Ama Mensah', deviceUserId: '7', email: 'ama@x.org' }, // matches m1 by device ID -> update
    { name: 'New Person', status: 'visitor' },                      // no match -> create
    { deviceUserId: '99' },                                         // no name -> skip
  ];
  const actions = planMemberImport(rows, members);
  assert.deepEqual(actions[0], { type: 'update', id: 'm1', fields: { name: 'Ama Mensah', deviceUserId: '7', email: 'ama@x.org' } });
  assert.deepEqual(actions[1], { type: 'create', fields: { name: 'New Person', status: 'visitor' } });
  assert.equal(actions[2].type, 'skip');
  assert.equal(actions[2].reason, 'missing name');
});

test('planMemberImport only carries fields the row actually provided, so blanks never overwrite', () => {
  const members = [{ id: 'm1', name: 'Ama Mensah', phone: '0240000000', email: 'old@x.org' }];
  const actions = planMemberImport([{ name: 'Ama Mensah', email: 'new@x.org' }], members);
  assert.deepEqual(actions[0].fields, { name: 'Ama Mensah', email: 'new@x.org' }); // no `phone` key at all
});

test('planMemberImport passes a household name through unresolved for the caller to link/create', () => {
  const actions = planMemberImport([{ name: 'Ama', household: 'Mensah family' }], []);
  assert.equal(actions[0].fields.household, 'Mensah family');
});

// ---- attendance spreadsheet import ----

test('extractAttendanceEntries drops a recognizable header row and blank lines', () => {
  assert.deepEqual(extractAttendanceEntries([['Name'], ['Ama Mensah'], [''], ['Kofi Boateng']]), ['Ama Mensah', 'Kofi Boateng']);
});

test('extractAttendanceEntries works with no header row at all', () => {
  assert.deepEqual(extractAttendanceEntries([['Ama Mensah'], ['7']]), ['Ama Mensah', '7']);
});

test('extractAttendanceEntries accepts a Device ID header too', () => {
  assert.deepEqual(extractAttendanceEntries([['Device ID'], ['7'], ['9']]), ['7', '9']);
});

test('matchIdentifier matches by device ID or case-insensitive name', () => {
  const members = [{ id: 'm1', name: 'Ama Mensah', deviceUserId: '7' }, { id: 'm2', name: 'Kofi Boateng' }];
  assert.equal(matchIdentifier('7', members).id, 'm1');
  assert.equal(matchIdentifier('kofi boateng', members).id, 'm2');
  assert.equal(matchIdentifier('nobody', members), null);
});

test('planAttendanceImport reports matched member IDs and unmatched entries', () => {
  const members = [{ id: 'm1', name: 'Ama Mensah', deviceUserId: '7' }, { id: 'm2', name: 'Kofi Boateng' }];
  const { presentIds, unmatched } = planAttendanceImport(['7', 'Kofi Boateng', 'Ghost Person'], members);
  assert.deepEqual(presentIds.sort(), ['m1', 'm2']);
  assert.deepEqual(unmatched, ['Ghost Person']);
});

test('planAttendanceImport de-duplicates repeated matches to the same member', () => {
  const members = [{ id: 'm1', name: 'Ama Mensah', deviceUserId: '7' }];
  const { presentIds } = planAttendanceImport(['7', 'Ama Mensah'], members);
  assert.deepEqual(presentIds, ['m1']);
});

// ---- Hikvision clock-in device "record list" export ----

const HIK_HEADER = ['sName', 'sJobNo', 'sCard', 'Date', 'Time', 'IN/OUT', 'ReadID', 'EventMainCode', 'EventSubCode', 'AttendanceStatus', 'SerialNo'];
const hikRow = (name, jobNo, date, time, status = 'checkIn') => [`'${name}`, `'${jobNo}`, "'NULL", date, time, "'IN", '1', '5', '38', status, '1'];

test('looksLikeHikvisionLog recognizes the device export header and rejects the plain one-column format', () => {
  assert.equal(looksLikeHikvisionLog([HIK_HEADER]), true);
  assert.equal(looksLikeHikvisionLog([['Name'], ['Ama Mensah']]), false);
  assert.equal(looksLikeHikvisionLog([]), false);
});

test('parseHikvisionLog strips the leading quote marks, converts M/D/YYYY dates, and collapses repeat swipes to one entry per person per day', () => {
  const rows = [HIK_HEADER,
    hikRow('Philip Abebreseh', '27', '1/2/2025', '7:08:04', 'checkIn'),
    hikRow('Philip Abebreseh', '27', '1/2/2025', '17:31:00', 'checkOut'), // same person, same day -> collapses
    hikRow('Steven Baidoo', '17', '1/2/2025', '7:18:29', 'checkIn'),
  ];
  const entries = parseHikvisionLog(rows);
  assert.deepEqual(entries, [
    { date: '2025-01-02', name: 'Philip Abebreseh', jobNo: '27' },
    { date: '2025-01-02', name: 'Steven Baidoo', jobNo: '17' },
  ]);
});

test('parseHikvisionLog drops swipes with no enrolled name ("NULL")', () => {
  const rows = [HIK_HEADER, hikRow('NULL', '', '4/7/2025', '19:28:57', 'undefined')];
  assert.deepEqual(parseHikvisionLog(rows), []);
});

test('planHikvisionImport marks an already-known member present by device ID or name, with no create/backfill', () => {
  const members = [{ id: 'm1', name: 'Philip Abebreseh', deviceUserId: '27' }, { id: 'm2', name: 'Steven Baidoo' }];
  const entries = [{ date: '2025-01-02', name: 'Philip Abebreseh', jobNo: '27' }, { date: '2025-01-02', name: 'Steven Baidoo', jobNo: '17' }];
  const plan = planHikvisionImport(entries, members);
  assert.deepEqual(plan.days, [{ date: '2025-01-02', keys: ['m1', 'm2'] }]);
  assert.deepEqual(plan.toCreate, []);
  // Steven matched by name only, and the log has a job number (17) he doesn't have on file yet
  assert.deepEqual(plan.toBackfill, [{ id: 'm2', deviceUserId: '17' }]);
});

test('planHikvisionImport queues an unrecognized person to create exactly once, however many days they appear', () => {
  const entries = [
    { date: '2025-01-02', name: 'New Person', jobNo: '40' },
    { date: '2025-01-09', name: 'New Person', jobNo: '40' },
  ];
  const plan = planHikvisionImport(entries, []);
  assert.deepEqual(plan.toCreate, [{ key: 'new:40', name: 'New Person', deviceUserId: '40' }]);
  assert.deepEqual(plan.days, [
    { date: '2025-01-02', keys: ['new:40'] },
    { date: '2025-01-09', keys: ['new:40'] },
  ]);
});

test('planHikvisionImport groups multiple people into the same day and sorts days chronologically', () => {
  const entries = [
    { date: '2025-01-09', name: 'Later Person', jobNo: '5' },
    { date: '2025-01-02', name: 'Earlier Person', jobNo: '6' },
  ];
  const plan = planHikvisionImport(entries, []);
  assert.deepEqual(plan.days.map((d) => d.date), ['2025-01-02', '2025-01-09']);
});

// ---- attributing a clock-in day to a service/ministry ----

test('dayNameFor reads the date as UTC regardless of the machine\'s own time zone', () => {
  // 2026-09-27 is a Sunday, 2026-09-30 a Wednesday (fixed dates, checked against a calendar).
  assert.equal(dayNameFor('2026-09-27'), 'Sunday');
  assert.equal(dayNameFor('2026-09-30'), 'Wednesday');
});

test('attendanceTargetForDay: Sunday always goes to the main service, no ministry needed', () => {
  assert.deepEqual(attendanceTargetForDay('2026-09-27', []), { ministryId: undefined, service: 'Sunday service' });
  // Even when a ministry happens to also meet on Sunday, Sunday still wins.
  const ministries = [{ id: 'yth', name: 'Youth', meetDays: ['Sunday'] }];
  assert.deepEqual(attendanceTargetForDay('2026-09-27', ministries), { ministryId: undefined, service: 'Sunday service' });
  // sundayService is configurable.
  assert.deepEqual(attendanceTargetForDay('2026-09-27', [], { sundayService: 'Main service' }), { ministryId: undefined, service: 'Main service' });
});

test('attendanceTargetForDay: a weekday with one matching ministry files under that ministry', () => {
  const ministries = [{ id: 'yth', name: 'Youth', meetDays: ['Wednesday'] }, { id: 'wm', name: 'Women', meetDay: 'Friday' }];
  assert.deepEqual(attendanceTargetForDay('2026-09-30', ministries), { ministryId: 'yth', service: 'Youth meeting' });
});

test('attendanceTargetForDay: a weekday with no ministry meeting scheduled is skipped (null)', () => {
  const ministries = [{ id: 'yth', name: 'Youth', meetDays: ['Friday'] }];
  assert.equal(attendanceTargetForDay('2026-09-30', ministries), null);
  assert.equal(attendanceTargetForDay('2026-09-30', []), null);
});

test('attendanceTargetForDay: two ministries meeting the same day pick one alphabetically by name', () => {
  const ministries = [{ id: 'yth', name: 'Youth', meetDays: ['Wednesday'] }, { id: 'chr', name: 'Choir', meetDays: ['Wednesday'] }];
  assert.deepEqual(attendanceTargetForDay('2026-09-30', ministries), { ministryId: 'chr', service: 'Choir meeting' });
});

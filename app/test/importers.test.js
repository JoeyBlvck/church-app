import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsToMemberRecords, matchMemberRow, planMemberImport, extractAttendanceEntries, matchIdentifier, planAttendanceImport,
  looksLikeHikvisionLog, parseHikvisionLog, planHikvisionImport, dayNameFor, attendanceTargetForDay,
  parseDateLoose, splitMinistryNames, matchMinistry, prettyMinistryName } from '../js/importers.js';

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

// ---- Google Form "contact information" sheet ----

const FORM_HEADER = ['Timestamp', 'FULL NAME', 'DATE OF BIRTH', 'GENDER', 'HOME TOWN', 'DEPARTMENT', 'MARIATAL STATUS', 'NUMBER OF CHILDREN', 'CONTACT',
  'WHERE YOU STAY', 'FATHER’S NAME', "MOTHER'S NAME", 'YEAR YOU JOINED THE CHURCH', 'E-MAIL', 'OCCUPATION'];
// A form row, with each answer overridable by column name.
const formRow = (o = {}) => { const d = { Timestamp: '2025-02-16 14:08:43', 'FULL NAME': 'Ama Mensah ', 'DATE OF BIRTH': '2001-06-13', GENDER: 'FEMALE', 'HOME TOWN': 'Dunkwa', DEPARTMENT: 'YOUTH MINISTRY',
  'MARIATAL STATUS': 'SINGLE', 'NUMBER OF CHILDREN': '0', CONTACT: '0559523538', 'WHERE YOU STAY': 'Babianiha', 'FATHER’S NAME': 'Kwame Mensah', "MOTHER'S NAME": 'Esi Mensah',
  'YEAR YOU JOINED THE CHURCH': '2012', 'E-MAIL': 'Ama@Example.com', OCCUPATION: 'Teacher', ...o }; return FORM_HEADER.map((h) => d[h]); };

test('a Google Form sheet maps onto member fields, with the answers that have no field of their own going to notes', () => {
  const [r] = rowsToMemberRecords([FORM_HEADER, formRow()]);
  assert.deepEqual(r, { name: 'Ama Mensah', birthday: '2001-06-13', gender: 'female', phone: '0559523538', address: 'Babianiha', email: 'ama@example.com',
    joined: '2012-01-01', ministry: 'YOUTH MINISTRY', notes: 'Hometown: Dunkwa · Marital status: Single · Children: 0 · Occupation: Teacher · Father: Kwame Mensah · Mother: Esi Mensah' });
});

test('form answers of "None" are treated as empty rather than stored', () => {
  const [r] = rowsToMemberRecords([FORM_HEADER, formRow({ 'E-MAIL': 'None', OCCUPATION: 'None', 'FATHER’S NAME': 'N/A', CONTACT: 'None' })]);
  assert.equal(r.email, undefined); assert.equal(r.phone, undefined); assert.equal(r.issues, undefined);
  assert.ok(!/Occupation|Father/.test(r.notes));
});

test('gender spellings (FEMAL, Female, MALE) all normalize to the two values the app uses', () => {
  const g = (v) => rowsToMemberRecords([FORM_HEADER, formRow({ GENDER: v })])[0].gender;
  assert.deepEqual(['FEMAL', 'Female', 'FEMALE', 'MALE', 'Male'].map(g), ['female', 'female', 'female', 'male', 'male']);
});

test('phone numbers: a lost leading 0 is restored, two run-together numbers are split, a number spreadsheet-mangled into scientific notation is reported', () => {
  const p = (v) => rowsToMemberRecords([FORM_HEADER, formRow({ CONTACT: v })])[0];
  assert.equal(p('559523538').phone, '0559523538');
  assert.equal(p('243477381.0').phone, '0243477381');
  assert.equal(p('024 123 4567').phone, '024 123 4567'); // already fine: left exactly as typed
  const two = p('05481427130548142714');
  assert.equal(two.phone, '0548142713'); assert.match(two.notes, /Other number: 0548142714/);
  const lost = p('2.43477381002437e+18');
  assert.equal(lost.phone, undefined); assert.equal(lost.issues[0].field, 'phone');
});

test('an invalid email is dropped and reported, not stored', () => {
  const [r] = rowsToMemberRecords([FORM_HEADER, formRow({ 'E-MAIL': 'someone@gmail' })]);
  assert.equal(r.email, undefined); assert.equal(r.issues[0].field, 'email');
});

test('parseDateLoose reads ISO and day/month/year dates, rejects impossible ones', () => {
  assert.equal(parseDateLoose('2001-06-13 00:00:00'), '2001-06-13');
  assert.equal(parseDateLoose('13/06/2001'), '2001-06-13');
  assert.equal(parseDateLoose('06/13/2001'), '2001-06-13'); // 13 can only be a day, whichever way round it's written
  assert.equal(parseDateLoose('31/12/22'), '2022-12-31');
  assert.equal(parseDateLoose('03/04/1990', 'dmy'), '1990-04-03');
  assert.equal(parseDateLoose('03/04/1990', 'mdy'), '1990-03-04');
  assert.equal(parseDateLoose('31/02/2000'), null);
  assert.equal(parseDateLoose('Since birth'), null);
});

test('whether a birthday column is day-first or month-first is judged from the unambiguous dates in it', () => {
  const dob = (rows) => rowsToMemberRecords([FORM_HEADER, ...rows.map((v, i) => formRow({ 'FULL NAME': `P${i}`, 'DATE OF BIRTH': v }))]).map((r) => r.birthday);
  assert.deepEqual(dob(['13/06/2001', '03/04/1990']), ['2001-06-13', '1990-04-03']); // the 13 proves day-first
  assert.deepEqual(dob(['06/13/2001', '03/04/1990']), ['2001-06-13', '1990-03-04']); // the 13 proves month-first
});

test('"year joined" answers: a year or month+year becomes 1 January, a full date is kept, free text goes to notes', () => {
  const j = (v) => rowsToMemberRecords([FORM_HEADER, formRow({ 'YEAR YOU JOINED THE CHURCH': v })])[0];
  assert.equal(j('2012').joined, '2012-01-01');
  assert.equal(j('December 2006').joined, '2006-01-01');
  assert.equal(j('31/12/22').joined, '2022-12-31');
  const birth = j('Since birth');
  assert.equal(birth.joined, undefined); assert.match(birth.notes, /Joined: Since birth/);
});

test('two submissions for the same person merge into one, the later answer winning field by field', () => {
  const rows = rowsToMemberRecords([FORM_HEADER,
    formRow({ Timestamp: '2025-03-02 10:00:00', CONTACT: '0541111111', 'E-MAIL': 'None' }), // later submission is listed first
    formRow({ Timestamp: '2025-02-24 09:00:00', CONTACT: '2.4e+18', 'E-MAIL': 'first@example.com' }),
    formRow({ 'FULL NAME': 'Ama Mensah', 'DATE OF BIRTH': '1980-01-01', CONTACT: '0542222222' }), // same name, different birthday: someone else
  ]);
  assert.equal(rows.length, 2);
  const ama = rows.find((r) => r.birthday === '2001-06-13');
  assert.equal(ama.merged, 2);
  assert.equal(ama.phone, '0541111111');          // the later submission's phone wins
  assert.equal(ama.email, 'first@example.com');   // the earlier one's email survives, the later left it blank
  assert.equal(ama.issues, undefined);            // the earlier submission's bad phone was superseded
  assert.equal(rows.find((r) => r.birthday === '1980-01-01').merged, undefined);
});

test('ministry names: split on commas, match an existing ministry ignoring case and the word "Ministry", title-case a new one', () => {
  assert.deepEqual(splitMinistryNames('WOMEN MINISTRY, CHILDREN MINISTRY'), ['WOMEN MINISTRY', 'CHILDREN MINISTRY']);
  assert.deepEqual(splitMinistryNames('None'), []);
  const mins = [{ id: 'y', name: 'Youth' }, { id: 'w', name: 'Women Ministry' }];
  assert.equal(matchMinistry('YOUTH MINISTRY', mins).id, 'y');
  assert.equal(matchMinistry('women', mins).id, 'w');
  assert.equal(matchMinistry('MEN MINISTRY', mins), null);
  assert.equal(prettyMinistryName('MEN MINISTRY'), 'Men Ministry');
});

test('planMemberImport passes ministry, issues and merged count through for the view to act on', () => {
  const [a] = planMemberImport(rowsToMemberRecords([FORM_HEADER, formRow({ CONTACT: '2.4e+18' }), formRow({ CONTACT: '2.4e+18', Timestamp: '2025-03-01 00:00:00' })]), []);
  assert.equal(a.type, 'create'); assert.equal(a.fields.ministry, 'YOUTH MINISTRY');
  assert.equal(a.merged, 2); assert.equal(a.issues[0].field, 'phone');
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

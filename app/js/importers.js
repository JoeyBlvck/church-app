// Pure logic for the spreadsheet-upload features (Members and Attendance views): turning
// parsed CSV rows into member create/update actions, and turning a one-column "who was
// present" list into a set of matched member IDs. No DOM, no repo calls — kept separate so
// it's easy to unit test (see app/test/importers.test.js); the views do the actual
// repo.save() calls using the plan these functions return.

const normalizeHeader = (h) => String(h ?? '').trim().toLowerCase();

// Header names the member spreadsheet (device-pull export, or a church's own sheet) may
// use, matched case-insensitively. Matches the export columns in app/js/views/settings.js
// and app/js/views/members.js: Name, Device ID, Phone, Email, Gender, Status, Birthday, Household.
const MEMBER_HEADERS = {
  name: 'name', 'full name': 'name',
  'device id': 'deviceUserId', deviceid: 'deviceUserId', 'clock-in device id': 'deviceUserId',
  phone: 'phone', email: 'email', gender: 'gender', status: 'status', birthday: 'birthday', household: 'household',
};

// Turn a raw parseCSV() result (first row = header) into plain objects with only the
// columns this app understands, trimmed, with blank cells dropped (so a blank cell never
// overwrites existing data downstream — the caller only sees the keys a row actually filled in).
export function rowsToMemberRecords(csvRows) {
  if (!csvRows.length) return [];
  const keys = csvRows[0].map((h) => MEMBER_HEADERS[normalizeHeader(h)] ?? null);
  return csvRows.slice(1)
    .filter((r) => r.some((c) => String(c ?? '').trim()))
    .map((r) => {
      const obj = {};
      keys.forEach((key, i) => { if (!key) return; const v = String(r[i] ?? '').trim(); if (v) obj[key] = v; });
      return obj;
    });
}

// Match a parsed row to an existing member: by device ID first (if the row has one and it
// matches a member's stored device ID), otherwise by exact case-insensitive name.
export function matchMemberRow(row, members) {
  if (row.deviceUserId) {
    const byId = members.find((m) => m.deviceUserId && String(m.deviceUserId) === String(row.deviceUserId));
    if (byId) return byId;
  }
  if (row.name) {
    const byName = members.find((m) => (m.name ?? '').toLowerCase() === row.name.toLowerCase());
    if (byName) return byName;
  }
  return null;
}

const MEMBER_FIELDS = ['name', 'phone', 'email', 'gender', 'birthday', 'status', 'deviceUserId'];

// Pure: decide what to do with each parsed row. Returns one action per row:
//  { type: 'skip', row, reason }
//  { type: 'update', id, fields }   — fields holds ONLY the non-empty columns the row gave, so
//                                      the caller can overlay them onto the existing member
//                                      without blanking out anything the row left empty.
//  { type: 'create', fields }
// `fields.household` (a plain household name, if the row gave one) is passed through
// unresolved — the view resolves/creates the household id, since that needs repo access.
export function planMemberImport(rows, members) {
  return rows.map((row) => {
    if (!row.name) return { type: 'skip', row, reason: 'missing name' };
    const fields = {};
    for (const k of MEMBER_FIELDS) if (row[k]) fields[k] = row[k];
    if (row.household) fields.household = row.household;
    const existing = matchMemberRow(row, members);
    return existing ? { type: 'update', id: existing.id, fields } : { type: 'create', fields };
  });
}

// ---- attendance spreadsheet upload: a bare "who was present" list, one column of either
// a name or a clock-in device ID, with or without a header row. ----

const NAME_OR_ID_HEADERS = new Set(['name', 'full name', 'device id', 'deviceid', 'id', 'clock-in device id']);

// Take the first column of every row as one identifier (name or device ID); drop a leading
// header row if the first row's first cell looks like a header rather than real data.
export function extractAttendanceEntries(csvRows) {
  if (!csvRows.length) return [];
  const rows = NAME_OR_ID_HEADERS.has(normalizeHeader(csvRows[0]?.[0])) ? csvRows.slice(1) : csvRows;
  return rows.map((r) => String(r[0] ?? '').trim()).filter(Boolean);
}

// Match one identifier (name or device ID) to a member, same precedence as matchMemberRow.
export function matchIdentifier(value, members) {
  const v = String(value).trim();
  const byId = members.find((m) => m.deviceUserId && String(m.deviceUserId) === v);
  if (byId) return byId;
  return members.find((m) => (m.name ?? '').toLowerCase() === v.toLowerCase()) ?? null;
}

// Pure: turn the identifier list into the member IDs to mark present, plus whichever
// entries didn't match anyone (surfaced so staff can fix the spreadsheet or the member record).
export function planAttendanceImport(values, members) {
  const presentIds = new Set(), unmatched = [];
  for (const v of values) {
    const m = matchIdentifier(v, members);
    if (m) presentIds.add(m.id); else unmatched.push(v);
  }
  return { presentIds: [...presentIds], unmatched };
}

// ---- Hikvision clock-in device "record list" export: the raw event log a terminal's own
// web UI lets you download (often auto-saved as recordListAutoRecovered_*.csv) — every single
// check-in/out swipe, across as many days as the device has on file. Completely different
// shape from the plain "who was present, for one date" list above: many columns, one row per
// swipe (not per person), and a date on every row instead of one picked in the app. Detected
// automatically by its header row, so staff upload it from the same "Upload spreadsheet"
// button without needing to say which kind of file it is.
const HIKVISION_HEADERS = ['sname', 'sjobno', 'date', 'time'];

// A cell as the device writes it: numeric-looking values are prefixed with a bare "'" (Excel's
// force-text marker, e.g. "'27" so a job number isn't read as a number), and a swipe with no
// enrolled name/card comes through as the literal text "NULL" rather than a blank cell.
const stripHikCell = (v) => String(v ?? '').trim().replace(/^'/, '').trim();
const isHikNull = (v) => !v || v.toUpperCase() === 'NULL';

// "1/2/2025" (the device's own M/D/YYYY, no leading zeros) -> "2025-01-02", matching every
// other date field in the app (fmtDate, <input type=date>, sorting, repo.save('attendance')).
function normalizeHikDate(d) {
  const m = String(d ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, day, yr] = m;
  return `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// True when a parsed CSV's header row matches a Hikvision recordList export, so the caller
// can route it here instead of extractAttendanceEntries()'s one-column format.
export function looksLikeHikvisionLog(csvRows) {
  const head = (csvRows[0] ?? []).map(normalizeHeader);
  return HIKVISION_HEADERS.every((h) => head.includes(h));
}

// Collapse the raw event log to one entry per person per day they clocked in at all —
// whether that's a single checkIn or a checkIn/break/checkOut/overtime flurry, the church's
// own attendance record only tracks presence for the day, not shift detail. A swipe with no
// enrolled name (sName "NULL" — a card/face the device didn't recognize) is dropped; there's
// no one to mark present. Returns one { date, name, jobNo } per person per day, `jobNo` ''
// when the device has no job/person number for them.
export function parseHikvisionLog(csvRows) {
  if (!csvRows.length) return [];
  const head = csvRows[0].map(normalizeHeader);
  const iName = head.indexOf('sname'), iJob = head.indexOf('sjobno'), iDate = head.indexOf('date');
  if (iName < 0 || iDate < 0) return [];
  const seen = new Map();
  for (const r of csvRows.slice(1)) {
    const name = stripHikCell(r[iName]);
    const date = normalizeHikDate(r[iDate]);
    if (!date || isHikNull(name)) continue;
    const jobNo = iJob >= 0 ? stripHikCell(r[iJob]) : '';
    const key = `${date}|${jobNo || name.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { date, name, jobNo: isHikNull(jobNo) ? '' : jobNo });
  }
  return [...seen.values()];
}

// Pure: turn the day-collapsed log entries into what the view needs to do — grouped by date
// so one attendance record is made per day the device saw anyone, plus which members to
// create or update along the way. Matching follows the same device-ID-first, then
// case-insensitive-name precedence as matchIdentifier/matchMemberRow:
//  - already a member (by job number or name): just marked present that day — UNLESS the
//    match was by name only and the device has a job number this member doesn't have on file
//    yet, in which case that's the one kind of "update" this import makes: backfilling their
//    Clock-in device ID so future imports (and the live device bridge) match them by ID too.
//  - nobody in the register yet: queued to create, using the device's own enrolled name and
//    job number — but only once per person even if the log has them on 50 different days, and
//    never created twice by a second import of the same (or an overlapping) file.
export function planHikvisionImport(entries, members) {
  const byDate = new Map(); // date -> Set(member id | 'new:<key>')
  const toCreate = new Map(); // key -> { key, name, deviceUserId }
  const toBackfill = new Map(); // member id -> deviceUserId
  for (const { date, name, jobNo } of entries) {
    let member = jobNo ? members.find((m) => m.deviceUserId && String(m.deviceUserId) === jobNo) : null;
    if (!member) member = members.find((m) => (m.name ?? '').toLowerCase() === name.toLowerCase());
    let key;
    if (member) {
      key = member.id;
      if (jobNo && !member.deviceUserId) toBackfill.set(member.id, jobNo);
    } else {
      key = `new:${jobNo || name.toLowerCase()}`;
      if (!toCreate.has(key)) toCreate.set(key, { key, name, deviceUserId: jobNo || undefined });
    }
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date).add(key);
  }
  return {
    days: [...byDate.entries()].map(([date, keys]) => ({ date, keys: [...keys] })).sort((a, b) => a.date.localeCompare(b.date)),
    toCreate: [...toCreate.values()],
    toBackfill: [...toBackfill.entries()].map(([id, deviceUserId]) => ({ id, deviceUserId })),
  };
}

// ---- attributing a clock-in day to a service/ministry ----
// Shared by the live Hikvision bridge (server/hikvision-bridge.js) and the CSV device-log
// import above, so a check-in is filed the same way whichever path recorded it: Sunday is
// always the whole church's main service, and every other day is attributed to whichever
// ministry has that day in its own meeting schedule (set on the ministry's own page --
// app/js/views/ministries.js's meetDays). A shared clock-in device has no way to know which
// specific gathering someone actually attended, so a day with no ministry meeting scheduled at
// all has nothing to attribute a check-in to -- attendanceTargetForDay returns null for that,
// meaning "skip this day's check-ins", not "file them under some generic guess".
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Mirrors ministries.js's own (unexported) meetDaysOf: meetDays (plural) is the current field;
// meetDay (singular) is read as a one-day meetDays for a ministry saved before meetDays existed.
const meetDaysOf = (m) => (m.meetDays?.length ? m.meetDays : m.meetDay ? [m.meetDay] : []);

// dateStr is always a plain "YYYY-MM-DD" here (attendance records, the bridge's own polling
// window, and this import all agree on that format) -- read as UTC so this doesn't depend on
// whatever time zone the machine running it happens to be in.
export function dayNameFor(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

export function attendanceTargetForDay(dateStr, ministries, { sundayService = 'Sunday service' } = {}) {
  const day = dayNameFor(dateStr);
  if (day === 'Sunday') return { ministryId: undefined, service: sundayService };
  const meeting = ministries.filter((m) => meetDaysOf(m).includes(day));
  if (!meeting.length) return null;
  // More than one ministry scheduled the same day -- pick one deterministically (alphabetically
  // by name) rather than recording it under all of them (double-counts anyone who only went to
  // one) or dropping the day entirely (loses a real meeting's attendance).
  const [m] = meeting.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return { ministryId: m.id, service: `${m.name} meeting` };
}

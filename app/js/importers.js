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
  // The layout a Google Form "contact information" sheet comes out in (its question titles,
  // typos and all -- "MARIATAL STATUS" is how this church's own form spells it), plus the plain
  // spellings a church's own spreadsheet might use. The ones with no member field of their own
  // (hometown, marital status, children, occupation, parents) end up in the member's Notes.
  timestamp: 'submitted',
  'date of birth': 'birthday', dob: 'birthday',
  contact: 'phone', 'phone number': 'phone', mobile: 'phone', 'e-mail': 'email',
  'where you stay': 'address', address: 'address', residence: 'address',
  department: 'ministry', ministry: 'ministry', ministries: 'ministry',
  'year you joined the church': 'joined', 'date joined': 'joined', joined: 'joined',
  'home town': 'hometown', hometown: 'hometown',
  'mariatal status': 'marital', 'marital status': 'marital',
  'number of children': 'children', occupation: 'occupation',
  "father's name": 'father', "mother's name": 'mother',
};

// ---- cleaning the raw cells of a member row ----
// "None", "N/A", "-" and friends are how people say "nothing" in a free-text form field.
const isBlankish = (v) => !v || /^(none|n\/a|na|nil|null|-+)$/i.test(String(v).trim());
const titleCase = (s) => String(s).trim().toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

// Reads "2001-06-13", "13/06/2001", "6/13/2001" or "31/12/22" into "YYYY-MM-DD", or null if it's
// not a real date. A day or month that can only be one thing settles the order by itself
// ("13/06" can only be day/month); when both are 12 or under, `order` ('dmy' or 'mdy') decides.
export function parseDateLoose(value, order = 'dmy') {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let y, mo, d, m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) { [y, mo, d] = m.slice(1).map(Number); }
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const a = Number(m[1]), b = Number(m[2]);
    [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : order === 'mdy' ? [b, a] : [a, b];
    y = m[3].length === 2 ? (Number(m[3]) < 50 ? 2000 : 1900) + Number(m[3]) : Number(m[3]);
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Whether a column of day/month/year dates is written day-first or month-first, judged by the
// dates in it that can only be one or the other (a 25 can't be a month). With no evidence either
// way it's day-first -- the order this app's own Ghana users write dates in.
function inferDateOrder(values) {
  let dmy = 0, mdy = 0;
  for (const v of values) {
    const m = String(v ?? '').trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++; else if (Number(m[2]) > 12) mdy++;
  }
  return mdy > dmy ? 'mdy' : 'dmy';
}

// Ghana mobile numbers are 10 digits with a leading 0. Spreadsheets damage them in a few
// recognisable ways, so: a 9-digit number lost its leading 0 (put it back); two numbers typed
// into one cell run together as 20 digits (keep the first as the phone, the second goes to notes);
// and one an Excel-style column turned into scientific notation ("2.4E+18") is gone for good --
// report it rather than store garbage. Anything else is kept exactly as typed.
function cleanPhone(raw) {
  if (isBlankish(raw)) return {};
  const typed = raw.replace(/\.0+$/, '');
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(typed)) return { issue: 'phone number was turned into scientific notation by the spreadsheet and can\'t be recovered -- ask them for it again' };
  const digits = typed.replace(/\D/g, '');
  if (digits.length === 9 && !digits.startsWith('0')) return { phone: `0${digits}` };
  if (/^0\d{9}0\d{9}$/.test(digits)) return { phone: digits.slice(0, 10), other: digits.slice(10) };
  if (digits.length > 13) return { issue: `phone "${raw}" doesn't look like a phone number` };
  return { phone: typed };
}

// Year-only answers ("2012", "December 2006", "Late 2000") become 1 January of that year; a full
// date is kept as is; anything else ("Since birth") can't be a date, so it goes to notes instead.
function parseJoined(raw, order) {
  const full = parseDateLoose(raw, order);
  if (full) return full;
  const y = String(raw).match(/\b(19\d{2}|20\d{2})\b/);
  return y && Number(y[1]) <= new Date().getFullYear() ? `${y[1]}-01-01` : null;
}

// Form answers that are real (optional) fields on a member, keyed raw-header-name -> member field.
const PROFILE_FIELDS = { hometown: 'hometown', marital: 'maritalStatus', children: 'children', occupation: 'occupation', father: 'fatherName', mother: 'motherName' };

// One raw row (keys as in MEMBER_HEADERS' values) -> the tidy row the importer plans from.
function tidyMemberRow(row, order) {
  const out = {}, issues = [], notes = [];
  for (const k of ['name', 'deviceUserId', 'status', 'household', 'address']) if (row[k]) out[k] = row[k].replace(/\s+/g, ' ');
  if (row.gender) { const g = row.gender.toLowerCase(); if (g.startsWith('f')) out.gender = 'female'; else if (g.startsWith('m')) out.gender = 'male'; }
  if (row.birthday) {
    const b = parseDateLoose(row.birthday, order);
    if (b) out.birthday = b; else issues.push({ field: 'birthday', message: `birthday "${row.birthday}" isn't a date I understand` });
  }
  if (row.phone) {
    const p = cleanPhone(row.phone);
    if (p.phone) out.phone = p.phone;
    if (p.issue) issues.push({ field: 'phone', message: p.issue });
    if (p.other) notes.push(`Other number: ${p.other}`);
  }
  if (row.email && !isBlankish(row.email)) {
    const e = row.email.toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) out.email = e; else issues.push({ field: 'email', message: `email "${row.email}" isn't valid` });
  }
  if (row.joined && !isBlankish(row.joined)) {
    const j = parseJoined(row.joined, order);
    if (j) out.joined = j; else notes.push(`Joined: ${row.joined}`);
  }
  if (row.ministry && !isBlankish(row.ministry)) out.ministry = row.ministry;
  for (const [k, field] of Object.entries(PROFILE_FIELDS)) {
    if (!row[k] || isBlankish(row[k])) continue;
    out[field] = k === 'marital' ? titleCase(row[k]) : k === 'children' ? row[k].replace(/\.0+$/, '') : row[k].replace(/\s+/g, ' ');
  }
  if (notes.length) out.notes = notes.join(' · ');
  if (issues.length) out.issues = issues;
  return out;
}

// Two form submissions for the same person (same name and birthday) become one record: later
// submissions overwrite earlier ones field by field, so the most recent answer wins but anything
// only the earlier one filled in is kept. `merged` counts how many submissions were folded in.
function mergeDuplicateRows(rows) {
  const byKey = new Map(), order = [];
  for (const r of rows) {
    if (!r.name) { order.push(r); continue; }
    const key = `${r.name.toLowerCase()}|${r.birthday ?? ''}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...r, merged: 1 }); order.push(byKey.get(key)); continue; }
    const issues = [...(prev.issues ?? []), ...(r.issues ?? [])];
    Object.assign(prev, r, { merged: prev.merged + 1 });
    prev.issues = issues;
  }
  for (const r of order) {
    // A problem only stands if no submission supplied a usable value for that field.
    if (r.issues) { r.issues = r.issues.filter((i) => r[i.field] === undefined); if (!r.issues.length) delete r.issues; }
    if (r.merged === 1) delete r.merged;
  }
  return order;
}

// Turn a raw parseCSV() result (first row = header) into plain objects with only the
// columns this app understands, trimmed, with blank cells dropped (so a blank cell never
// overwrites existing data downstream — the caller only sees the keys a row actually filled in).
// Beyond trimming, values are tidied for this app: gender to male/female, dates to YYYY-MM-DD,
// phone numbers repaired where they can be, "None" treated as empty -- and anything that
// couldn't be used comes back in the row's `issues` so the person can fix it by hand. Form
// responses submitted twice for the same person are merged (see mergeDuplicateRows).
export function rowsToMemberRecords(csvRows) {
  if (!csvRows.length) return [];
  const keys = csvRows[0].map((h) => MEMBER_HEADERS[normalizeHeader(h).replace(/[‘’]/g, "'")] ?? null);
  const raw = csvRows.slice(1)
    .filter((r) => r.some((c) => String(c ?? '').trim()))
    .map((r) => {
      const obj = {};
      keys.forEach((key, i) => { if (!key) return; const v = String(r[i] ?? '').trim(); if (v) obj[key] = v; });
      return obj;
    });
  // A form sheet's own Timestamp column says which of two submissions is the later one.
  if (raw.every((r) => !r.submitted || !Number.isNaN(Date.parse(r.submitted)))) {
    raw.sort((a, b) => (a.submitted && b.submitted ? Date.parse(a.submitted) - Date.parse(b.submitted) : 0));
  }
  const order = inferDateOrder(raw.flatMap((r) => [r.birthday, r.joined]));
  return mergeDuplicateRows(raw.map((r) => tidyMemberRow(r, order)));
}

// ---- ministries named in a sheet's Department column ----
// "WOMEN MINISTRY, CHILDREN MINISTRY" is two ministries. Names are compared ignoring case and the
// word "Ministry" itself, so a sheet's "YOUTH MINISTRY" finds a ministry the church already
// called just "Youth".
export const splitMinistryNames = (raw) => String(raw ?? '').split(/[,;]/).map((s) => s.trim()).filter((s) => s && !isBlankish(s));
const ministryKey = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\b(ministry|ministries|department|dept)\b/g, ' ').replace(/\s+/g, ' ').trim();
export const matchMinistry = (name, ministries) => { const k = ministryKey(name); return k ? ministries.find((m) => ministryKey(m.name) === k) ?? null : null; };
export const prettyMinistryName = titleCase;

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

const MEMBER_FIELDS = ['name', 'phone', 'email', 'gender', 'birthday', 'status', 'deviceUserId', 'address', 'joined', 'notes',
  'hometown', 'maritalStatus', 'children', 'occupation', 'fatherName', 'motherName'];

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
    // Ministry names (still raw text) are resolved to ids by the view, like household names.
    if (row.ministry) fields.ministry = row.ministry;
    const existing = matchMemberRow(row, members);
    const action = existing ? { type: 'update', id: existing.id, fields } : { type: 'create', fields };
    // What went wrong with this row's data, and whether it stands for several form submissions,
    // so the view can report both -- only present when there's something to report.
    if (row.issues) action.issues = row.issues;
    if (row.merged) action.merged = row.merged;
    return action;
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
// Exported so the Attendance view (app/js/views/attendance.js) can build its own per-day filter
// tabs in calendar order, rather than keeping a second copy of this list.
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

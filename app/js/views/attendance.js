import { h, field, val, opts, byName, today, fmtDate, modal, confirmDialog, toast, empty, barChart, attendanceCount, attendanceChecklist, bulkBar, sum, download, toCsv, pdfHeader } from '../ui.js';
import { icon } from '../icons.js';
import { parseCSV } from '../csv.js';
import { extractAttendanceEntries, planAttendanceImport, looksLikeHikvisionLog, parseHikvisionLog, planHikvisionImport, attendanceTargetForDay, dayNameFor } from '../importers.js';

// Exported so ministries.js's own inline attendance panel (take/edit/delete a ministry's own
// attendance without leaving the ministry) can offer the same service datalist.
export const SERVICES = ['Sunday service', 'Midweek service', 'Prayer meeting', 'Bible study', 'Youth meeting', 'Choir rehearsal', 'Special service'];
const PAGE_SIZES = [10, 20, 50, 100, 200];

// Sort direction, page size and which dates are expanded — kept at module scope (like
// members.js's selectedMemberId) rather than as local state inside attendanceView(), because a
// record save/delete calls the app's outer rerender(), which throws away and rebuilds this whole
// view from scratch. Without this surviving the remount, taking attendance would silently reset
// you to page 1, the default sort, and every date fold closed.
let sortDir = 'desc'; // 'desc' = newest date first, 'asc' = oldest first
let pageSize = 20;
let currentPage = 1;
let expandedDates = new Set();
// 'all' | 'sunday' | 'weekday' — which record IS a Sunday record is decided purely from the
// record's own date (dayNameFor, the same calendar-based day-of-week check the Hikvision bridge
// and CSV import use), never from what its `service` name happens to say — a record can be
// named "Sunday service" and still get filed here as a weekday record if its date isn't
// actually a Sunday, and that's deliberate: the filter reflects the calendar, not a label.
let dayGroup = 'all';

export async function attendanceView({ repo, user, ministries, members, rerender, initialMinistryId = '' }) {
  const [recsRaw, churchName, settingsList] = await Promise.all([repo.list('attendance'), repo.churchName(), repo.list('settings')]);
  const recs = recsRaw.sort((a, b) => b.date.localeCompare(a.date));
  const cs = settingsList.find((s) => s.id === 'church') ?? {};
  const isLeader = user.role === 'leader';
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const roster = members.filter((m) => m.status !== 'inactive' && m.status !== 'deceased').sort(byName);
  // Arriving via a ministry's own "View attendance" button (ministries.js) pre-filters to that
  // ministry — including the whole-church (no ministryId) records that reflect into it, since
  // leaders/admins can now read those for members who belong to this ministry (permissions.js).
  let ministryFilter = !isLeader ? initialMinistryId : '';

  const takeForm = (rec = {}) => {
    const checklist = attendanceChecklist(roster, rec);
    const ministrySel = h('select', { name: 'ministryId' }, !isLeader && h('option', { value: '' }, 'Whole church'), opts(ministries.slice().sort(byName).map((m) => [m.id, m.name]), rec.ministryId));
    const counter = h('span', { class: 'hint' });
    const recount = () => { const c = checklist.counts(); counter.textContent = `${c.present} present · ${c.late} late · ${c.excused} excused`; };
    checklist.onChange(recount);
    const svc = h('input', { name: 'service', required: true, value: rec.service ?? SERVICES[0], list: 'svc-list' });
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const { presentIds, lateIds, excusedIds } = checklist.result();
      await repo.save('attendance', { ...rec, date: val(f, 'date'), service: val(f, 'service'), ministryId: val(f, 'ministryId') || undefined, presentIds, lateIds, excusedIds, extra: Number(val(f, 'extra')) || 0 });
      dlg.close(); toast('Attendance saved'); rerender();
    } },
      h('datalist', { id: 'svc-list' }, SERVICES.map((s) => h('option', { value: s }))),
      h('div', { class: 'row' }, field('Date', h('input', { name: 'date', type: 'date', value: rec.date ?? today(), required: true })), field('Service / meeting', svc),
        field('For', ministrySel), field('Extra headcount', h('input', { name: 'extra', type: 'number', min: 0, value: rec.extra ?? 0 }), 'Visitors or children not on the register')),
      h('div', { class: 'filters' }, h('input', { type: 'search', placeholder: 'Find a member…', oninput: (e) => checklist.filter(e.target.value) }),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: checklist.markAllShown }, 'Mark all shown'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: checklist.clear }, 'Clear'), counter),
      roster.length ? checklist.el : empty('Add members first to tick them present — or just enter a headcount.'),
      h('p', { class: 'actions' }, h('button', { class: 'btn' }, rec.id ? 'Save changes' : 'Save attendance')));
    const dlg = modal(rec.id ? 'Edit attendance' : 'Take attendance', f, { wide: true }); recount();
  };

  const openDetail = (r) => {
    const allMembers = roster.concat(members.filter((m) => m.status === 'inactive' || m.status === 'deceased'));
    const namesOf = (ids) => allMembers.filter((m) => ids?.includes(m.id)).map((m) => m.name);
    const presentNames = namesOf(r.presentIds), lateNames = namesOf(r.lateIds), excusedNames = namesOf(r.excusedIds);
    const dlg = modal(`${r.service} · ${fmtDate(r.date)}`, h('div', {},
      h('p', { class: 'hint' }, `${r.ministryId ? mName[r.ministryId] ?? 'Ministry' : 'Whole church'} · ${presentNames.length} present · ${lateNames.length} late · ${excusedNames.length} excused${r.extra ? ` · ${r.extra} extra` : ''}`),
      presentNames.length ? h('p', {}, presentNames.map((n) => h('span', { class: 'pill good' }, n))) : null,
      lateNames.length ? h('p', {}, h('b', {}, 'Late: '), lateNames.map((n) => h('span', { class: 'pill warn' }, n))) : null,
      excusedNames.length ? h('p', {}, h('b', {}, 'Excused: '), excusedNames.map((n) => h('span', { class: 'pill muted' }, n))) : null,
      !presentNames.length && !lateNames.length && !excusedNames.length ? empty('No individual names recorded.') : null,
      h('p', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { dlg.close(); takeForm(r); } }, 'Edit'),
        h('button', { class: 'btn del', onclick: async () => { if (await confirmDialog('Delete this attendance record?')) { await repo.remove('attendance', r.id); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Delete'))));
  };

  // ---- upload an attendance spreadsheet — two formats, told apart automatically ----
  // (1) a bare "who was present, for one date" list: one column of names or clock-in device
  //     IDs, with or without a header row (the plain path below, unchanged).
  // (2) a Hikvision clock-in device's own exported record log (often saved as
  //     recordListAutoRecovered_*.csv from the device's web UI): every check-in/out swipe,
  //     across however many days the device has on file, with its own Date column — so unlike
  //     (1), it brings its own dates and can add one attendance record per day in a single
  //     upload. It can also create members: anyone the device recognizes (by its enrolled
  //     name and job number) who isn't in the register yet is added automatically; someone
  //     already registered is only ever matched, never duplicated, though if they were matched
  //     by name alone and didn't have a Clock-in device ID on file, this backfills it from the
  //     log so future imports (and the live device bridge) match them by ID too.
  const importDate = h('input', { type: 'date', value: today() });

  const importHikvisionLog = async (rows) => {
    const entries = parseHikvisionLog(rows);
    if (!entries.length) return toast('No recognizable clock-in records found in that file.', 'err');
    const plan = planHikvisionImport(entries, members);
    const idFor = new Map();
    for (const c of plan.toCreate) idFor.set(c.key, await repo.save('members', { name: c.name, deviceUserId: c.deviceUserId, status: 'member', joined: today() }));
    for (const { id, deviceUserId } of plan.toBackfill) {
      const existing = members.find((m) => m.id === id);
      if (existing) await repo.save('members', { ...existing, deviceUserId });
    }
    let imported = 0, skipped = 0;
    for (const { date, keys } of plan.days) {
      // Sunday goes to the whole-church service; any other day is attributed to whichever
      // ministry meets that day (its own meetDays schedule) — a day with no ministry meeting
      // scheduled at all has nothing to attribute these check-ins to, so it's skipped rather
      // than filed under some generic "Clock-in device" bucket (see importers.js).
      const target = attendanceTargetForDay(date, ministries);
      if (!target) { skipped++; continue; }
      imported++;
      const presentIds = keys.map((k) => idFor.get(k) ?? k);
      const existing = recs.find((r) => r.date === date && r.service === target.service && (r.ministryId ?? undefined) === target.ministryId);
      const merged = new Set([...(existing?.presentIds ?? []), ...presentIds]);
      // A clock-in device can only ever report "was here" — if someone previously marked Late or
      // Excused by hand now shows up in the device log, that's an upgrade to Present, not a
      // second, conflicting status alongside it.
      const lateIds = (existing?.lateIds ?? []).filter((id) => !merged.has(id));
      const excusedIds = (existing?.excusedIds ?? []).filter((id) => !merged.has(id));
      await repo.save('attendance', { ...existing, date, service: target.service, ministryId: target.ministryId, presentIds: [...merged], lateIds, excusedIds, extra: existing?.extra ?? 0 });
    }
    let msg = `${imported} day${imported === 1 ? '' : 's'} of attendance imported from the device log`;
    if (skipped) msg += `, ${skipped} day${skipped === 1 ? '' : 's'} skipped (no service or ministry meeting scheduled)`;
    if (plan.toCreate.length) msg += `, ${plan.toCreate.length} new member${plan.toCreate.length === 1 ? '' : 's'} added`;
    if (plan.toBackfill.length) msg += `, ${plan.toBackfill.length} linked to a clock-in ID`;
    toast(msg, imported ? 'ok' : 'err');
    rerender();
  };

  const importFile = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none', onchange: async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    const rows = parseCSV(await file.text());
    if (looksLikeHikvisionLog(rows)) return importHikvisionLog(rows);
    const entries = extractAttendanceEntries(rows);
    const { presentIds, unmatched } = planAttendanceImport(entries, members);
    const date = importDate.value || today();
    const existing = recs.find((r) => r.date === date && r.service === 'Attendance upload' && !r.ministryId);
    const merged = new Set([...(existing?.presentIds ?? []), ...presentIds]);
    // Same upgrade-not-conflict reasoning as the device-log import above.
    const lateIds = (existing?.lateIds ?? []).filter((id) => !merged.has(id));
    const excusedIds = (existing?.excusedIds ?? []).filter((id) => !merged.has(id));
    await repo.save('attendance', { ...existing, date, service: 'Attendance upload', ministryId: undefined, presentIds: [...merged], lateIds, excusedIds, extra: existing?.extra ?? 0 });
    let msg = `${presentIds.length} marked present`;
    if (unmatched.length) msg += `, ${unmatched.length} not matched: ${unmatched.slice(0, 8).join(', ')}${unmatched.length > 8 ? '…' : ''}`;
    toast(msg, presentIds.length ? 'ok' : 'err');
    rerender();
  } });
  const uploadCard = h('div', { class: 'card noprint' }, h('b', {}, 'Upload attendance spreadsheet'),
    h('p', { class: 'hint' }, 'Either a plain "who was present" list for one date — one column of names or clock-in device IDs, with or without a header row — or your clock-in device\'s own exported record log, which is recognized automatically and brings its own dates (one attendance record per day it covers, filed under Sunday\'s main service or whichever ministry meets that day per its own schedule — a day with neither is skipped). The device log also registers anyone it recognizes who isn\'t a member yet; existing members are only ever matched, never duplicated.'),
    h('div', { class: 'row' }, field('Date', importDate, 'Only used for the plain "who was present" list — a device log carries its own dates.'),
      field('Spreadsheet', h('button', { type: 'button', class: 'btn ghost', onclick: () => importFile.click() }, icon('upload', { size: 15 }), 'Upload spreadsheet'))), importFile);

  const trend = recs.filter((r) => !r.ministryId).slice(0, 8).reverse().map((r) => ({ label: r.date.slice(5), value: attendanceCount(r) }));

  // ---- ministry filter: when set, shows that ministry's own records plus whole-church ones
  // (its members may well have attended the main service too — permissions.js now lets a
  // leader read those alongside their own ministry's records) — with an extra column counting
  // how many of THIS ministry's members were present in each record, alongside its own total.
  const tableCard = h('div', { class: 'card' });
  // ---- bulk delete: select several attendance records (checkbox column) and remove them all
  // at once, instead of opening each one's own detail modal just to delete it.
  const sel = bulkBar([{ label: 'Delete', danger: true, run: async (ids) => {
    if (!(await confirmDialog(`Delete ${ids.length} attendance record${ids.length === 1 ? '' : 's'}? This can't be undone.`, 'Delete'))) return;
    for (const id of ids) await repo.remove('attendance', id);
    toast(`${ids.length} attendance record${ids.length === 1 ? '' : 's'} deleted`); rerender();
  } }]);
  const DAY_GROUPS = [['all', 'All'], ['sunday', 'Sundays'], ['weekday', 'Weekdays']];
  const drawTable = () => {
    const ministryMemberIds = ministryFilter ? new Set(members.filter((m) => m.ministryIds?.includes(ministryFilter)).map((m) => m.id)) : null;
    // Sunday vs. weekday is read straight off each record's own date (dayNameFor), never off its
    // `service` text — see the note by `dayGroup` above.
    const rows = recs.filter((r) => (!ministryFilter || r.ministryId === ministryFilter || !r.ministryId)
      && (dayGroup === 'all' || (dayNameFor(r.date) === 'Sunday') === (dayGroup === 'sunday')));
    const heads = ['Service', 'For', 'Total', 'Late', 'Excused', ...(ministryMemberIds ? [`${mName[ministryFilter] ?? 'Ministry'} present`] : [])];

    // ---- group into one fold per date, newest (or oldest) date first ----
    const byDate = new Map();
    for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
    const dateGroups = [...byDate.entries()].sort((a, b) => (sortDir === 'asc' ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0])));

    // ---- paginate the date folds themselves, not the raw records: that's the unit the person
    // actually sees and clicks through, so it's what "20 per page" should count. ----
    const totalPages = Math.max(1, Math.ceil(dateGroups.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const pageGroups = dateGroups.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    const pageRows = pageGroups.flatMap(([, dayRecs]) => dayRecs);

    // Export CSV / PDF — scoped to the current ministry AND day-group filters, but every
    // matching record across every page, not just what's currently on screen (a report that
    // silently dropped whatever page you weren't looking at would be worse than no export at all).
    const scope = (ministryFilter ? mName[ministryFilter] ?? 'Ministry' : 'Whole church')
      + (dayGroup === 'sunday' ? ' — Sundays' : dayGroup === 'weekday' ? ' — Weekdays' : '');
    const exportCsv = () => download(`attendance-${scope.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`, toCsv([['date', 'service', 'for', 'total present', 'late', 'excused', ...(ministryMemberIds ? [`${scope} present`] : [])],
      ...rows.map((r) => [r.date, r.service, r.ministryId ? mName[r.ministryId] ?? '' : 'Whole church', attendanceCount(r), (r.lateIds ?? []).length, (r.excusedIds ?? []).length,
        ...(ministryMemberIds ? [(r.presentIds ?? []).filter((id) => ministryMemberIds.has(id)).length] : [])])]), 'text/csv');
    const printHead = pdfHeader(churchName, cs, `Attendance report — ${scope}`,
      h('div', {}, `${rows.length} record${rows.length === 1 ? '' : 's'}`), user.name);
    const printTable = h('table', { class: 'print-table' },
      h('thead', {}, h('tr', {}, ['Date', ...heads].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, fmtDate(r.date)), h('td', {}, r.service), h('td', {}, r.ministryId ? mName[r.ministryId] ?? '' : 'Whole church'), h('td', {}, attendanceCount(r)),
        h('td', {}, (r.lateIds ?? []).length), h('td', {}, (r.excusedIds ?? []).length),
        ministryMemberIds && h('td', {}, (r.presentIds ?? []).filter((id) => ministryMemberIds.has(id)).length)))));

    const dayTabs = h('div', { class: 'tabs' }, DAY_GROUPS.map(([key, label]) => h('button', { type: 'button', class: `tab ${dayGroup === key ? 'on' : ''}`,
      onclick: () => { dayGroup = key; currentPage = 1; drawTable(); } }, label)));

    const controls = h('div', { class: 'filters' },
      !isLeader && ministries.length > 0 && h('select', { onchange: (e) => { ministryFilter = e.target.value; currentPage = 1; drawTable(); } },
        h('option', { value: '' }, 'All ministries'), opts(ministries.slice().sort(byName).map((m) => [m.id, m.name]), ministryFilter)),
      h('select', { 'aria-label': 'Sort by date', onchange: (e) => { sortDir = e.target.value; currentPage = 1; drawTable(); } },
        opts([['desc', 'Newest first'], ['asc', 'Oldest first']], sortDir)),
      h('select', { 'aria-label': 'Records per page', onchange: (e) => { pageSize = Number(e.target.value); currentPage = 1; drawTable(); } },
        opts(PAGE_SIZES.map((n) => [n, `${n} per page`]), pageSize)),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => window.print() }, icon('print', { size: 14 }), 'Export PDF'),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: exportCsv }, icon('download', { size: 14 }), 'Export CSV'),
      pageRows.length > 0 && h('label', { class: 'check' }, sel.headBox(), ' Select all on this page'));

    const dateFolds = pageGroups.map(([date, dayRecs]) => {
      const dayTotal = sum(dayRecs, attendanceCount);
      return h('details', { class: 'attendance-fold', open: expandedDates.has(date),
        ontoggle: (e) => { if (e.target.open) expandedDates.add(date); else expandedDates.delete(date); } },
        h('summary', {}, icon('chevronDown', { size: 15, cls: 'chev' }), h('b', {}, fmtDate(date)),
          h('span', { class: 'fold-meta' }, `${dayRecs.length} record${dayRecs.length === 1 ? '' : 's'} · ${dayTotal} total present`)),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', { class: 'sel-col' }, ''), heads.map((t) => h('th', {}, t)))),
          h('tbody', {}, dayRecs.map((r) => h('tr', { class: 'click', onclick: () => openDetail(r) },
            h('td', { class: 'sel-col', onclick: (e) => e.stopPropagation() }, sel.box(r.id)),
            h('td', {}, r.service), h('td', {}, r.ministryId ? mName[r.ministryId] ?? '' : 'Whole church'), h('td', {}, attendanceCount(r)),
            h('td', {}, (r.lateIds ?? []).length), h('td', {}, (r.excusedIds ?? []).length),
            ministryMemberIds && h('td', {}, (r.presentIds ?? []).filter((id) => ministryMemberIds.has(id)).length))))));
    });

    const pager = dateGroups.length > pageSize || totalPages > 1 ? h('div', { class: 'pager' },
      h('button', { type: 'button', class: 'btn ghost sm', disabled: currentPage <= 1, onclick: () => { currentPage--; drawTable(); } }, '‹ Prev'),
      h('span', { class: 'hint' }, `Page ${currentPage} of ${totalPages} · ${dateGroups.length} date${dateGroups.length === 1 ? '' : 's'}`),
      h('button', { type: 'button', class: 'btn ghost sm', disabled: currentPage >= totalPages, onclick: () => { currentPage++; drawTable(); } }, 'Next ›')) : null;

    // .filter(Boolean): unlike h()'s own children (which drop a bare `false`/`null`),
    // replaceChildren() is a native DOM method — it has no such filtering, and stringifies a
    // falsy non-node argument into a literal "false" text node instead of just omitting it.
    tableCard.replaceChildren(printHead, printTable, h('div', { class: 'noprint' }, ...[
      dayTabs,
      controls,
      rows.length && sel.bar,
      dateFolds.length ? h('div', {}, dateFolds) : empty(ministryFilter ? 'No attendance recorded for this ministry yet.'
        : dayGroup === 'sunday' ? 'No Sunday attendance recorded yet.' : dayGroup === 'weekday' ? 'No weekday attendance recorded yet.' : 'No attendance recorded yet.'),
      pager,
    ].filter(Boolean)));
    sel.sync(pageRows.map((r) => r.id));
  };
  drawTable();

  return h('div', {}, h('div', { class: 'bar' }, h('h2', {}, 'Attendance'), h('button', { class: 'btn', onclick: () => takeForm() }, icon('plus', { size: 15 }), 'Take attendance')),
    uploadCard,
    trend.length > 1 && h('div', { class: 'card noprint' }, h('b', {}, 'Recent church-wide attendance'), barChart(trend)),
    tableCard);
}

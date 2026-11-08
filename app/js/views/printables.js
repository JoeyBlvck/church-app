// Printable sheets for the Reports page: a month's birthday list, a blank attendance sign-in sheet,
// and member ID cards. Each opens in a preview window and prints with the same window.print()
// routine the receipts use (the body.printing-modal class hides the rest of the page), so they
// work the same on a browser, a phone and the Windows program, and "Save as PDF" is the same dialog.
import { h, opts, byName, today, fmtDate, modal, pdfHeader, avatar } from '../ui.js';
import { icon } from '../icons.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// People who belong on a sheet that is handed out: not visitors, not people who have left or died.
const CURRENT = (m) => !['inactive', 'deceased', 'visitor'].includes(m.status);

function sheet(title, content) {
  const m = modal(title, h('div', {}, content,
    h('p', { class: 'actions noprint' },
      h('button', { class: 'btn', onclick: () => { document.body.classList.add('printing-modal'); window.print(); document.body.classList.remove('printing-modal'); } }, icon('print', { size: 15 }), 'Print / save as PDF'),
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Close'))), { xwide: true });
}

export function birthdayList({ members, churchName, cs, user, month }) {
  const rows = members.filter((m) => CURRENT(m) && m.birthday && Number(m.birthday.slice(5, 7)) === month + 1)
    .sort((a, b) => a.birthday.slice(8, 10).localeCompare(b.birthday.slice(8, 10)) || byName(a, b));
  sheet(`Birthdays — ${MONTHS[month]}`, h('div', { class: 'receipt' },
    pdfHeader(churchName, cs, `Birthdays — ${MONTHS[month]}`, h('div', { class: 'pdf-header-meta' }, `${rows.length} birthday${rows.length === 1 ? '' : 's'}`), user.name),
    h('h3', { class: 'noprint' }, `Birthdays — ${MONTHS[month]}`),
    rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Name', 'Phone'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((m) => h('tr', {}, h('td', {}, `${Number(m.birthday.slice(8, 10))} ${MONTHS[month]}`), h('td', {}, h('b', {}, m.name)), h('td', {}, m.phone ?? '')))))
      : h('p', { class: 'hint' }, 'No birthdays are recorded for this month.')));
}

export function signInSheet({ members, ministries, churchName, cs, user, ministryId }) {
  const min = ministries.find((x) => x.id === ministryId);
  const rows = members.filter((m) => CURRENT(m) && (!ministryId || m.ministryIds?.includes(ministryId))).sort(byName);
  const scope = min ? min.name : 'Whole church';
  const line = (label, w) => h('span', { style: 'display:inline-block;margin-right:22px' }, `${label} `, h('span', { style: `display:inline-block;border-bottom:1px solid #444;width:${w}px` }, ' '));
  const blank = Array.from({ length: 6 }, () => ['', '']);
  sheet(`Attendance sheet — ${scope}`, h('div', { class: 'receipt' },
    pdfHeader(churchName, cs, `Attendance sheet — ${scope}`, h('div', { class: 'pdf-header-meta' }, `${rows.length} name${rows.length === 1 ? '' : 's'}`), user.name),
    h('h3', { class: 'noprint' }, `Attendance sheet — ${scope}`),
    h('p', { class: 'sheet-lines' }, line('Service / meeting:', 220), line('Date:', 130)),
    h('table', { class: 'sheet-table' }, h('thead', {}, h('tr', {}, h('th', { style: 'width:36px' }, 'No.'), h('th', {}, 'Name'), h('th', { style: 'width:34%' }, 'Phone'), h('th', { style: 'width:90px' }, 'Present'))),
      h('tbody', {}, rows.map((m, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, m.name), h('td', {}, m.phone ?? ''), h('td', {}))),
        h('tr', { class: 'sheet-split' }, h('td', { colspan: 4 }, h('b', {}, 'Visitors / others'))),
        blank.map((_, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}), h('td', {}), h('td', {})))))));
}

export function idCards({ members, ministries, churchName, cs, user, ministryId }) {
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const people = members.filter((m) => CURRENT(m) && (!ministryId || m.ministryIds?.includes(ministryId))).sort(byName);
  const location = [cs?.location, cs?.district].filter(Boolean).join(', ');
  const card = (m) => h('div', { class: 'id-card' },
    h('div', { class: 'id-card-top' }, cs?.logo ? h('img', { src: cs.logo, alt: '' }) : icon('church', { size: 22 }),
      h('div', {}, h('div', { class: 'id-card-church' }, churchName || 'Church'), location && h('div', { class: 'id-card-loc' }, location))),
    h('div', { class: 'id-card-body' }, avatar(m.name, m.photo, 64),
      h('div', {}, h('div', { class: 'id-card-name' }, m.name),
        (m.ministryIds ?? []).length > 0 && h('div', { class: 'id-card-line' }, (m.ministryIds ?? []).map((i) => mName[i]).filter(Boolean).slice(0, 2).join(' · ')),
        m.phone && h('div', { class: 'id-card-line' }, m.phone),
        m.joined && h('div', { class: 'id-card-line mute' }, `Member since ${m.joined.slice(0, 4)}`))));
  sheet('Member ID cards', h('div', {},
    h('p', { class: 'hint noprint' }, `${people.length} card${people.length === 1 ? '' : 's'}. Print on thick paper or card and cut along the edges. They print about 8 to a page.`),
    people.length ? h('div', { class: 'id-cards' }, people.map(card)) : h('p', { class: 'hint' }, 'No members to print cards for.')));
}

// The card on the Reports page that opens the three sheets above.
export function printablesCard({ members, ministries, churchName, cs, user }) {
  const monthSel = h('select', {}, MONTHS.map((n, i) => h('option', { value: i, selected: i === new Date().getMonth() }, n)));
  const minOpts = () => [h('option', { value: '' }, 'Whole church'), opts(ministries.slice().sort(byName).map((m) => [m.id, m.name]))];
  const sheetMin = h('select', {}, ...minOpts());
  const cardMin = h('select', {}, ...minOpts());
  const ctx = { members, ministries, churchName, cs, user };
  const row = (title, text, controls) => h('div', { style: 'margin-top:14px' }, h('b', {}, title), h('p', { class: 'hint' }, text), h('div', { class: 'filters' }, ...controls));
  return h('div', { class: 'card noprint' }, h('b', {}, 'Printable sheets'),
    h('p', { class: 'hint' }, 'Print these for the notice board, the church door or a ministry meeting. Use “Save as PDF” in the print window to keep a copy.'),
    row('Birthday list', 'Everyone with a birthday in the chosen month, in date order.', [monthSel, h('button', { class: 'btn ghost', onclick: () => birthdayList({ ...ctx, month: Number(monthSel.value) }) }, 'Preview')]),
    row('Attendance sign-in sheet', 'A blank list of names with a box to tick, to pass around at a service or meeting.', [sheetMin, h('button', { class: 'btn ghost', onclick: () => signInSheet({ ...ctx, ministryId: sheetMin.value || null }) }, 'Preview')]),
    row('Member ID cards', 'Small cards with the church name, photo, name and ministry.', [cardMin, h('button', { class: 'btn ghost', onclick: () => idCards({ ...ctx, ministryId: cardMin.value || null }) }, 'Preview')]));
}

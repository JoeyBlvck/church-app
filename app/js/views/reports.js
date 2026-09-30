import { h, field, val, opts, byName, sum, money, today, fmtDate, download, toCsv, empty, attendanceCount, monthKey, signedAmount, pdfHeader } from '../ui.js';
import { icon } from '../icons.js';
import { STATUSES } from './members.js';
import { dayNameFor } from '../importers.js';

export async function reportsView({ repo, user, ministries, members, households }) {
  const canFinance = ['owner', 'admin', 'treasurer'].includes(user.role);
  const [tx, att, churchName, settingsList] = await Promise.all([canFinance ? repo.list('transactions') : [], user.role === 'treasurer' ? [] : repo.list('attendance'), repo.churchName(), repo.list('settings')]);
  const cs = settingsList.find((s) => s.id === 'church') ?? {};
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const out = h('div');
  const year = today().slice(0, 4);

  const statement = (memberId, y) => {
    const m = members.find((x) => x.id === memberId);
    const rows = tx.filter((t) => t.memberId === memberId && t.type !== 'expense' && t.date.startsWith(y)).sort((a, b) => a.date.localeCompare(b.date));
    out.replaceChildren(h('div', { class: 'card receipt' }, pdfHeader(churchName, cs, `Giving statement ${y}`, null, user.name), h('h3', { class: 'noprint' }, `Giving statement ${y}`), h('p', {}, h('b', {}, m?.name), m?.phone ? ` · ${m.phone}` : ''),
      rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Type', 'Method', 'Amount'].map((t) => h('th', {}, t)))), h('tbody', {}, rows.map((t) => h('tr', {}, h('td', {}, fmtDate(t.date), t.reverses ? ' (reversal)' : ''), h('td', {}, t.type), h('td', {}, t.method), h('td', {}, money(signedAmount(t)))))),
        h('tr', {}, h('td', { colspan: 3 }, h('b', {}, 'Total')), h('td', {}, h('b', {}, money(sum(rows, signedAmount)))))) : empty('No giving recorded for this year.'),
      h('p', { class: 'actions noprint' }, h('button', { class: 'btn', onclick: () => window.print() }, icon('print', { size: 15 }), 'Print / save as PDF'))));
  };
  const allStatements = (y) => download(`giving-statements-${y}.csv`, toCsv([['member', 'phone', 'total given', 'tithe', 'offering', 'pledge payment', 'donation'],
    ...members.slice().sort(byName).map((m) => { const r = tx.filter((t) => t.memberId === m.id && t.type !== 'expense' && t.date.startsWith(y)); const by = (k) => sum(r.filter((t) => t.type === k), signedAmount);
      return [m.name, m.phone, sum(r, signedAmount), by('tithe'), by('offering'), by('pledge payment'), by('donation')]; }).filter((r) => r[2] > 0)]), 'text/csv');

  const memSel = h('select', { name: 'm' }, h('option', { value: '' }, 'Choose member…'), opts(members.slice().sort(byName).map((m) => [m.id, m.name])));
  const ySel = h('input', { type: 'number', value: year, min: 2000, max: 2100, style: 'max-width:110px' });

  // ---- monthly Sunday attendance report: whole church only, one row per Sunday that had
  // whole-church attendance recorded that month. "Sunday" is decided the same way as everywhere
  // else in the app (dayNameFor, the record's own date), never by what a record's service name
  // says, and "whole church" means no ministryId — a ministry's own meeting attendance (even one
  // that happens to fall on a Sunday) doesn't belong in this report.
  const monthInput = h('input', { type: 'month', value: today().slice(0, 7) });
  const sundayReport = (monthStr) => {
    const inMonth = att.filter((a) => !a.ministryId && a.date.startsWith(monthStr) && dayNameFor(a.date) === 'Sunday');
    const byDate = new Map();
    for (const r of inMonth) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
    const sundays = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, recs]) => ({ date, total: sum(recs, attendanceCount), late: sum(recs, (r) => (r.lateIds ?? []).length), excused: sum(recs, (r) => (r.excusedIds ?? []).length) }));
    const avg = sundays.length ? Math.round(sum(sundays, (s) => s.total) / sundays.length) : 0;
    const monthLabel = new Date(`${monthStr}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const exportCsv = () => download(`sunday-attendance-${monthStr}.csv`, toCsv([['date', 'total present', 'late', 'excused'], ...sundays.map((s) => [s.date, s.total, s.late, s.excused])]), 'text/csv');
    out.replaceChildren(h('div', { class: 'card receipt' },
      pdfHeader(churchName, cs, `Sunday attendance report — ${monthLabel}`, h('div', {}, `${sundays.length} Sunday${sundays.length === 1 ? '' : 's'} · average ${avg} present`), user.name),
      h('h3', { class: 'noprint' }, `Sunday attendance — ${monthLabel}`),
      sundays.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Total present', 'Late', 'Excused'].map((t) => h('th', {}, t)))),
        h('tbody', {}, sundays.map((s) => h('tr', {}, h('td', {}, fmtDate(s.date)), h('td', {}, s.total), h('td', {}, s.late), h('td', {}, s.excused))),
          h('tr', {}, h('td', {}, h('b', {}, 'Average')), h('td', {}, h('b', {}, avg)), h('td', {}, ''), h('td', {}, ''))))
        : empty('No Sunday attendance recorded for this month.'),
      h('p', { class: 'actions noprint' }, h('button', { class: 'btn', onclick: () => window.print() }, icon('print', { size: 15 }), 'Print / save as PDF'),
        sundays.length > 0 && h('button', { class: 'btn ghost', onclick: exportCsv }, icon('download', { size: 15 }), 'Export CSV'))));
  };

  // membership summary
  const byStatus = STATUSES.map((s) => [s, members.filter((m) => m.status === s).length]);
  const byMinistry = ministries.slice().sort(byName).map((m) => [m.name, members.filter((x) => x.ministryIds?.includes(m.id)).length]);
  // attendance by month
  const church = att.filter((a) => !a.ministryId);
  const monthsAtt = [...new Set(church.map((a) => monthKey(a.date)))].sort().reverse().slice(0, 12).map((mo) => { const r = church.filter((a) => monthKey(a.date) === mo); return [mo, r.length, Math.round(sum(r, attendanceCount) / r.length)]; });

  return h('div', {}, h('h2', {}, 'Reports'),
    canFinance && h('div', { class: 'card noprint' }, h('b', {}, 'Giving statements'), h('p', { class: 'hint' }, 'Per-member yearly statement for tax or personal records. Statements list income given by that member only.'),
      h('div', { class: 'filters' }, memSel, ySel, h('button', { class: 'btn', onclick: () => memSel.value && statement(memSel.value, ySel.value) }, 'View statement'), h('button', { class: 'btn ghost', onclick: () => allStatements(ySel.value) }, icon('download', { size: 15 }), 'Export all (CSV)'))),
    user.role !== 'treasurer' && h('div', { class: 'card noprint' }, h('b', {}, 'Monthly Sunday attendance report'),
      h('p', { class: 'hint' }, 'Whole-church attendance for each Sunday in a chosen month — a ministry\'s own meeting attendance isn\'t included, even one that happens to fall on a Sunday.'),
      h('div', { class: 'filters' }, monthInput, h('button', { class: 'btn', onclick: () => sundayReport(monthInput.value || today().slice(0, 7)) }, 'Generate report'))),
    out,
    user.role !== 'treasurer' && h('div', { class: 'grid wide noprint' },
      h('div', { class: 'card' }, h('b', {}, 'Membership'), h('table', {}, h('tbody', {}, byStatus.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))), h('tr', {}, h('td', {}, h('b', {}, 'Total')), h('td', {}, h('b', {}, members.length)))))),
      h('div', { class: 'card' }, h('b', {}, 'Members per ministry'), byMinistry.length ? h('table', {}, h('tbody', {}, byMinistry.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))) : empty('No ministries.')),
      h('div', { class: 'card' }, h('b', {}, 'Average attendance by month'), monthsAtt.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Month', 'Services', 'Average'].map((t) => h('th', {}, t)))), h('tbody', {}, monthsAtt.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))) : empty('No church-wide attendance yet.'))));
}

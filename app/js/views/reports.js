import { h, field, val, opts, byName, sum, money, today, fmtDate, download, toCsv, empty, attendanceCount, monthKey, signedAmount } from '../ui.js';
import { icon } from '../icons.js';
import { STATUSES } from './members.js';

export async function reportsView({ repo, user, ministries, members, households }) {
  const canFinance = ['owner', 'admin', 'treasurer'].includes(user.role);
  const [tx, att] = await Promise.all([canFinance ? repo.list('transactions') : [], user.role === 'treasurer' ? [] : repo.list('attendance')]);
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const out = h('div');
  const year = today().slice(0, 4);

  const statement = (memberId, y) => {
    const m = members.find((x) => x.id === memberId);
    const rows = tx.filter((t) => t.memberId === memberId && t.type !== 'expense' && t.date.startsWith(y)).sort((a, b) => a.date.localeCompare(b.date));
    out.replaceChildren(h('div', { class: 'card receipt' }, h('h3', {}, `Giving statement ${y}`), h('p', {}, h('b', {}, m?.name), m?.phone ? ` · ${m.phone}` : ''),
      rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Type', 'Method', 'Amount'].map((t) => h('th', {}, t)))), h('tbody', {}, rows.map((t) => h('tr', {}, h('td', {}, fmtDate(t.date), t.reverses ? ' (reversal)' : ''), h('td', {}, t.type), h('td', {}, t.method), h('td', {}, money(signedAmount(t)))))),
        h('tr', {}, h('td', { colspan: 3 }, h('b', {}, 'Total')), h('td', {}, h('b', {}, money(sum(rows, signedAmount)))))) : empty('No giving recorded for this year.'),
      h('p', { class: 'actions noprint' }, h('button', { class: 'btn', onclick: () => window.print() }, icon('print', { size: 15 }), 'Print / save as PDF'))));
  };
  const allStatements = (y) => download(`giving-statements-${y}.csv`, toCsv([['member', 'phone', 'total given', 'tithe', 'offering', 'pledge payment', 'donation'],
    ...members.slice().sort(byName).map((m) => { const r = tx.filter((t) => t.memberId === m.id && t.type !== 'expense' && t.date.startsWith(y)); const by = (k) => sum(r.filter((t) => t.type === k), signedAmount);
      return [m.name, m.phone, sum(r, signedAmount), by('tithe'), by('offering'), by('pledge payment'), by('donation')]; }).filter((r) => r[2] > 0)]), 'text/csv');

  const memSel = h('select', { name: 'm' }, h('option', { value: '' }, 'Choose member…'), opts(members.slice().sort(byName).map((m) => [m.id, m.name])));
  const ySel = h('input', { type: 'number', value: year, min: 2000, max: 2100, style: 'max-width:110px' });

  // membership summary
  const byStatus = STATUSES.map((s) => [s, members.filter((m) => m.status === s).length]);
  const byMinistry = ministries.slice().sort(byName).map((m) => [m.name, members.filter((x) => x.ministryIds?.includes(m.id)).length]);
  // attendance by month
  const church = att.filter((a) => !a.ministryId);
  const monthsAtt = [...new Set(church.map((a) => monthKey(a.date)))].sort().reverse().slice(0, 12).map((mo) => { const r = church.filter((a) => monthKey(a.date) === mo); return [mo, r.length, Math.round(sum(r, attendanceCount) / r.length)]; });

  return h('div', {}, h('h2', {}, 'Reports'),
    canFinance && h('div', { class: 'card noprint' }, h('b', {}, 'Giving statements'), h('p', { class: 'hint' }, 'Per-member yearly statement for tax or personal records. Statements list income given by that member only.'),
      h('div', { class: 'filters' }, memSel, ySel, h('button', { class: 'btn', onclick: () => memSel.value && statement(memSel.value, ySel.value) }, 'View statement'), h('button', { class: 'btn ghost', onclick: () => allStatements(ySel.value) }, icon('download', { size: 15 }), 'Export all (CSV)'))),
    out,
    user.role !== 'treasurer' && h('div', { class: 'grid wide noprint' },
      h('div', { class: 'card' }, h('b', {}, 'Membership'), h('table', {}, h('tbody', {}, byStatus.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))), h('tr', {}, h('td', {}, h('b', {}, 'Total')), h('td', {}, h('b', {}, members.length)))))),
      h('div', { class: 'card' }, h('b', {}, 'Members per ministry'), byMinistry.length ? h('table', {}, h('tbody', {}, byMinistry.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))) : empty('No ministries.')),
      h('div', { class: 'card' }, h('b', {}, 'Average attendance by month'), monthsAtt.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Month', 'Services', 'Average'].map((t) => h('th', {}, t)))), h('tbody', {}, monthsAtt.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))) : empty('No church-wide attendance yet.'))));
}

import { h, field, val, opts, byName, sum, money, today, fmtDate, monthKey, modal, confirmDialog, toast, download, toCsv, empty, barChart, signedAmount, pdfHeader, dateKey } from '../ui.js';
import { icon } from '../icons.js';

export const TYPES = ['tithe', 'offering', 'welfare', 'pledge payment', 'donation', 'expense'];
export const METHODS = ['cash', 'mobile money', 'bank', 'cheque', 'card'];
export const ACCOUNT_TYPES = ['bank', 'mobile money', 'cash', 'other'];
const INCOME = (t) => t.type !== 'expense';

// Module-level (not local to financeView) for the same reason members.js keeps
// selectedMemberId/activeDetailTab this way: every save here (a transaction, a pledge, an
// account, a fund) calls the app's outer rerender(), which throws away and rebuilds this whole
// view from scratch — without this surviving that remount, saving a new account while on the
// Accounts & Funds tab would silently bounce you back to Income & expenses every time.
let financeTab = 'transactions';

// The ledger is append-only (server-enforced: see server/src/permissions.js) — a posted entry
// is never edited or deleted. "Correcting" one posts a reversal (equal, opposite effect) plus
// a fresh entry with the new values; "reversing" one just posts the reversal. Both keep the
// original on record, linked, for an audit trail. Exported so ministries.js's own inline finance
// panel (record/correct/reverse a transaction without leaving the ministry) can post a reversal
// with the exact same semantics, rather than re-deriving them.
export const post = (repo, user, t, extra) => repo.save('transactions', { type: t.type, amount: t.amount, method: t.method, memberId: t.memberId,
  ministryId: t.ministryId, pledgeId: t.pledgeId, date: today(), at: Date.now(), recordedBy: user.name, ...extra });

export async function financeView({ repo, user, ministries, members, rerender, initialMinistryId = '' }) {
  const isLeader = user.role === 'leader';
  // Accounts & funds are the church's overall financial position — gated the same as reports.js's
  // own canFinance (owner/admin/treasurer only), not just "not a leader": a leader can still post
  // their own ministry's transactions below, but never sees the accounts/funds list itself, same
  // as leaders never see pledges (see permissions.js).
  const canManageFinance = ['owner', 'admin', 'treasurer'].includes(user.role);
  const [tx, pledges, accounts, funds, churchName, settingsList] = await Promise.all([repo.list('transactions'), isLeader ? [] : repo.list('pledges'),
    canManageFinance ? repo.list('accounts') : [], canManageFinance ? repo.list('funds') : [], repo.churchName(), repo.list('settings')]);
  const cs = settingsList.find((s) => s.id === 'church') ?? {};
  tx.sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0));
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const memName = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const accName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const fundName = Object.fromEntries(funds.map((f) => [f.id, f.name]));
  const reversalOf = Object.fromEntries(tx.filter((t) => t.reverses).map((t) => [t.reverses, t]));
  // Net effect of one transaction on whichever account/fund it's tagged to: income adds, expense
  // subtracts, and a reversal (via signedAmount) nets back out against the entry it cancels —
  // the same arithmetic the Income/Expenses summary tiles above already use, just per-tag instead
  // of church-wide.
  const netAmt = (t) => incomeAmt(t) - expenseAmt(t);
  const balanceOf = (taggedRows, opening = 0) => opening + sum(taggedRows, netAmt);
  // Arriving via a ministry's own "View finance" button (ministries.js) pre-filters straight to
  // that ministry's transactions, rather than landing on the unfiltered church-wide ledger.
  const state = { from: today().slice(0, 4) + '-01-01', to: today(), type: '', ministry: initialMinistryId || '', q: '' };

  // ---------- add / correct / reverse a transaction ----------
  const txForm = (t = {}) => {
    const voided = t.id && (t.reverses || reversalOf[t.id]);   // this entry, or the one it reverses, is settled
    const memberSel = h('select', { name: 'memberId', disabled: voided }, h('option', { value: '' }, '— none —'), opts(members.slice().sort(byName).map((m) => [m.id, m.name]), t.memberId));
    const pledgeSel = h('select', { name: 'pledgeId', disabled: voided });
    const pledgeBox = field('Towards pledge', pledgeSel);
    const typeSel = h('select', { name: 'type', disabled: voided }, opts(TYPES, t.type ?? 'tithe'));
    // Which account it landed in / which fund it's designated for — both optional, and only
    // offered to whoever can actually see the Accounts & Funds tab (see canManageFinance above);
    // a leader still posts their own ministry's transactions exactly as before, just without
    // these two fields, so undefined stays undefined for them rather than showing a meaningless
    // "choose one" with nothing in it.
    const accountBox = canManageFinance && field('Account', h('select', { name: 'accountId', disabled: voided }, h('option', { value: '' }, '— unassigned —'), opts(accounts.slice().sort(byName).map((a) => [a.id, a.name]), t.accountId)));
    const fundBox = canManageFinance && field('Fund', h('select', { name: 'fundId', disabled: voided }, h('option', { value: '' }, '— none —'), opts(funds.slice().sort(byName).map((fd) => [fd.id, fd.name]), t.fundId)));
    const syncPledges = () => {
      const mine = pledges.filter((p) => p.memberId === memberSel.value);
      pledgeSel.replaceChildren(h('option', { value: '' }, '— none —'), ...opts(mine.map((p) => [p.id, `${p.title} (${money(p.amount)})`]), t.pledgeId));
      pledgeBox.hidden = !(typeSel.value === 'pledge payment' && mine.length);
    };
    memberSel.onchange = typeSel.onchange = syncPledges;
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const amount = Number(val(f, 'amount'));
      if (!(amount > 0)) return toast('Enter an amount above zero.', 'err');
      const payload = { date: val(f, 'date'), type: val(f, 'type'), amount, method: val(f, 'method'), memberId: val(f, 'memberId') || undefined,
        ministryId: val(f, 'ministryId') || undefined, pledgeId: (!pledgeBox.hidden && val(f, 'pledgeId')) || undefined, note: val(f, 'note'),
        accountId: (canManageFinance && val(f, 'accountId')) || undefined, fundId: (canManageFinance && val(f, 'fundId')) || undefined };
      if (t.id) {
        // Ledger is append-only: reverse the original, then post the edited values as a new entry.
        await post(repo, user, t, { reverses: t.id, note: `Correction — reverses entry from ${fmtDate(t.date)}` });
        await repo.save('transactions', { ...payload, correctsId: t.id, at: Date.now(), recordedBy: user.name });
        dlg.close(); toast('Correction posted — the original stays on record'); rerender();
      } else {
        await repo.save('transactions', { ...payload, at: Date.now(), recordedBy: user.name });
        dlg.close(); toast('Entry recorded'); rerender();
      }
    } },
      voided && h('p', { class: 'hint' }, t.reverses ? 'This is a reversal entry.' : 'This entry has been reversed — it is settled and can no longer be changed.'),
      h('div', { class: 'row' },
        field('Date', h('input', { name: 'date', type: 'date', value: t.date ?? today(), required: true, disabled: voided })), field('Type', typeSel),
        field('Amount', h('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true, value: t.amount ?? '', inputmode: 'decimal', disabled: voided })),
        field('Method', h('select', { name: 'method', disabled: voided }, opts(METHODS, t.method))), field('Member (optional)', memberSel),
        field('Ministry', h('select', { name: 'ministryId', disabled: voided }, !isLeader && h('option', { value: '' }, 'Church-wide'), opts(ministries.slice().sort(byName).map((m) => [m.id, m.name]), t.ministryId))),
        pledgeBox, accountBox, fundBox, field('Note / reference', h('input', { name: 'note', value: t.note ?? '', placeholder: 'e.g. MoMo ref', disabled: voided }))),
      h('p', { class: 'actions' },
        !voided && h('button', { class: 'btn' }, t.id ? 'Post correction' : 'Record'),
        t.id && !voided && INCOME(t) && h('button', { type: 'button', class: 'btn ghost', onclick: () => { dlg.close(); receipt(t); } }, icon('print', { size: 15 }), 'Receipt'),
        t.id && !voided && h('button', { type: 'button', class: 'btn del', onclick: async () => { if (await confirmDialog('Post a reversing entry to cancel this out? The original stays on record for the audit trail.', 'Reverse entry')) { await post(repo, user, t, { reverses: t.id, note: `Reversal of entry from ${fmtDate(t.date)}` }); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Reverse')));
    const dlg = modal(t.id ? (voided ? 'Entry (settled)' : 'Correct or reverse entry') : 'Record income / expense', f, { wide: true }); syncPledges();
  };

  const receipt = (t) => {
    const m = modal('Receipt', h('div', { class: 'receipt' }, pdfHeader(churchName, cs, 'Receipt', null, user.name), h('h3', { class: 'noprint' }, 'Receipt'), h('p', {}, `Date: ${fmtDate(t.date)}`), h('p', {}, `Received from: ${memName[t.memberId] ?? 'Anonymous'}`),
      h('p', {}, `For: ${t.type}${t.ministryId ? ' · ' + mName[t.ministryId] : ''}`), h('p', {}, `Method: ${t.method ?? ''}${t.note ? ' · ' + t.note : ''}`), h('p', { class: 'big' }, money(t.amount)),
      h('p', { class: 'hint' }, `Recorded by ${t.recordedBy ?? ''}`), h('p', { class: 'actions noprint' }, h('button', { class: 'btn', onclick: () => { document.body.classList.add('printing-modal'); window.print(); document.body.classList.remove('printing-modal'); } }, icon('print', { size: 15 }), 'Print'))));
  };

  // ---------- pledges ----------
  const pledgeForm = (p = {}) => {
    const f = h('form', { onsubmit: async (e) => { e.preventDefault();
      await repo.save('pledges', { ...p, memberId: val(f, 'memberId'), title: val(f, 'title'), amount: Number(val(f, 'amount')), startDate: val(f, 'startDate'), endDate: val(f, 'endDate') });
      dlg.close(); toast('Pledge saved'); rerender(); } },
      h('div', { class: 'row' }, field('Member', h('select', { name: 'memberId', required: true }, h('option', { value: '' }, 'Choose…'), opts(members.slice().sort(byName).map((m) => [m.id, m.name]), p.memberId))),
        field('Pledge for', h('input', { name: 'title', required: true, value: p.title ?? '', placeholder: 'Building fund 2026' })),
        field('Amount pledged', h('input', { name: 'amount', type: 'number', min: '1', step: '0.01', required: true, value: p.amount ?? '' })),
        field('Start', h('input', { name: 'startDate', type: 'date', value: p.startDate ?? today() })), field('Due by', h('input', { name: 'endDate', type: 'date', value: p.endDate ?? '' }))),
      h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save'), p.id && h('button', { type: 'button', class: 'btn del', onclick: async () => { if (await confirmDialog('Delete this pledge?')) { await repo.remove('pledges', p.id); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Delete')));
    const dlg = modal(p.id ? 'Edit pledge' : 'New pledge', f);
  };

  // ---------- accounts & funds ----------
  // Two church-wide entities, both purely additive on top of the existing ledger: an account is
  // where money physically sits (a bank account, mobile money wallet, the cash box); a fund is
  // what it's designated for (Building Fund, Missions…), often with a giving goal. Neither has
  // its own balance field to edit directly — a transaction optionally tags an accountId and/or
  // fundId (see txForm below), and the balance shown here is just that tag's transactions summed
  // (see balanceOf/netAmt above), the same append-only ledger everything else already trusts.
  const accountForm = (a = {}) => {
    const f = h('form', { onsubmit: async (e) => { e.preventDefault();
      await repo.save('accounts', { ...a, name: val(f, 'name'), type: val(f, 'type'), openingBalance: Number(val(f, 'openingBalance')) || 0, notes: val(f, 'notes') });
      dlg.close(); toast('Account saved'); rerender(); } },
      h('div', { class: 'row' }, field('Account name', h('input', { name: 'name', required: true, value: a.name ?? '', placeholder: 'Main church account' })),
        field('Type', h('select', { name: 'type' }, opts(ACCOUNT_TYPES, a.type ?? 'bank'))),
        field('Opening balance', h('input', { name: 'openingBalance', type: 'number', step: '0.01', value: a.openingBalance ?? 0 }), "Whatever it held before you started tracking it here — today's transactions add or subtract from this.")),
      field('Notes', h('textarea', { name: 'notes', rows: 2 }, a.notes ?? '')),
      h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save'),
        a.id && h('button', { type: 'button', class: 'btn del', onclick: async () => {
          if (await confirmDialog(`Delete "${a.name}"? Any transactions already tagged to it keep that tag, they just won't show under an account anymore.`, 'Delete')) { await repo.remove('accounts', a.id); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Delete')));
    const dlg = modal(a.id ? 'Edit account' : 'New account', f);
  };

  const fundForm = (fd = {}) => {
    const f = h('form', { onsubmit: async (e) => { e.preventDefault();
      await repo.save('funds', { ...fd, name: val(f, 'name'), goal: Number(val(f, 'goal')) || undefined, notes: val(f, 'notes') });
      dlg.close(); toast('Fund saved'); rerender(); } },
      h('div', { class: 'row' }, field('Fund name', h('input', { name: 'name', required: true, value: fd.name ?? '', placeholder: 'Building Fund' })),
        field('Goal (optional)', h('input', { name: 'goal', type: 'number', min: '0', step: '0.01', value: fd.goal ?? '' }), 'Leave blank for a fund with no fixed target.')),
      field('Notes', h('textarea', { name: 'notes', rows: 2 }, fd.notes ?? '')),
      h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save'),
        fd.id && h('button', { type: 'button', class: 'btn del', onclick: async () => {
          if (await confirmDialog(`Delete "${fd.name}"? Any transactions already tagged to it keep that tag, they just won't show under a fund anymore.`, 'Delete')) { await repo.remove('funds', fd.id); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Delete')));
    const dlg = modal(fd.id ? 'Edit fund' : 'New fund', f);
  };

  const drawAccounts = () => {
    const accRows = accounts.slice().sort(byName).map((a) => ({ a, balance: balanceOf(tx.filter((t) => t.accountId === a.id), a.openingBalance ?? 0) }));
    const fundRows = funds.slice().sort(byName).map((fd) => ({ fd, balance: balanceOf(tx.filter((t) => t.fundId === fd.id)) }));
    const total = sum(accRows, (r) => r.balance);
    body.replaceChildren(
      h('div', { class: 'grid' }, h('div', { class: 'card stat' }, h('b', {}, money(total)), h('span', {}, 'Across all accounts'))),
      h('div', { class: 'card' }, h('div', { class: 'bar' }, h('b', {}, 'Accounts'), h('button', { class: 'btn ghost sm', onclick: () => accountForm() }, icon('plus', { size: 14 }), 'Add account')),
        accRows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Account', 'Type', 'Balance'].map((t) => h('th', {}, t)))),
          h('tbody', {}, accRows.map(({ a, balance }) => h('tr', { class: 'click', onclick: () => accountForm(a) },
            h('td', {}, h('b', {}, a.name), a.notes ? h('div', { class: 'hint' }, a.notes) : null), h('td', {}, h('span', { class: 'pill' }, a.type)), h('td', { class: balance < 0 ? 'neg' : '' }, money(balance))))))
          : empty('No accounts yet — add your main bank account, mobile money wallet, or cash box to start tracking real balances.')),
      h('div', { class: 'card' }, h('div', { class: 'bar' }, h('b', {}, 'Funds'), h('button', { class: 'btn ghost sm', onclick: () => fundForm() }, icon('plus', { size: 14 }), 'Add fund')),
        fundRows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Fund', 'Raised', 'Goal', 'Progress'].map((t) => h('th', {}, t)))),
          h('tbody', {}, fundRows.map(({ fd, balance }) => { const pct = fd.goal ? Math.min(100, Math.round((balance / fd.goal) * 100)) : null;
            return h('tr', { class: 'click', onclick: () => fundForm(fd) },
              h('td', {}, h('b', {}, fd.name), fd.notes ? h('div', { class: 'hint' }, fd.notes) : null), h('td', {}, money(balance)),
              h('td', {}, fd.goal ? money(fd.goal) : h('span', { class: 'hint' }, 'No target')),
              h('td', {}, pct != null ? h('div', {}, h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` })), h('span', { class: 'hint' }, `${pct}%`)) : h('span', { class: 'hint' }, '—'))); })))
          : empty('No funds yet — add a Building Fund, Missions Fund, or any other designated giving you want a progress bar for.')));
  };

  // ---------- body ----------
  const body = h('div');
  const filtered = () => tx.filter((t) => t.date >= state.from && t.date <= state.to && (!state.type || t.type === state.type) && (!state.ministry || t.ministryId === state.ministry)
    && (!state.q || `${memName[t.memberId] ?? ''} ${t.note ?? ''}`.toLowerCase().includes(state.q)));

  // A reversal carries the same `type` as what it reverses, so it nets out of the same
  // income/expense bucket instead of showing up as a mismatched entry in the other one.
  const incomeAmt = (t) => (INCOME(t) ? signedAmount(t) : 0);
  const expenseAmt = (t) => (!INCOME(t) ? signedAmount(t) : 0);

  const drawTx = () => {
    const rows = filtered(), inc = sum(rows, incomeAmt), exp = sum(rows, expenseAmt);
    const months = [...Array(6)].map((_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i)); return dateKey(d).slice(0, 7); }); // local month, not UTC (toISOString would shift near a month boundary)
    const chart = months.map((mo) => ({ label: mo.slice(5), value: sum(tx.filter((t) => monthKey(t.date) === mo), incomeAmt) }));
    const exportCsv = () => download(`finance-${state.from}_${state.to}.csv`, toCsv([['date', 'type', 'amount', 'method', 'member', 'ministry', 'note', 'recorded by', 'reverses', 'corrects'],
      ...rows.map((t) => [t.date, t.type, t.amount, t.method, memName[t.memberId], mName[t.ministryId], t.note, t.recordedBy, t.reverses ?? '', t.correctsId ?? ''])]), 'text/csv');
    // Export PDF — same window.print() masthead+table trick as Members' own "Export PDF"
    // (see pdfHeader/print-table in ui.js/style.css): scoped to whatever's currently filtered,
    // so picking one ministry above and printing gives that ministry's own finance report,
    // and leaving every filter at its default gives the whole church's.
    const scope = state.ministry ? mName[state.ministry] : 'Church-wide';
    const printHead = pdfHeader(churchName, cs, `Finance report — ${scope}`,
      h('div', {}, h('div', {}, `${fmtDate(state.from)} – ${fmtDate(state.to)}`), h('div', {}, `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`)), user.name);
    const printTable = h('table', { class: 'print-table' },
      h('thead', {}, h('tr', {}, ['Date', 'Type', 'Amount', 'Method', 'Member', 'Ministry'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((t) => h('tr', {},
        h('td', {}, fmtDate(t.date)), h('td', {}, t.type), h('td', {}, (t.type === 'expense' ? '−' : '') + money(t.amount)),
        h('td', {}, t.method), h('td', {}, memName[t.memberId] ?? ''), h('td', {}, mName[t.ministryId] ?? 'Church-wide'))),
        h('tr', {}, h('td', { colspan: 2 }, h('b', {}, 'Totals')), h('td', {}, h('b', {}, money(inc - exp))),
          h('td', { colspan: 3 }, `Income ${money(inc)} · Expenses ${money(exp)}`))));
    body.replaceChildren(printHead, printTable, h('div', { class: 'noprint' },
      h('div', { class: 'grid' }, [['Income', inc], ['Expenses', exp], ['Net', inc - exp]].map(([l, n]) => h('div', { class: 'card stat' }, h('b', { class: n < 0 ? 'neg' : '' }, money(n)), h('span', {}, `${l} · selected period`)))),
      h('div', { class: 'card' }, h('b', {}, 'Income, last 6 months'), barChart(chart, { format: (v) => (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)) })),
      h('div', { class: 'card' }, h('div', { class: 'filters' },
        h('input', { type: 'date', value: state.from, onchange: (e) => { state.from = e.target.value || state.from; drawTx(); }, 'aria-label': 'From' }), h('input', { type: 'date', value: state.to, onchange: (e) => { state.to = e.target.value || state.to; drawTx(); }, 'aria-label': 'To' }),
        h('select', { onchange: (e) => { state.type = e.target.value; drawTx(); } }, h('option', { value: '' }, 'All types'), opts(TYPES, state.type)),
        !isLeader && ministries.length > 0 && h('select', { onchange: (e) => { state.ministry = e.target.value; drawTx(); } }, h('option', { value: '' }, 'All ministries'), opts(ministries.slice().sort(byName).map((m) => [m.id, m.name]), state.ministry)),
        h('input', { type: 'search', placeholder: 'Search member / note', value: state.q, oninput: (e) => { state.q = e.target.value.toLowerCase(); drawTx(); } }),
        h('button', { class: 'btn ghost sm', onclick: () => window.print() }, icon('print', { size: 14 }), 'Export PDF'),
        h('button', { class: 'btn ghost sm', onclick: exportCsv }, icon('download', { size: 14 }), 'Export CSV')),
        rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Type', 'Amount', 'Method', 'Member', 'Ministry'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows.map((t) => { const settled = t.reverses || reversalOf[t.id];
            return h('tr', { class: 'click', onclick: () => txForm(t) },
              h('td', {}, fmtDate(t.date)), h('td', {}, h('span', { class: `pill ${t.type === 'expense' ? 'bad' : ''}` }, t.type), t.reverses ? h('span', { class: 'pill', title: 'Reversal' }, 'reversal') : reversalOf[t.id] ? h('span', { class: 'pill bad', title: 'A reversal was posted for this entry' }, 'voided') : null),
              h('td', { class: (t.type === 'expense' ? 'neg' : '') + (settled ? ' voided' : '') }, (t.type === 'expense' ? '−' : '') + money(t.amount)),
              h('td', {}, t.method, (accName[t.accountId] || fundName[t.fundId]) && h('div', { class: 'hint' }, [accName[t.accountId], fundName[t.fundId]].filter(Boolean).join(' · '))),
              h('td', {}, memName[t.memberId] ?? ''), h('td', {}, mName[t.ministryId] ?? 'Church-wide')); }))) : empty('Nothing recorded for these filters.'))));
  };

  const drawPledges = () => {
    body.replaceChildren(h('div', { class: 'card' }, pledges.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Member', 'Pledge', 'Pledged', 'Paid', 'Progress'].map((t) => h('th', {}, t)))),
      h('tbody', {}, pledges.map((p) => { const paid = sum(tx.filter((t) => t.pledgeId === p.id), (t) => t.amount), pct = Math.min(100, Math.round((paid / p.amount) * 100));
        return h('tr', { class: 'click', onclick: () => pledgeForm(p) }, h('td', {}, memName[p.memberId] ?? '?'), h('td', {}, p.title, p.endDate && h('div', { class: 'hint' }, `due ${fmtDate(p.endDate)}`)), h('td', {}, money(p.amount)), h('td', {}, money(paid)),
          h('td', {}, h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` })), h('span', { class: 'hint' }, `${pct}%`))); }))) : empty('No pledges yet. Record what members promise to give, then tag payments against them.')));
  };

  const TAB_LABEL = { pledges: 'Pledges', accounts: 'Accounts & Funds' };
  const TAB_DRAW = { transactions: drawTx, pledges: drawPledges, accounts: drawAccounts };
  const tabKeys = ['transactions', ...(isLeader ? [] : ['pledges']), ...(canManageFinance ? ['accounts'] : [])];
  if (!tabKeys.includes(financeTab)) financeTab = 'transactions'; // e.g. role changed since the tab was last set
  const tabs = h('div', { class: 'tabs' });
  const drawTabs = () => tabs.replaceChildren(...tabKeys.map((k) => h('button', { class: financeTab === k ? 'on' : '', onclick: () => { financeTab = k; drawTabs(); TAB_DRAW[k](); } }, TAB_LABEL[k] ?? (isLeader ? 'Ministry finance' : 'Income & expenses'))));
  drawTabs(); TAB_DRAW[financeTab]();
  return h('div', {}, h('div', { class: 'bar' }, h('h2', {}, 'Finance'), h('div', { class: 'actions' }, !isLeader && h('button', { class: 'btn ghost', onclick: () => pledgeForm() }, icon('plus', { size: 15 }), 'Pledge'), h('button', { class: 'btn', onclick: () => txForm() }, icon('plus', { size: 15 }), 'Record'))), tabs, body);
}

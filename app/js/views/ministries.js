import { h, field, val, opts, byName, sum, money, today, fmtDate, fmtTime, modal, confirmDialog, toast, empty, monthKey, signedAmount, photoPicker, attendanceCount } from '../ui.js';
import { icon } from '../icons.js';
import { TYPES, METHODS, post } from './finance.js';
import { SERVICES } from './attendance.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// A ministry can meet on more than one day (e.g. a choir that rehearses Wednesdays AND
// Fridays) — `meetDays` is the list of them, ticked from checkboxes rather than one select.
// `meetDay` (singular) is kept around only for a ministry saved before this existed; it's
// read as a one-day `meetDays` and never written again once that ministry is next edited.
const meetDaysOf = (m) => (m.meetDays?.length ? m.meetDays : m.meetDay ? [m.meetDay] : []);
// Backward-compatible meeting-time label: a ministry now stores structured day(s) + time
// (meetDays/meetTime, shown as e.g. "Wednesdays & Fridays · 6:00 PM"), but one saved before
// any of this existed still carries the old freeform `meets` text ("Fridays 6pm"), shown
// as-is until that ministry is next edited.
// "Fridays" for one day, "Wednesdays & Fridays" for two, "Sundays, Wednesdays & Fridays" for
// three or more — always in DAYS (week) order, not tick order.
const joinDays = (days) => {
  const ordered = DAYS.filter((d) => days.includes(d)).map((d) => `${d}s`);
  return ordered.length > 1 ? `${ordered.slice(0, -1).join(', ')} & ${ordered.at(-1)}` : ordered[0] ?? '';
};
const meetLabel = (m) => {
  const days = meetDaysOf(m);
  return days.length || m.meetTime ? [days.length && joinDays(days), m.meetTime && fmtTime(m.meetTime)].filter(Boolean).join(' · ') : (m.meets ?? '');
};

export async function ministriesView({ repo, user, ministries, members, rerender }) {
  // 'ministries' is only ever a reachable tab for owner/admin/secretary/leader (see main.js's
  // TABS) — all four of whom can also read 'attendance' (permissions.js), so unlike 'transactions'
  // (which excludes secretary) the attendance fetch below needs no role gate of its own.
  const [updates, tx, recs] = await Promise.all([repo.list('ministryUpdates'),
    ['owner', 'admin', 'treasurer', 'leader'].includes(user.role) ? repo.list('transactions') : [], repo.list('attendance')]);
  updates.sort((a, b) => (b.date + (b.at ?? 0)).localeCompare(a.date + (a.at ?? 0)));
  const isAdmin = ['owner', 'admin'].includes(user.role);
  const canPost = user.role !== 'treasurer';
  const month = monthKey(today());
  const logoBadge = (m, size) => (m.logo ? h('img', { src: m.logo, class: `ministry-logo${size === 'lg' ? ' lg' : ''}`, alt: '' }) : icon('church', { size: size === 'lg' ? 26 : 18 }));

  const editForm = (m = {}) => {
    let logo = m.logo ?? null;
    const checkedDays = new Set(meetDaysOf(m));
    const dayBoxes = DAYS.map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'meetDays', value: d, checked: checkedDays.has(d) }), ' ', d));
    const dlg = modal(m.id ? 'Edit ministry' : 'New ministry', h('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target;
      const meetDays = [...f.querySelectorAll('input[name=meetDays]:checked')].map((c) => c.value);
      await repo.save('ministries', { ...m, name: val(f, 'name'), leader: val(f, 'leader'),
        meetDays, meetDay: undefined, meetTime: val(f, 'meetTime') || undefined,
        description: val(f, 'description'), logo: logo ?? undefined });
      dlg.close(); toast('Saved'); rerender();
    } },
      photoPicker(logo, (p) => { logo = p; }, { label: 'Ministry logo', fit: 'contain' }),
      h('div', { class: 'row' }, field('Ministry name', h('input', { name: 'name', required: true, value: m.name ?? '' })),
        field('Leader', h('input', { name: 'leader', value: m.leader ?? '' }), 'Create their login under Staff so they can update this ministry.'),
        field('Meeting time', h('input', { name: 'meetTime', type: 'time', value: m.meetTime ?? '' }))),
      field('Meeting day(s)', h('div', {}, dayBoxes), 'Tick every day this ministry regularly meets.'),
      field('About', h('textarea', { name: 'description', rows: 2 }, m.description ?? '')),
      h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save'),
        m.id && h('button', { type: 'button', class: 'btn del', onclick: async () => {
          if (await confirmDialog(`Delete the ${m.name} ministry? Members stay in the register.`)) { await repo.remove('ministries', m.id); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Delete'))));
  };

  // Owner/admin already manage everything about a ministry; a ministry's own leader gets just
  // enough here to run their roster — see openMinistry's rosterList/addRow below. Nobody else
  // (secretary, treasurer) gets roster controls on this screen.
  const canManageRoster = isAdmin || user.role === 'leader';

  const openMinistry = (m) => {
    let ppl = members.filter((x) => x.ministryIds?.includes(m.id)).sort(byName);
    const mine = updates.filter((u) => u.ministryId === m.id);
    const feed = h('div');
    const drawFeed = () => feed.replaceChildren(...(mine.length ? mine.map((u) => h('div', { class: 'feed' }, h('span', { class: 'hint' }, `${fmtDate(u.date)} · ${u.author}`), h('div', {}, u.text),
      (isAdmin || u.author === user.name) && h('button', { class: 'btn del sm', onclick: async () => { await repo.remove('ministryUpdates', u.id); mine.splice(mine.indexOf(u), 1); drawFeed(); } }, icon('trash', { size: 13 })))) : [empty('No updates yet.')]));
    drawFeed();

    // Roster: add/remove members straight from the ministry, without touching anyone's personal
    // info (that stays exclusive to the Members section — see permissions.js's roster-only write
    // rule, which enforces the same boundary server-side). `directory` is only ever fetched for a
    // leader, whose local `members` already excludes anyone not already in one of their
    // ministries; an owner/admin already has everyone locally.
    let directory = null;
    const rosterHeading = h('h4', {}, `Members (${ppl.length})`);
    const rosterList = h('div');
    const addRow = h('div', { class: 'roster-add' });

    const removeMember = async (mem) => {
      if (!(await confirmDialog(`Remove ${mem.name} from ${m.name}? This only takes them off this ministry's roster — the rest of their record is unchanged.`, 'Remove'))) return;
      try {
        const updated = await repo.rosterChange(mem.id, m.id, 'remove');
        const idx = members.findIndex((x) => x.id === mem.id); if (idx >= 0) members[idx] = updated;
        ppl = ppl.filter((x) => x.id !== mem.id);
        drawRoster(); drawAddRow(); toast(`${updated.name} removed from ${m.name}`); rerender();
      } catch (e) { toast(e.message, 'err'); }
    };
    const addMember = async (id) => {
      try {
        const updated = await repo.rosterChange(id, m.id, 'add');
        const idx = members.findIndex((x) => x.id === id); if (idx >= 0) members[idx] = updated; else members.push(updated);
        ppl = [...ppl, updated].sort(byName);
        drawRoster(); drawAddRow(); toast(`${updated.name} added to ${m.name}`); rerender();
      } catch (e) { toast(e.message, 'err'); }
    };
    const drawRoster = () => {
      rosterHeading.textContent = `Members (${ppl.length})`;
      rosterList.replaceChildren(ppl.length
        ? h('div', { class: 'roster-pills' }, ppl.map((x) => h('span', { class: 'pill roster-pill' }, x.name,
            canManageRoster && h('button', { type: 'button', title: `Remove ${x.name} from ${m.name}`, onclick: () => removeMember(x) }, icon('close', { size: 11 })))))
        : empty('No members assigned yet.'));
    };
    const drawAddRow = async () => {
      if (!canManageRoster) return;
      if (user.role === 'leader' && !directory) directory = await repo.memberDirectory().catch(() => []);
      const pool = isAdmin ? members : directory.map((d) => members.find((x) => x.id === d.id) ?? d);
      const already = new Set(ppl.map((x) => x.id));
      const avail = pool.filter((x) => !already.has(x.id)).sort(byName);
      const sel = h('select', {}, h('option', { value: '' }, avail.length ? 'Add an existing member…' : 'No other members to add'),
        ...avail.map((x) => h('option', { value: x.id }, x.name)));
      addRow.replaceChildren(h('form', { class: 'inline', onsubmit: (e) => { e.preventDefault(); if (sel.value) addMember(sel.value); } },
        sel, h('button', { class: 'btn ghost sm', disabled: !avail.length }, icon('plus', { size: 13 }), 'Add')));
    };
    drawRoster(); drawAddRow();

    // Attendance: same treatment as Finance below — kept inline instead of handing off to the
    // church-wide Attendance page (this used to be a "View attendance" button doing
    // `go('attendance', m.id)`). Every record here still posts into the shared 'attendance'
    // collection tagged with this ministry's id, so it shows up on the Attendance tab too,
    // filterable by ministry, exactly as before. Unlike Finance, this has no role gate — every
    // role that can even reach the Ministries screen (owner/admin/secretary/leader) can already
    // read and write attendance (permissions.js), the same set that could reach the old button.
    const memName = Object.fromEntries(members.map((x) => [x.id, x.name]));
    const myRecs = () => recs.filter((r) => r.ministryId === m.id).sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0));
    const attendanceList = h('div');
    const drawAttendanceList = () => {
      const rows = myRecs();
      attendanceList.replaceChildren(rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Service', 'Total'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((r) => h('tr', { class: 'click', onclick: () => openAttendanceDetail(r) },
          h('td', {}, fmtDate(r.date)), h('td', {}, r.service), h('td', {}, attendanceCount(r))))))
        : empty('No attendance recorded for this ministry yet.'));
    };
    // Same reasoning as Finance's refreshTx: refetch the authoritative collection after any
    // write rather than hand-constructing what we think just got saved.
    const refreshRecs = async () => { recs.splice(0, recs.length, ...(await repo.list('attendance'))); drawAttendanceList(); };
    const ministryTakeForm = (rec = {}) => {
      const present = new Set(rec.presentIds ?? []);
      const boxes = ppl.map((x) => ({ x, el: h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'p', value: x.id, checked: present.has(x.id) }), ' ', x.name) }));
      const list = h('div', { class: 'checklist' }, boxes.map((b) => b.el));
      const counter = h('span', { class: 'hint' });
      const recount = () => (counter.textContent = `${list.querySelectorAll('input:checked').length} marked present`);
      list.addEventListener('change', recount);
      const svc = h('input', { name: 'service', required: true, value: rec.service ?? SERVICES[0], list: 'ministry-svc-list' });
      const f = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        const presentIds = [...f.querySelectorAll('input[name=p]:checked')].map((c) => c.value);
        await repo.save('attendance', { ...rec, date: val(f, 'date'), service: val(f, 'service'), ministryId: m.id, presentIds, extra: Number(val(f, 'extra')) || 0 });
        dlg3.close(); toast('Attendance saved'); await refreshRecs(); rerender();
      } },
        h('datalist', { id: 'ministry-svc-list' }, SERVICES.map((s) => h('option', { value: s }))),
        h('div', { class: 'row' }, field('Date', h('input', { name: 'date', type: 'date', value: rec.date ?? today(), required: true })), field('Service / meeting', svc),
          field('Extra headcount', h('input', { name: 'extra', type: 'number', min: 0, value: rec.extra ?? 0 }), 'Visitors or children not on the register')),
        ppl.length ? h('div', {}, counter, list) : empty("Add members to this ministry's roster first to tick them present — or just enter a headcount."),
        h('p', { class: 'actions' }, h('button', { class: 'btn' }, rec.id ? 'Save changes' : 'Save attendance')));
      const dlg3 = modal(rec.id ? 'Edit attendance' : 'Take attendance', f, { wide: true }); recount();
    };
    const openAttendanceDetail = (r) => {
      const names = (r.presentIds ?? []).map((id) => memName[id]).filter(Boolean);
      const dlg4 = modal(`${r.service} · ${fmtDate(r.date)}`, h('div', {},
        h('p', { class: 'hint' }, `Total ${attendanceCount(r)} (${names.length} named + ${r.extra ?? 0} extra)`),
        names.length ? h('p', {}, names.map((n) => h('span', { class: 'pill' }, n))) : empty('No individual names recorded.'),
        h('p', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { dlg4.close(); ministryTakeForm(r); } }, 'Edit'),
          h('button', { class: 'btn del', onclick: async () => { if (await confirmDialog('Delete this attendance record?')) { await repo.remove('attendance', r.id); dlg4.close(); await refreshRecs(); rerender(); } } }, icon('trash', { size: 15 }), 'Delete'))));
    };
    drawAttendanceList();

    // Finance: kept inside this modal rather than handing off to the church-wide Finance page
    // (this used to just be a "View finance" button doing `go('finance', m.id)`) — a leader
    // shouldn't need a whole separate page just to record their own ministry's offering, and
    // nobody should lose their place in the ministry to check it. Every entry here still posts
    // into the exact same shared 'transactions' ledger the Finance tab reads, tagged with this
    // ministry's id, so it shows up there too — filterable by ministry — exactly as before; only
    // the "leave this screen to see or record it" part is gone.
    const canFinance = user.role !== 'secretary'; // matches who could reach the old "View finance" button
    const myTx = () => tx.filter((t) => t.ministryId === m.id).sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0));
    const statTiles = h('div', { class: 'grid' });
    const drawStats = () => {
      const rows = myTx().filter((t) => t.date.startsWith(month));
      const giving = sum(rows.filter((t) => t.type !== 'expense'), signedAmount);
      const spent = sum(rows.filter((t) => t.type === 'expense'), signedAmount);
      statTiles.replaceChildren(h('div', { class: 'card stat' }, h('b', {}, money(giving)), h('span', {}, 'Income this month')),
        h('div', { class: 'card stat' }, h('b', {}, money(spent)), h('span', {}, 'Spent this month')));
    };
    const financeList = h('div');
    const drawFinanceList = () => {
      const rows = myTx();
      const reversalOf = Object.fromEntries(rows.filter((t) => t.reverses).map((t) => [t.reverses, t]));
      financeList.replaceChildren(rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Type', 'Amount', 'Member'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((t) => { const settled = t.reverses || reversalOf[t.id];
          return h('tr', { class: 'click', onclick: () => ministryTxForm(t) },
            h('td', {}, fmtDate(t.date)),
            h('td', {}, h('span', { class: `pill ${t.type === 'expense' ? 'bad' : ''}` }, t.type),
              t.reverses ? h('span', { class: 'pill', title: 'Reversal' }, 'reversal') : reversalOf[t.id] ? h('span', { class: 'pill bad', title: 'A reversal was posted for this entry' }, 'voided') : null),
            h('td', { class: (t.type === 'expense' ? 'neg' : '') + (settled ? ' voided' : '') }, (t.type === 'expense' ? '−' : '') + money(t.amount)),
            h('td', {}, memName[t.memberId] ?? '')); })))
        : empty('No finance recorded for this ministry yet.'));
    };
    // After any post (new entry, correction, or reversal) the in-memory `tx` this modal is
    // reading from (fetched once, up top in ministriesView) has to be brought back in line with
    // what the server/local store actually now holds — refetching it here, rather than
    // hand-constructing what we think just got written, is what a correction's own two writes
    // (the reversal AND the replacement) need anyway, and keeps this in lockstep with whatever
    // the shared 'transactions' collection settles on.
    const refreshTx = async () => { tx.splice(0, tx.length, ...(await repo.list('transactions'))); drawStats(); drawFinanceList(); };
    const ministryTxForm = (t = {}) => {
      const reversalOf = Object.fromEntries(myTx().filter((x) => x.reverses).map((x) => [x.reverses, x]));
      const voided = t.id && (t.reverses || reversalOf[t.id]);
      const memberSel = h('select', { name: 'memberId', disabled: voided }, h('option', { value: '' }, '— none —'), opts(members.slice().sort(byName).map((x) => [x.id, x.name]), t.memberId));
      const f = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        const amount = Number(val(f, 'amount'));
        if (!(amount > 0)) return toast('Enter an amount above zero.', 'err');
        const payload = { date: val(f, 'date'), type: val(f, 'type'), amount, method: val(f, 'method'), memberId: val(f, 'memberId') || undefined, ministryId: m.id, note: val(f, 'note') };
        if (t.id) {
          await post(repo, user, t, { reverses: t.id, note: `Correction — reverses entry from ${fmtDate(t.date)}` });
          await repo.save('transactions', { ...payload, correctsId: t.id, at: Date.now(), recordedBy: user.name });
          dlg2.close(); toast('Correction posted — the original stays on record'); await refreshTx(); rerender();
        } else {
          await repo.save('transactions', { ...payload, at: Date.now(), recordedBy: user.name });
          dlg2.close(); toast('Entry recorded'); await refreshTx(); rerender();
        }
      } },
        voided && h('p', { class: 'hint' }, t.reverses ? 'This is a reversal entry.' : 'This entry has been reversed — it is settled and can no longer be changed.'),
        h('div', { class: 'row' },
          field('Date', h('input', { name: 'date', type: 'date', value: t.date ?? today(), required: true, disabled: voided })),
          field('Type', h('select', { name: 'type', disabled: voided }, opts(TYPES, t.type ?? 'tithe'))),
          field('Amount', h('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true, value: t.amount ?? '', inputmode: 'decimal', disabled: voided })),
          field('Method', h('select', { name: 'method', disabled: voided }, opts(METHODS, t.method))),
          field('Member (optional)', memberSel),
          field('Note / reference', h('input', { name: 'note', value: t.note ?? '', placeholder: 'e.g. MoMo ref', disabled: voided }))),
        h('p', { class: 'actions' },
          !voided && h('button', { class: 'btn' }, t.id ? 'Post correction' : 'Record'),
          t.id && !voided && h('button', { type: 'button', class: 'btn del', onclick: async () => {
            if (await confirmDialog('Post a reversing entry to cancel this out? The original stays on record for the audit trail.', 'Reverse entry')) {
              await post(repo, user, t, { reverses: t.id, note: `Reversal of entry from ${fmtDate(t.date)}` });
              dlg2.close(); await refreshTx(); rerender();
            } } }, icon('trash', { size: 15 }), 'Reverse')));
      const dlg2 = modal(t.id ? (voided ? 'Entry (settled)' : 'Correct or reverse entry') : 'Record ministry income / expense', f);
    };
    if (canFinance) { drawStats(); drawFinanceList(); }

    const meets = meetLabel(m);
    const dlg = modal(m.name, h('div', {},
      m.logo && h('p', {}, logoBadge(m, 'lg')),
      h('p', { class: 'hint' }, [m.leader && `Leader: ${m.leader}`, meets && `Meets: ${meets}`].filter(Boolean).join(' · ')), m.description && h('p', {}, m.description),
      h('div', { class: 'bar' }, h('h4', {}, 'Attendance'), h('button', { class: 'btn ghost sm', onclick: () => ministryTakeForm() }, icon('attendance', { size: 13 }), 'Take attendance')),
      attendanceList,
      canFinance && statTiles,
      canFinance && h('div', { class: 'bar' }, h('h4', {}, 'Finance'), h('button', { class: 'btn ghost sm', onclick: () => ministryTxForm() }, icon('finance', { size: 13 }), 'Record')),
      canFinance && financeList,
      canPost && h('form', { class: 'inline', onsubmit: async (e) => { e.preventDefault(); const t = e.target.elements.t.value.trim(); if (!t) return;
        const rec = { ministryId: m.id, text: t, date: today(), at: Date.now(), author: user.name }; rec.id = await repo.save('ministryUpdates', rec); mine.unshift(rec); e.target.reset(); drawFeed(); } },
        h('input', { name: 't', placeholder: 'Post an update for this ministry…' }), h('button', { class: 'btn' }, 'Post')),
      feed, rosterHeading, rosterList, addRow,
      isAdmin && h('p', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => { dlg.close(); editForm(m); } }, 'Edit ministry'))), { wide: true });
  };

  // Sub-buttons on each ministry's own card: once a ministry exists, its attendance and finance
  // are one click away without opening the card's own detail modal first. stopPropagation keeps
  // a sub-button click from also triggering the card's onclick (which opens that modal).
  const cards = ministries.slice().sort(byName).map((m) => {
    const n = members.filter((x) => x.ministryIds?.includes(m.id)).length;
    const last = updates.find((u) => u.ministryId === m.id);
    return h('div', { class: 'card click', onclick: () => openMinistry(m) },
      h('div', { class: 'ministry-card-head' }, logoBadge(m), h('b', {}, m.name)),
      h('div', { class: 'hint' }, `${n} member${n === 1 ? '' : 's'}${m.leader ? ' · ' + m.leader : ''}`),
      last ? h('p', {}, h('span', { class: 'hint' }, `${fmtDate(last.date)}: `), last.text.length > 90 ? last.text.slice(0, 90) + '…' : last.text) : h('p', { class: 'hint' }, 'No updates yet'),
      // Attendance and Finance both stay inside the ministry's own modal now (see openMinistry)
      // instead of jumping to a separate church-wide page, so these just open that modal.
      h('div', { class: 'actions', style: 'margin-top:8px' },
        h('button', { class: 'btn ghost sm', onclick: (e) => { e.stopPropagation(); openMinistry(m); } }, icon('attendance', { size: 13 }), 'Attendance'),
        user.role !== 'secretary' && h('button', { class: 'btn ghost sm', onclick: (e) => { e.stopPropagation(); openMinistry(m); } }, icon('finance', { size: 13 }), 'Finance')));
  });
  return h('div', {}, h('div', { class: 'bar' }, h('h2', {}, user.role === 'leader' ? 'My ministry' : 'Ministries'), isAdmin && h('button', { class: 'btn', onclick: () => editForm() }, icon('plus', { size: 15 }), 'New ministry')),
    cards.length ? h('div', { class: 'grid wide' }, cards) : h('div', { class: 'card' }, empty(isAdmin ? 'No ministries yet — add Choir, Youth, Ushers, Women\'s Fellowship…' : 'No ministry assigned to you yet.')));
}

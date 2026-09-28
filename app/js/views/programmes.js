// Annual programme calendar: a short list of church-wide events (Harvest, Watch Night,
// Annual Convention…), each optionally repeating every year on the same date. The
// dashboard shows whichever of these fall within the next two weeks, with a countdown.
import { h, field, val, opts, byName, modal, confirmDialog, toast, empty, fmtDate, nextOccurrence, daysUntil, dateKey, countdownLabel, bulkBar, download, toCsv, pdfHeader } from '../ui.js';
import { icon } from '../icons.js';

const REG_STATUSES = ['registered', 'attended', 'cancelled'];
const REG_LABEL = { registered: 'Registered', attended: 'Attended', cancelled: 'Cancelled' };
const REG_PILL_CLASS = { attended: 'good', cancelled: 'bad' };

export async function programmesView({ repo, user, members, rerender }) {
  const canManage = ['owner', 'admin', 'secretary'].includes(user.role);
  const [raw, regs, churchName, settingsList] = await Promise.all([repo.list('programmes'), repo.list('registrations'), repo.churchName(), repo.list('settings')]);
  const cs = settingsList.find((s) => s.id === 'church') ?? {};
  const withOcc = raw.map((p) => { const occ = nextOccurrence(p.date, p.recurring); return { ...p, occ, days: daysUntil(occ) }; });
  const upcoming = withOcc.filter((p) => p.days >= 0).sort((a, b) => a.days - b.days);
  const past = withOcc.filter((p) => p.days < 0).sort((a, b) => b.occ - a.occ);

  const regsFor = (programmeId) => regs.filter((r) => r.programmeId === programmeId);
  const regCounts = (programmeId) => {
    const rs = regsFor(programmeId);
    return REG_STATUSES.reduce((acc, s) => ({ ...acc, [s]: rs.filter((r) => r.status === s).length }), { total: rs.length });
  };
  // A member-linked registration always shows that member's *current* name/phone (looked up
  // live here) rather than a copy frozen at sign-up time, the same way attendance's presentIds
  // works — a guest who was never added as a member has nowhere to look that up, so their name
  // and phone are the only fields stored directly on the registration itself.
  const regDisplay = (r) => {
    if (!r.memberId) return { name: r.name, phone: r.phone };
    const m = members.find((x) => x.id === r.memberId);
    return { name: m?.name ?? '(removed member)', phone: m?.phone };
  };

  // ---- Registrations: who's signed up for one specific programme, with a per-person status
  // (Registered/Attended/Cancelled) — ChurchTrac's "Registrations" screen, adapted onto our own
  // Programmes. Lives in its own xwide modal rather than a new tab: it's always scoped to one
  // programme, and everything else about programmes is already modal-based.
  const openRegistrations = (p) => {
    let q = '', statusFilter = '';
    const listBox = h('div', {});
    const statTiles = h('div', { class: 'grid' });
    const sel = bulkBar([
      { label: 'Mark attended', run: (ids) => bulkSetStatus(ids, 'attended') },
      { label: 'Cancel', run: (ids) => bulkSetStatus(ids, 'cancelled') },
      { label: 'Remove', danger: true, run: bulkRemove },
    ]);

    const refresh = async () => {
      regs.length = 0; regs.push(...(await repo.list('registrations')));
      draw();
      rerender(); // keeps the programme row's own registration count current behind the modal
    };

    async function bulkSetStatus(ids, status) {
      for (const id of ids) { const r = regs.find((x) => x.id === id); if (r) await repo.save('registrations', { ...r, status }); }
      toast(`${ids.length} marked ${REG_LABEL[status].toLowerCase()}`); await refresh();
    }
    async function bulkRemove(ids) {
      if (!(await confirmDialog(`Remove ${ids.length} registration${ids.length === 1 ? '' : 's'}? This can't be undone.`, 'Remove'))) return;
      for (const id of ids) await repo.remove('registrations', id);
      toast(`${ids.length} registration${ids.length === 1 ? '' : 's'} removed`); await refresh();
    }

    const addRegistrant = () => {
      const alreadyIn = new Set(regsFor(p.id).filter((r) => r.status !== 'cancelled').map((r) => r.memberId).filter(Boolean));
      const pickable = members.filter((m) => !alreadyIn.has(m.id)).sort(byName);
      const mode = h('select', { name: 'mode' }, h('option', { value: 'member' }, 'An existing member'), h('option', { value: 'guest' }, 'A guest (not yet a member)'));
      const memberField = field('Member', h('select', { name: 'memberId' }, pickable.length ? opts(pickable.map((m) => [m.id, m.name])) : h('option', { value: '' }, 'Everyone is already registered')));
      const guestFields = h('div', { class: 'row' }, field('Name', h('input', { name: 'name', placeholder: 'Guest name' })), field('Phone', h('input', { name: 'phone', placeholder: 'Optional' })));
      guestFields.hidden = true;
      mode.onchange = () => { const isGuest = mode.value === 'guest'; memberField.hidden = isGuest; guestFields.hidden = !isGuest; };
      const f = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        if (mode.value === 'guest') {
          const name = val(f, 'name');
          if (!name) return toast('Enter the guest\'s name.', 'err');
          await repo.save('registrations', { programmeId: p.id, name, phone: val(f, 'phone'), status: 'registered', at: Date.now() });
        } else {
          const memberId = f.elements.memberId.value;
          if (!memberId) return toast('Choose a member to register.', 'err');
          // Re-registering someone whose earlier sign-up was cancelled reopens that same record
          // instead of creating a second one for them.
          const cancelled = regsFor(p.id).find((r) => r.memberId === memberId && r.status === 'cancelled');
          if (cancelled) await repo.save('registrations', { ...cancelled, status: 'registered', at: Date.now() });
          else await repo.save('registrations', { programmeId: p.id, memberId, status: 'registered', at: Date.now() });
        }
        dlg.close(); toast('Registered'); await refresh();
      } },
        field('Register', mode), memberField, guestFields,
        h('p', { class: 'actions' }, h('button', { class: 'btn' }, icon('plus', { size: 14 }), 'Add')));
      const dlg = modal('Add registrant', f);
    };

    const draw = () => {
      const counts = regCounts(p.id);
      statTiles.replaceChildren(
        h('div', { class: 'card stat' }, h('b', {}, counts.total), h('span', {}, 'Total registered')),
        h('div', { class: 'card stat' }, h('b', {}, counts.registered), h('span', {}, 'Registered')),
        h('div', { class: 'card stat' }, h('b', {}, counts.attended), h('span', {}, 'Attended')),
        h('div', { class: 'card stat' }, h('b', {}, counts.cancelled), h('span', {}, 'Cancelled')));
      const rows = regsFor(p.id).map((r) => ({ r, ...regDisplay(r) }))
        .filter((x) => !statusFilter || x.r.status === statusFilter)
        .filter((x) => !q || x.name?.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      listBox.replaceChildren(
        h('div', { class: 'filters' },
          h('input', { type: 'search', placeholder: 'Find a registrant…', value: q, oninput: (e) => { q = e.target.value; draw(); } }),
          h('select', { onchange: (e) => { statusFilter = e.target.value; draw(); } },
            h('option', { value: '' }, 'All statuses'), opts(REG_STATUSES.map((s) => [s, REG_LABEL[s]]), statusFilter))),
        sel.bar,
        rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { class: 'sel-col' }, sel.headBox()), ['Name', 'Phone', 'Status', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows.map(({ r, name, phone }) => h('tr', {},
            h('td', { class: 'sel-col' }, sel.box(r.id)),
            h('td', {}, name), h('td', {}, phone ? h('a', { href: `tel:${phone}` }, phone) : h('span', { class: 'hint' }, '—')),
            h('td', {}, h('span', { class: `pill ${REG_PILL_CLASS[r.status] ?? ''}` }, REG_LABEL[r.status])),
            h('td', { class: 'actions reg-row-actions' },
              h('select', { 'aria-label': `Status for ${name}`, onchange: async (e) => { await repo.save('registrations', { ...r, status: e.target.value }); await refresh(); } },
                opts(REG_STATUSES.map((s) => [s, REG_LABEL[s]]), r.status)),
              h('button', { type: 'button', class: 'icon-btn', title: 'Remove', onclick: async () => {
                if (await confirmDialog(`Remove ${name} from this programme's registration list?`, 'Remove')) { await repo.remove('registrations', r.id); toast('Removed'); await refresh(); }
              } }, icon('trash', { size: 14 })))))))
          : empty(regsFor(p.id).length ? 'No registrants match that search.' : 'No one has registered yet.'));
      sel.sync(rows.map(({ r }) => r.id));
    };
    draw();

    const dlg = modal(`Registrations — ${p.name}`, h('div', {},
      h('p', { class: 'hint' }, `${fmtDate(dateKey(p.occ))}${p.location ? ` · ${p.location}` : ''}`),
      statTiles,
      h('p', { class: 'actions' }, h('button', { class: 'btn sm', onclick: addRegistrant }, icon('plus', { size: 14 }), 'Add registrant')),
      listBox), { xwide: true });
  };

  const editForm = (p = {}) => {
    const dlg = modal(p.id ? 'Edit programme' : 'New programme', h('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target;
      await repo.save('programmes', { ...p, name: val(f, 'name'), date: val(f, 'date'), recurring: f.elements.recurring.checked,
        location: val(f, 'location'), notes: val(f, 'notes') });
      dlg.close(); toast('Saved'); rerender();
    } },
      h('div', { class: 'row' }, field('Programme name', h('input', { name: 'name', required: true, value: p.name ?? '', placeholder: 'Annual Convention, Harvest, Watch Night…' })),
        field('Date', h('input', { name: 'date', type: 'date', required: true, value: p.date ?? '' })),
        field('Location', h('input', { name: 'location', value: p.location ?? '', placeholder: 'Main auditorium' }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'recurring', checked: p.recurring ?? false }), 'Repeats every year on this date'),
      field('Notes', h('textarea', { name: 'notes', rows: 2 }, p.notes ?? '')),
      h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save'),
        p.id && h('button', { type: 'button', class: 'btn del', onclick: async () => {
          if (await confirmDialog(`Delete "${p.name}"? This can't be undone.`)) { await repo.remove('programmes', p.id); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Delete'))));
  };

  // ---- bulk delete: select several programmes (checkbox column) and remove them together.
  // Upcoming and past get their own bulk bar/selection since they're separate tables — each
  // one's "select all" only ever selects what's in that table.
  const bulkDeleteProgrammes = async (ids) => {
    if (!(await confirmDialog(`Delete ${ids.length} programme${ids.length === 1 ? '' : 's'}? This can't be undone.`, 'Delete'))) return;
    for (const id of ids) await repo.remove('programmes', id);
    toast(`${ids.length} programme${ids.length === 1 ? '' : 's'} deleted`); rerender();
  };
  const selUpcoming = canManage ? bulkBar([{ label: 'Delete', danger: true, run: bulkDeleteProgrammes }]) : null;
  const selPast = canManage ? bulkBar([{ label: 'Delete', danger: true, run: bulkDeleteProgrammes }]) : null;

  const row = (p, sel) => h('tr', { class: canManage ? 'click' : '', onclick: canManage ? () => editForm(p) : null },
    sel && h('td', { class: 'sel-col', onclick: (e) => e.stopPropagation() }, sel.box(p.id)),
    h('td', {}, h('b', {}, p.name), p.location ? h('div', { class: 'hint' }, p.location) : null),
    h('td', {}, fmtDate(dateKey(p.occ))),
    h('td', {}, p.recurring ? h('span', { class: 'pill' }, 'Yearly') : null),
    h('td', {}, h('span', { class: `pill ${p.days <= 1 ? 'warn' : ''}` }, countdownLabel(p.days))),
    h('td', { onclick: (e) => e.stopPropagation() },
      (() => { const c = regCounts(p.id); return h('button', { type: 'button', class: 'btn ghost sm', onclick: () => openRegistrations(p) },
        icon('members', { size: 14 }), c.total ? `${c.total} registered` : 'Register'); })()));
  selUpcoming?.sync(upcoming.map((p) => p.id));
  selPast?.sync(past.map((p) => p.id));

  // Export CSV / PDF — the whole calendar (upcoming and past), each programme's own
  // registration counts included, same as the on-screen "N registered" button per row.
  const exportRows = [...upcoming, ...past].map((p) => ({ p, c: regCounts(p.id) }));
  const exportCsv = () => download('programme-calendar.csv', toCsv([
    ['programme', 'date', 'location', 'recurring', 'registered', 'attended', 'cancelled', 'total'],
    ...exportRows.map(({ p, c }) => [p.name, dateKey(p.occ), p.location ?? '', p.recurring ? 'yes' : 'no', c.registered, c.attended, c.cancelled, c.total])]), 'text/csv');
  const printHead = pdfHeader(churchName, cs, 'Programme calendar', h('div', {}, `${raw.length} programme${raw.length === 1 ? '' : 's'}`), user.name);
  const printSection = (label, list) => list.length ? h('div', {}, h('h4', {}, label),
    h('table', { class: 'print-table' }, h('thead', {}, h('tr', {}, ['Programme', 'Date', 'Location', 'Registered', 'Attended', 'Cancelled'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((p) => { const c = regCounts(p.id); return h('tr', {},
        h('td', {}, p.name), h('td', {}, fmtDate(dateKey(p.occ))), h('td', {}, p.location ?? ''), h('td', {}, c.registered), h('td', {}, c.attended), h('td', {}, c.cancelled)); })))) : null;

  return h('div', {},
    printHead, h('div', { class: 'print-only' }, printSection('Upcoming', upcoming), printSection('Past', past)),
    h('div', { class: 'bar noprint' }, h('h2', {}, 'Programme calendar'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: () => window.print() }, icon('print', { size: 15 }), 'Export PDF'),
        h('button', { class: 'btn ghost', onclick: exportCsv }, icon('download', { size: 15 }), 'Export CSV'),
        canManage && h('button', { class: 'btn', onclick: () => editForm() }, icon('plus', { size: 15 }), 'Add programme'))),
    h('p', { class: 'hint noprint' }, "Your church's yearly calendar of programmes. Whichever one is coming up within the next two weeks also shows on the Home dashboard, counting down to the day."),
    h('div', { class: 'card noprint' }, selUpcoming?.bar, upcoming.length ? h('table', {}, h('thead', {}, h('tr', {}, selUpcoming && h('th', { class: 'sel-col' }, selUpcoming.headBox()), ['Programme', 'Date', '', '', 'Registrations'].map((t) => h('th', {}, t)))),
      h('tbody', {}, upcoming.map((p) => row(p, selUpcoming)))) : empty(canManage ? "No programmes yet — add your Annual Convention, Harvest, Watch Night service…" : 'No programmes scheduled yet.')),
    past.length > 0 && h('div', { class: 'card noprint' }, h('b', {}, 'Past programmes'), selPast?.bar,
      h('table', {}, selPast && h('thead', {}, h('tr', {}, h('th', { class: 'sel-col' }, selPast.headBox()), h('th'), h('th'), h('th'), h('th'), h('th'))),
        h('tbody', {}, past.map((p) => row(p, selPast))))));
}

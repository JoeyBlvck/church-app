import { h, field, val, opts, byName, sum, money, today, fmtDate, ageFromBirthday, modal, menu, confirmDialog, toast, download, toCsv, empty, attendanceCount, avatar, photoPicker, bulkBar, pdfHeader } from '../ui.js';
import { icon } from '../icons.js';
import { parseCSV } from '../csv.js';
import { rowsToMemberRecords, planMemberImport } from '../importers.js';
import { TYPES as TX_TYPES, METHODS } from './finance.js';

// 'inactive' covers a member who has simply stopped attending; 'deceased' is kept as its own,
// separate status rather than folded into 'inactive' so reports and the members list can tell
// the two apart at a glance.
export const STATUSES = ['member', 'visitor', 'new convert', 'inactive', 'deceased'];
const GENDERS = ['', 'female', 'male'];
// Giving types a member's own profile can quick-record against — excludes 'expense' (not
// something a member "gives") and 'pledge payment' (that flow needs a pledge picked from
// finance.js's txForm, which is more machinery than belongs in a quick add-on-the-spot form).
const GIVING_TYPES = TX_TYPES.filter((t) => t !== 'expense' && t !== 'pledge payment');

// Which member is open in the detail pane, and which of its tabs — kept at module scope (like
// main.js's own pendingMemberQuery/pendingMinistryId) rather than as local state inside
// membersView(), because every mutation (an edit, a bulk action, recording giving) calls the
// app's outer rerender(), which throws away and rebuilds this whole view from scratch. Without
// this surviving the remount, recording a gift from someone's Giving tab would bounce you back
// to an empty, unselected list every time you saved one.
let selectedMemberId = null;
let activeDetailTab = 'details';
// On phone, "‹ Back to list" hides the detail pane without clearing selectedMemberId (so the
// same member's still there if you tap back into the list) — but a remount doesn't know that on
// its own: it just sees selectedMemberId still set and would reselect that member, which on
// phone means re-showing the detail pane and silently undoing "Back". A remount can happen at
// any moment thanks to a *background* sync's render() (see main.js's isEditingPage/sync()), not
// just something the person did — so this needs to survive it the same way selectedMemberId
// does. True only while genuinely showing the detail pane on phone; irrelevant on desktop, where
// both panes are always visible.
let mobileDetailHidden = false;

export function memberForm({ repo, user, ministries, households, member = {}, onDone }) {
  const isLeader = user.role === 'leader';
  const mine = new Set(member.ministryIds ?? []);
  const boxes = ministries.slice().sort(byName).map((m) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', name: 'min', value: m.id, checked: mine.has(m.id) }), ' ', m.name));
  let photo = member.photo ?? null;
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const ministryIds = [...f.querySelectorAll('input[name=min]:checked')].map((c) => c.value);
    if (isLeader && !ministryIds.length) return toast('Pick at least one of your ministries.', 'err');
    let householdId = val(f, 'householdId') || undefined;
    const newHousehold = f.elements.newHousehold ? val(f, 'newHousehold') : '';
    if (newHousehold) householdId = await repo.save('households', { name: newHousehold, address: val(f, 'address') });
    else if (householdId && val(f, 'address')) {
      const hh = households.find((x) => x.id === householdId);
      if (hh && hh.address !== val(f, 'address')) await repo.save('households', { ...hh, address: val(f, 'address') });
    }
    const id = await repo.save('members', { ...member, name: val(f, 'name'), phone: val(f, 'phone'), email: val(f, 'email'),
      gender: val(f, 'gender'), birthday: val(f, 'birthday'), status: val(f, 'status'), joined: val(f, 'joined') || today(),
      householdId, notes: val(f, 'notes'), ministryIds, deviceUserId: val(f, 'deviceUserId') || undefined, photo: photo ?? undefined });
    toast(member.id ? 'Member updated' : 'Member added'); onDone?.(id);
  } },
    photoPicker(photo, (p) => { photo = p; }, { round: true, label: 'Passport picture (optional)' }),
    h('p', { class: 'hint' }, '* Required — everything else is optional.'),
    h('div', { class: 'row' },
      field('Full name *', h('input', { name: 'name', required: true, value: member.name ?? '', autocomplete: 'off' })),
      field('Phone (optional)', h('input', { name: 'phone', type: 'tel', value: member.phone ?? '', placeholder: '024 123 4567' })),
      field('Email (optional)', h('input', { name: 'email', type: 'email', value: member.email ?? '' })),
      field('Gender (optional)', h('select', { name: 'gender' }, opts(GENDERS.map((g) => [g, g || '—']), member.gender ?? ''))),
      field('Birthday (optional)', h('input', { name: 'birthday', type: 'date', value: member.birthday ?? '' })),
      // Status/Date joined are technically optional (both come pre-filled with a sensible
      // default -- 'member' and today -- so there's nothing to leave blank), unlike the fields
      // above/below that submit empty when untouched. Left unlabeled rather than "(optional)"
      // for that reason, and unlike "*" fields they're never blocked at submit.
      field('Status', h('select', { name: 'status' }, opts(STATUSES, member.status ?? 'member'))),
      field('Date joined', h('input', { name: 'joined', type: 'date', value: member.joined ?? today() })),
      !isLeader && field('Household / family (optional)', h('select', { name: 'householdId' }, h('option', { value: '' }, '— none —'), opts(households.slice().sort(byName).map((x) => [x.id, x.name]), member.householdId))),
      !isLeader && field('…or new household (optional)', h('input', { name: 'newHousehold', placeholder: 'e.g. Mensah family' })),
      !isLeader && field('Address (optional)', h('input', { name: 'address', value: households.find((x) => x.id === member.householdId)?.address ?? '' })),
      field('Clock-in device ID (optional)', h('input', { name: 'deviceUserId', value: member.deviceUserId ?? '', placeholder: 'e.g. 1024' }), 'The person/employee number this member is enrolled as on the attendance clock-in device.')),
    // Ministries is the one field whose required-ness depends on who's filling the form out: a
    // leader can only add/edit members within their own ministries, so it's enforced (see the
    // onsubmit check above) for them specifically, and left optional for everyone else.
    field(isLeader ? 'Ministries *' : 'Ministries (optional)', h('div', {}, boxes.length ? boxes : h('span', { class: 'hint' }, 'No ministries yet.'))),
    field('Notes (optional)', h('textarea', { name: 'notes', rows: 2 }, member.notes ?? '')),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, member.id ? 'Save changes' : 'Add member')));
  return f;
}

// A quick color cue in the list and the detail header — same five statuses the Edit form
// itself offers (STATUSES above). 'member'/'new convert' keep the plain default pill (a light
// teal wash) since those are the two unremarkable, expected states; 'visitor'/'deceased' reuse
// the app's existing warn/bad pill colors, and 'inactive' gets a new plain gray one.
const STATUS_PILL_CLASS = { visitor: 'warn', deceased: 'bad', inactive: 'muted' };
const statusPill = (status) => h('span', { class: `pill ${STATUS_PILL_CLASS[status] ?? ''}` }, status);

export async function membersView(ctx) {
  const { repo, user, ministries, members, households, rerender, initialQuery = '' } = ctx;
  const canWrite = user.role !== 'treasurer';
  const canSeeGiving = ['owner', 'admin', 'treasurer'].includes(user.role);
  // Only for the printable PDF header (church name/logo) — local settings read plus the
  // already-cached church name, so opening Members doesn't cost an extra round trip offline.
  const [churchName, settingsList] = await Promise.all([repo.churchName(), repo.list('settings')]);
  const cs = settingsList.find((s) => s.id === 'church') ?? {};
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const hName = Object.fromEntries(households.map((x) => [x.id, x.name]));
  const list = members.slice().sort(byName);
  const state = { q: initialQuery.toLowerCase(), status: '', ministry: '', sort: 'name-asc' };
  // Applied to the visible list only (export/family lookups elsewhere still use `list`'s own
  // fixed alphabetical order) — a display preference, not a change to how records are stored.
  const SORTS = {
    'name-asc': { label: 'Name (A–Z)', cmp: byName },
    'name-desc': { label: 'Name (Z–A)', cmp: (a, b) => byName(b, a) },
    'joined-desc': { label: 'Recently joined', cmp: (a, b) => (b.joined ?? '').localeCompare(a.joined ?? '') },
    'joined-asc': { label: 'Oldest joined', cmp: (a, b) => (a.joined ?? '').localeCompare(b.joined ?? '') },
    status: { label: 'Status', cmp: (a, b) => (a.status ?? '').localeCompare(b.status ?? '') || byName(a, b) },
  };

  const openForm = (member) => {
    const m = modal(member ? 'Edit member' : 'Add member', memberForm({ repo, user, ministries, households, member,
      // Adding someone new selects them once the list refreshes, the same way editing keeps
      // whoever was already open selected — either way you land back looking at that person.
      onDone: (id) => { m.close(); if (!member) { selectedMemberId = id; mobileDetailHidden = false; } rerender(); } }), { wide: true });
  };

  // ---- bulk actions: select several members (checkbox column) and change their status,
  // add/remove them from a ministry, or delete them all at once, instead of opening each
  // member's own profile one at a time. Hidden entirely for a role that can't edit members.
  const bulkChangeStatus = (ids) => {
    const statusSel = h('select', {}, opts(STATUSES, 'member'));
    const dlg = modal(`Change status for ${ids.length} member${ids.length === 1 ? '' : 's'}`, h('form', { onsubmit: async (e) => {
      e.preventDefault();
      for (const id of ids) { const m = members.find((x) => x.id === id); if (m) await repo.save('members', { ...m, status: statusSel.value }); }
      dlg.close(); toast(`Status updated for ${ids.length} member${ids.length === 1 ? '' : 's'}`); rerender();
    } }, field('New status', statusSel), h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Apply'))));
  };
  const bulkMinistryChange = (ids, mode) => {
    if (!ministries.length) return toast('No ministries to assign yet — add one under Ministries first.', 'err');
    const minSel = h('select', {}, opts(ministries.slice().sort(byName).map((m) => [m.id, m.name])));
    const verb = mode === 'add' ? 'Add' : 'Remove';
    const dlg = modal(`${verb} ${ids.length} member${ids.length === 1 ? '' : 's'} ${mode === 'add' ? 'to' : 'from'} a ministry`, h('form', { onsubmit: async (e) => {
      e.preventDefault();
      for (const id of ids) {
        const m = members.find((x) => x.id === id); if (!m) continue;
        const cur = new Set(m.ministryIds ?? []);
        if (mode === 'add') cur.add(minSel.value); else cur.delete(minSel.value);
        await repo.save('members', { ...m, ministryIds: [...cur] });
      }
      dlg.close(); toast(`${ids.length} member${ids.length === 1 ? '' : 's'} updated`); rerender();
    } }, field('Ministry', minSel), h('p', { class: 'actions' }, h('button', { class: 'btn' }, verb))));
  };
  const bulkDelete = async (ids) => {
    if (!(await confirmDialog(`Remove ${ids.length} member${ids.length === 1 ? '' : 's'} from the church register? This can't be undone.`, 'Remove'))) return;
    for (const id of ids) await repo.remove('members', id);
    if (ids.includes(selectedMemberId)) selectedMemberId = null;
    toast(`${ids.length} member${ids.length === 1 ? '' : 's'} removed`); rerender();
  };
  const sel = canWrite ? bulkBar([
    { label: 'Change status', run: bulkChangeStatus },
    { label: 'Add to ministry', run: (ids) => bulkMinistryChange(ids, 'add') },
    { label: 'Remove from ministry', run: (ids) => bulkMinistryChange(ids, 'remove') },
    { label: 'Delete', danger: true, run: bulkDelete },
  ]) : null;

  // ---- "Print card" / "Full details": built as their own single-column printable document —
  // a tabbed screen layout doesn't make sense as something printed on paper — and opened in a
  // throwaway modal purely so window.print() gets the same proven .backdrop/.modal/
  // .printing-modal machinery the rest of the app already uses for printables (Finance's own
  // receipt does the same trick). Closed again right after, so it never lingers as a stray
  // second popup once the print dialog is dismissed.
  const printCard = async (m, full) => {
    const [tx, att] = await Promise.all([canSeeGiving ? repo.list('transactions') : [], repo.list('attendance')]);
    const mine = tx.filter((t) => t.memberId === m.id && t.type !== 'expense').sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0));
    const attended = att.filter((a) => a.presentIds?.includes(m.id) || a.lateIds?.includes(m.id)).sort((a, b) => b.date.localeCompare(a.date));
    const family = m.householdId ? list.filter((x) => x.householdId === m.householdId && x.id !== m.id) : [];
    const cardHead = h('div', { class: 'print-only member-card-head' },
      h('div', { class: 'basic-only' }, pdfHeader(churchName, cs, 'Member Card', null, user.name)),
      h('div', { class: 'full-only' }, pdfHeader(churchName, cs, 'Member — Full Details', null, user.name)),
      h('div', { class: 'member-card-who' }, avatar(m.name, m.photo, 56),
        h('div', {}, h('h3', {}, m.name), statusPill(m.status))));
    // The "Full details" giving report is exactly three sections — Welfare, Tithe, Donation —
    // each its own line with its own subtotal, never combined into one grand total. Offering
    // (banked as a lump sum, not tracked as an individual's giving) and pledge payments (that's
    // Finance's own pledge-progress tracking) are left out.
    const GIVING_REPORT_TYPES = ['welfare', 'tithe', 'donation'];
    const givingSections = GIVING_REPORT_TYPES.map((type) => ({ type, entries: mine.filter((t) => t.type === type) })).filter((c) => c.entries.length > 0);
    const fullDetails = h('div', { class: 'full-only' },
      h('div', { class: 'grid' },
        h('div', { class: 'card stat' }, h('b', {}, attended.length), h('span', {}, `${user.role === 'leader' ? 'Times present at your ministry meetings' : 'Times present'} · last ${attended[0] ? fmtDate(attended[0].date) : 'never'}`))),
      canSeeGiving && h('div', { class: 'card' }, h('b', {}, 'Giving'), givingSections.length
        ? givingSections.map(({ type, entries }) => h('div', { class: 'giving-cat' },
            h('div', { class: 'giving-cat-head' }, h('b', {}, type[0].toUpperCase() + type.slice(1)), h('span', {}, money(sum(entries, (t) => t.amount)))),
            entries.slice(0, 8).map((t) => h('div', { class: 'feed' }, h('span', { class: 'hint' }, fmtDate(t.date)), h('b', {}, ' — ', money(t.amount))))))
        : h('p', { class: 'hint' }, 'No giving recorded yet.')));
    const box = h('div', {},
      cardHead,
      h('p', {}, avatar(m.name, m.photo, 64)), // cardHead above already covers the photo for print
      h('div', { class: 'kv' },
        [['Phone', m.phone], ['Email', m.email], ['Status', m.status], ['Birthday', m.birthday && fmtDate(m.birthday)], ['Joined', m.joined && fmtDate(m.joined)],
          ['Household', hName[m.householdId]], ['Clock-in device ID', m.deviceUserId], ['Notes', m.notes]].filter(([, v]) => v).map(([k, v]) => h('div', {}, h('span', { class: 'hint' }, k), h('div', {}, v)))),
      (m.ministryIds ?? []).length > 0 && h('p', {}, (m.ministryIds ?? []).map((id) => h('span', { class: 'pill' }, mName[id] ?? '?'))),
      family.length > 0 && h('p', {}, h('span', { class: 'hint' }, 'Family: '), family.map((x) => x.name).join(', ')),
      fullDetails);
    const pm = modal(m.name, box);
    document.body.classList.add('printing-modal', ...(full ? ['printing-full'] : []));
    window.print();
    document.body.classList.remove('printing-modal', 'printing-full');
    pm.close();
  };

  // ---- detail pane: a persistent side-by-side profile (ChurchTrac's own People screen layout)
  // instead of a modal you open and close per person — Details / Notes / Groups / Giving tabs,
  // the same underlying data the old single long profile modal showed, just split up.
  const DETAIL_TABS = [
    { key: 'details', label: 'Details' },
    { key: 'notes', label: 'Notes' },
    { key: 'groups', label: 'Groups' },
    canSeeGiving && { key: 'giving', label: 'Giving' },
  ].filter(Boolean);

  const detailPane = h('div', { class: 'card people-detail-pane' });
  const renderEmptyDetail = () => detailPane.replaceChildren(h('div', { class: 'people-detail-empty' },
    icon('members', { size: 30 }), empty('Select a member from the list to see their profile.'),
    canWrite && h('button', { class: 'btn sm', onclick: () => openForm() }, icon('plus', { size: 14 }), 'Add member')));

  // Only ever visible on phone (see the max-width:760px rule in style.css) — desktop always
  // shows both panes side by side, so there's nothing to "go back" from there.
  // This button only lives as long as the membersView() call that created it, and any full app
  // rerender() — adding a member, recording giving, the periodic background sync — replaces the
  // whole view with a brand new one, including a brand new `shell`. If that swap lands in the
  // gap between the person's finger going down and the click actually firing (a normal gap on a
  // phone, and one isEditingPage() in main.js can't always catch — iOS Safari doesn't focus a
  // tapped button the way a mouse click does), this handler still runs, but against the OLD,
  // now-detached shell — quietly changing nothing the person can see. shell.isConnected is true
  // exactly when this membersView() instance is still the one on screen (safe to mutate
  // directly); false means a newer one has taken its place, so fall back to whichever
  // .people-shell is actually live right now.
  const backToList = h('button', { class: 'btn ghost sm people-back', onclick: () => {
    mobileDetailHidden = true;
    (shell.isConnected ? shell : document.querySelector('.people-shell'))?.classList.remove('showing-detail');
  } }, '‹ Back to list');

  const renderDetail = async (m) => {
    const [tx, att] = await Promise.all([canSeeGiving ? repo.list('transactions') : [], repo.list('attendance')]);
    const mine = tx.filter((t) => t.memberId === m.id && t.type !== 'expense').sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0));
    const year = today().slice(0, 4);
    const attended = att.filter((a) => a.presentIds?.includes(m.id) || a.lateIds?.includes(m.id)).sort((a, b) => b.date.localeCompare(a.date));
    const family = m.householdId ? list.filter((x) => x.householdId === m.householdId && x.id !== m.id) : [];

    const givingForm = canSeeGiving && h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault();
      const amount = Number(val(givingForm, 'amount'));
      if (!(amount > 0)) return toast('Enter an amount above zero.', 'err');
      await repo.save('transactions', { type: val(givingForm, 'type'), amount, method: val(givingForm, 'method'),
        memberId: m.id, date: val(givingForm, 'date'), at: Date.now(), recordedBy: user.name });
      toast('Giving recorded'); rerender();
    } },
      field('Type', h('select', { name: 'type' }, opts(GIVING_TYPES, 'tithe'))),
      field('Amount', h('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal' })),
      field('Method', h('select', { name: 'method' }, opts(METHODS))),
      field('Date', h('input', { name: 'date', type: 'date', value: today(), required: true })),
      h('p', { class: 'actions' }, h('button', { class: 'btn sm' }, icon('plus', { size: 14 }), 'Record giving')));

    // Offering is deliberately left out further down (givingSections in printCard) but shown
    // here in the on-screen history same as before — it's only excluded from the printed
    // "Full details" report, not from the person's own on-screen giving list.
    const givingHistory = mine.length
      ? h('div', {}, mine.slice(0, 10).map((t) => h('div', { class: 'feed' },
          h('span', { class: 'hint' }, `${fmtDate(t.date)} · ${t.type}`), h('b', {}, ' — ', money(t.amount)))),
          mine.length > 10 && h('p', { class: 'hint' }, `+ ${mine.length - 10} earlier ${mine.length - 10 === 1 ? 'entry' : 'entries'} — see Finance for the full ledger.`))
      : h('p', { class: 'hint' }, 'No giving recorded yet.');

    // A single "Edit ▾" menu instead of a row of separate buttons — closer to the reference
    // layout the person shared, and it scales better as more actions get added here later.
    const actionsMenu = menu('Edit', [
      canWrite && { label: 'Edit details', icon: 'edit', onclick: () => openForm(m) },
      { label: 'Print card', icon: 'print', onclick: () => printCard(m, false) },
      { label: 'Full details', icon: 'print', onclick: () => printCard(m, true) },
      m.phone && { label: 'Call', icon: 'phone', href: `tel:${m.phone}` },
      m.phone && { label: 'WhatsApp', icon: 'chat', href: `https://wa.me/${m.phone.replace(/\D/g, '').replace(/^0/, '233')}`, target: '_blank', rel: 'noopener' },
      canWrite && { label: 'Remove', icon: 'trash', danger: true, onclick: async () => { if (await confirmDialog(`Remove ${m.name} from the church register?`, 'Remove')) { await repo.remove('members', m.id); selectedMemberId = null; toast('Member removed'); rerender(); } } },
    ]);
    const header = h('div', { class: 'people-detail-head' },
      backToList,
      h('div', { class: 'people-detail-who' }, avatar(m.name, m.photo, 64),
        h('div', {}, h('h2', {}, m.name, icon('members', { size: 16, cls: 'people-detail-who-ico' })), statusPill(m.status))),
      h('div', { class: 'actions' }, actionsMenu));

    const tabsBar = h('div', { class: 'tabs' }, DETAIL_TABS.map((t) => h('button', { type: 'button', class: `tab ${activeDetailTab === t.key ? 'on' : ''}`,
      onclick: () => { activeDetailTab = t.key; renderDetail(m); } }, t.label)));

    let content;
    if (activeDetailTab === 'notes') {
      content = m.notes ? h('p', {}, m.notes) : empty('No notes yet — add some from Edit.');
    } else if (activeDetailTab === 'groups') {
      content = (m.ministryIds ?? []).length
        ? h('p', {}, (m.ministryIds ?? []).map((id) => h('span', { class: 'pill' }, mName[id] ?? '?')))
        : empty('Not part of any ministry yet.');
    } else if (activeDetailTab === 'giving' && canSeeGiving) {
      content = h('div', {},
        h('div', { class: 'grid' }, h('div', { class: 'card stat' }, h('b', {}, money(sum(mine.filter((t) => t.date.startsWith(year)), (t) => t.amount))), h('span', {}, `Given in ${year}`))),
        h('div', { class: 'card' }, h('b', {}, 'Record giving'), givingForm),
        h('div', { class: 'card' }, h('b', {}, 'History'), givingHistory));
    } else { // 'details'
      // A stacked label/value "record card" (the reference layout the person shared) instead of
      // the old stat-tile + kv-grid — one row per fact, a status pill where we already had one,
      // and the photo pinned to the top-right instead of repeated from the header above.
      const active = !['inactive', 'deceased'].includes(m.status);
      const attendanceLabel = `${attended.length}${attended[0] ? ` · last ${fmtDate(attended[0].date)}` : ''}`;
      const rows = [
        ['Status', statusPill(m.status)],
        ['Active', active ? 'Yes' : 'No'],
        ['Phone', m.phone],
        ['Email', m.email],
        ['Gender', m.gender],
        ['Birthday', m.birthday && `${fmtDate(m.birthday)} · Age ${ageFromBirthday(m.birthday)}`],
        ['Joined', m.joined && fmtDate(m.joined)],
        ['Household', hName[m.householdId]],
        ['Clock-in device ID', m.deviceUserId],
        [user.role === 'leader' ? 'Present at your ministry meetings' : 'Times present', attendanceLabel],
        ['Family', family.length > 0 && family.map((x) => x.name).join(', ')],
      ].filter(([, v]) => v);
      // Clicking the photo opens it larger in a modal (same modal() used everywhere else in the
      // app) — the record card itself only has room for a modestly-sized photo, but the person
      // should still be able to get a proper look at who they're looking at.
      const openPhoto = () => modal(m.name, h('div', { class: 'photo-lightbox' }, avatar(m.name, m.photo, 260)));
      content = h('div', { class: 'record-card' },
        h('button', { type: 'button', class: 'record-photo', title: 'View larger', onclick: openPhoto }, avatar(m.name, m.photo, 112)),
        h('div', { class: 'record-list' }, rows.map(([k, v]) => h('div', { class: 'record-row' },
          h('div', { class: 'record-label' }, k), h('div', { class: 'record-value' }, v)))));
    }
    detailPane.replaceChildren(header, tabsBar, content);
  };

  // restoring: true means this call is a remount re-selecting whichever member was already
  // selected (see restoreSelected below), not the person actually picking someone — so it must
  // leave mobileDetailHidden as-is instead of clearing it, and must not force the detail pane
  // back open if they'd tapped "Back to list" on phone.
  const selectMember = (m, { keepTab = false, restoring = false } = {}) => {
    if (!keepTab && selectedMemberId !== m.id) activeDetailTab = 'details';
    selectedMemberId = m.id;
    if (!restoring) mobileDetailHidden = false;
    // `restoring` (see above) means this is the synchronous restoreSelected call still inside
    // membersView()'s own construction, below — `shell` hasn't been mounted yet at all, so it's
    // always the right (soon-to-be-current) one to write the class onto directly. Otherwise
    // (a person tapping a row) the same staleness question as backToList above applies, and is
    // resolved the same way.
    if (!mobileDetailHidden) (restoring || shell.isConnected ? shell : document.querySelector('.people-shell'))?.classList.add('showing-detail');
    renderDetail(m);
    draw();
  };

  // ---- the list pane itself, plus a matching hidden table used only for "Export PDF" (see
  // printTable below) — the on-screen list is now a compact ChurchTrac-style row list rather
  // than a wide multi-column table, but the exported PDF keeps its original tabular layout. ----
  const listEl = h('ul', { class: 'people-list' });
  const printBody = h('tbody');
  const count = h('span', { class: 'hint' });
  const pdfMeta = h('div', { class: 'pdf-header-meta' });
  const draw = () => {
    const rows = list.filter((m) => (!state.q || `${m.name} ${m.phone} ${m.email} ${hName[m.householdId] ?? ''}`.toLowerCase().includes(state.q))
      && (!state.status || m.status === state.status) && (!state.ministry || m.ministryIds?.includes(state.ministry)))
      .sort(SORTS[state.sort].cmp);
    count.textContent = `${rows.length} of ${list.length}`;
    pdfMeta.textContent = `${rows.length} member${rows.length === 1 ? '' : 's'}`;
    listEl.replaceChildren(...rows.map((m) => h('li', { class: `people-row click ${m.id === selectedMemberId ? 'selected' : ''}`, onclick: () => selectMember(m) },
      sel && h('span', { class: 'sel-col noprint', onclick: (e) => e.stopPropagation() }, sel.box(m.id)),
      avatar(m.name, m.photo, 34),
      h('div', { class: 'people-row-who' }, h('b', {}, m.name), h('span', { class: 'hint' }, m.phone || hName[m.householdId] || '')),
      statusPill(m.status))));
    if (!rows.length) listEl.append(h('li', {}, empty(list.length ? 'No one matches those filters.' : 'No members yet — add your first member.')));
    sel?.sync(rows.map((m) => m.id));
    printBody.replaceChildren(...rows.map((m) => h('tr', {},
      h('td', {}, m.name), h('td', {}, m.phone), h('td', {}, m.status), h('td', {}, hName[m.householdId] ?? ''),
      h('td', {}, (m.ministryIds ?? []).map((id) => mName[id]).filter(Boolean).join(', ')))));
  };

  const exportCsv = () => download(`members-${today()}.csv`, toCsv([['name', 'phone', 'email', 'status', 'birthday', 'household', 'ministries'],
    ...list.map((m) => [m.name, m.phone, m.email, m.status, m.birthday, hName[m.householdId], (m.ministryIds ?? []).map((i) => mName[i]).join('; ')])]), 'text/csv');

  // A blank sheet to fill in and upload — headers exactly match what "Upload member
  // spreadsheet" understands (see importers.js's MEMBER_HEADERS), plus one filled-in example
  // row so it's obvious what each column expects (date format, one of the real status values,
  // etc.) without having to read a help page first. Column order matches Export's own, so a
  // sheet downloaded here, filled in, then re-uploaded round-trips cleanly.
  const downloadTemplate = () => download('member-upload-template.csv', toCsv([
    ['Name', 'Phone', 'Email', 'Gender', 'Status', 'Birthday', 'Household', 'Clock-in Device ID'],
    ['Kofi Mensah', '024 123 4567', 'kofi@example.com', 'male', 'member', '1990-05-12', 'Mensah Family', ''],
  ]), 'text/csv');

  // ---- upload a member spreadsheet (device-pull export, filled in, or a church's own sheet) ----
  // Household names are resolved to an id here (creating one if it's new) since that needs the
  // repo — the pure planMemberImport() only decides create/update/skip and which fields to set.
  const importMembers = async (file) => {
    const rows = rowsToMemberRecords(parseCSV(await file.text()));
    const actions = planMemberImport(rows, members);
    const hhByName = new Map(households.map((hh) => [hh.name.toLowerCase(), hh.id]));
    let created = 0, updated = 0;
    for (const a of actions) {
      if (a.type === 'skip') continue;
      const fields = { ...a.fields };
      if (fields.household) {
        const key = fields.household.toLowerCase();
        let hid = hhByName.get(key);
        if (!hid) { hid = await repo.save('households', { name: fields.household }); hhByName.set(key, hid); }
        fields.householdId = hid; delete fields.household;
      }
      if (a.type === 'update') { const existing = members.find((m) => m.id === a.id); await repo.save('members', { ...existing, ...fields, id: a.id }); updated++; }
      else { await repo.save('members', { status: 'member', joined: today(), ...fields }); created++; }
    }
    const skipped = actions.filter((a) => a.type === 'skip');
    let msg = `${created} created, ${updated} updated`;
    if (skipped.length) msg += ` — skipped ${skipped.length} row${skipped.length > 1 ? 's' : ''} with no name`;
    toast(msg, actions.length ? 'ok' : 'err');
    rerender();
  };
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none',
    onchange: async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importMembers(f); } });

  // Screen-hidden, print-only masthead + table for "Export PDF" (see .pdf-header/.print-table
  // in style.css) — the browser's own Print/Save-as-PDF prints whatever's on the page under the
  // print stylesheet, so these just need to exist in the DOM; invisible until window.print()
  // runs, at which point .people-shell (marked .noprint below) disappears and these take its
  // place instead.
  const directoryHeader = pdfHeader(churchName, cs, 'Member Directory', pdfMeta, user.name);
  const printTable = h('table', { class: 'print-table' },
    h('thead', {}, h('tr', {}, ['Name', 'Phone', 'Status', 'Household', 'Ministries'].map((t) => h('th', {}, t)))), printBody);

  const filtersBlock = h('div', { class: 'people-filters' },
    h('label', {}, 'Currently showing'),
    h('select', { onchange: (e) => { state.status = e.target.value; draw(); } }, h('option', { value: '' }, 'Everyone'), opts(STATUSES)),
    h('input', { type: 'search', placeholder: 'Search name, phone, family…', value: initialQuery, oninput: (e) => { state.q = e.target.value.toLowerCase(); draw(); } }),
    ministries.length > 1 && h('select', { onchange: (e) => { state.ministry = e.target.value; draw(); } }, h('option', { value: '' }, 'All ministries'), opts(ministries.slice().sort(byName).map((m) => [m.id, m.name]))),
    h('select', { onchange: (e) => { state.sort = e.target.value; draw(); } }, opts(Object.entries(SORTS).map(([k, v]) => [k, v.label]), state.sort)),
    count);

  const listPane = h('div', { class: 'card people-list-pane' },
    filtersBlock,
    sel && h('label', { class: 'check people-select-all' }, sel.headBox(), ' Select all'),
    sel?.bar,
    listEl);
  const shell = h('div', { class: 'people-shell noprint' }, listPane, detailPane);

  const view = h('div', {}, h('div', { class: 'bar' }, h('h2', {}, 'Members'), h('div', { class: 'actions' },
    canWrite && h('button', { class: 'btn ghost', onclick: downloadTemplate }, icon('download', { size: 15 }), 'Download template'),
    h('button', { class: 'btn ghost', onclick: exportCsv }, icon('download', { size: 15 }), 'Export'),
    // Reuses the browser's own Print/Save-as-PDF (same approach as Reports' giving statements)
    // rather than a bundled PDF library — this project has no build step, so there's nothing
    // to npm-install into it. The print stylesheet (style.css's @media print) hides the nav,
    // toolbar and filters and shows pdfHeader+printTable instead, styled in the church's
    // teal/gold palette.
    h('button', { class: 'btn ghost', onclick: () => window.print() }, icon('print', { size: 15 }), 'Export PDF'),
    canWrite && h('button', { class: 'btn ghost', onclick: () => fileInput.click() }, icon('upload', { size: 15 }), 'Upload member spreadsheet'), fileInput,
    canWrite && h('button', { class: 'btn', onclick: () => openForm() }, icon('plus', { size: 15 }), 'Add member'))),
    directoryHeader, printTable, shell);

  const restoreSelected = selectedMemberId && list.find((m) => m.id === selectedMemberId);
  if (restoreSelected) selectMember(restoreSelected, { keepTab: true, restoring: true });
  else { draw(); renderEmptyDetail(); }
  return view;
}

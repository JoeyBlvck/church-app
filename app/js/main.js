import { idbStore } from './store.js';
import { createRepo } from './sync.js';
import { API_URL } from './config.js';
import { h, toast, avatar, fitLogoToBackground, fmtDate, today, nextOccurrence, daysUntil, countdownLabel, sum, money, passwordField, modal } from './ui.js';
import { icon } from './icons.js';
import { dashboardView } from './views/dashboard.js';
import { membersView } from './views/members.js';
import { ministriesView } from './views/ministries.js';
import { attendanceView } from './views/attendance.js';
import { financeView } from './views/finance.js';
import { reportsView } from './views/reports.js';
import { staffView, announcementsView } from './views/people.js';
import { programmesView } from './views/programmes.js';
import { settingsView } from './views/settings.js';

console.log('The ChurchFlow build: v0.18.0 (forgot password)'); // sanity check: confirms which build the browser actually loaded

const repo = createRepo(idbStore(), { baseUrl: API_URL });
const root = document.getElementById('app');
// Which screen was open persists across a browser refresh (F5 / pull-to-refresh) instead of
// always landing back on Home — reload is meant to just refresh the current page, not navigate
// away from it. setTab() is the one place `tab` changes so every navigation keeps this in sync;
// render()'s own role-based fallback (a tab the signed-in role can't see, or none saved yet)
// still applies on top of whatever was restored here.
let tab = localStorage.getItem('tab') || null, online = navigator.onLine, syncing = false, lastError = '', renderId = 0, pendingMemberQuery = '', pendingMinistryId = '';
// Switching to a genuinely different screen scrolls back to the top, the way a fresh page load
// would — without this, leaving a screen you'd scrolled down (e.g. Settings) carries that same
// scroll position into whatever you open next. A rerender of the SAME tab (saving a form, a
// background sync, …) must not do this, so it's gated on the tab actually changing.
function setTab(t) { if (t !== tab) window.scrollTo(0, 0); tab = t; try { if (t) localStorage.setItem('tab', t); else localStorage.removeItem('tab'); } catch {} }

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // clients.claim() (in sw.js) makes a brand-new install fire 'controllerchange' too, on this
  // very first load — reloading then would wipe in-progress UI (e.g. a half-filled form) for
  // no reason. Only reload when a service worker was ALREADY controlling this page, i.e. a
  // new version just took over from an old one — that's the actual "stale build" case.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  if (hadController) {
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!refreshed) { refreshed = true; location.reload(); } });
  }
}

// Screens per role. The server enforces the same rules on sync; hiding screens is only convenience.
// Order matters here: it's the sidebar's display order, grouped to match GROUP below (each
// role's list keeps same-group tabs contiguous so the nav-title section headers don't repeat).
const ALL = ['dashboard', 'members', 'ministries', 'attendance', 'announcements', 'programmes', 'staff', 'finance', 'reports', 'settings'];
const TABS = {
  owner: ALL, admin: ALL,
  secretary: ['dashboard', 'members', 'ministries', 'attendance', 'announcements', 'programmes', 'reports', 'settings'],
  treasurer: ['dashboard', 'finance', 'reports', 'settings'],
  leader: ['ministries', 'members', 'attendance', 'finance', 'settings'],
};
// 'staff' stays a real, reachable tab (Settings has its own "Manage staff" button that
// navigates to it via go('staff')) but is left out of SIDEBAR below — moved off the main nav
// bar and into Settings, since day-to-day churches open it far less often than Members/Finance.
const SIDEBAR_HIDDEN = ['staff'];
// Phone's bottom tab bar (see render()'s mobileTabbar, further down) tries to fill its four
// primary slots with these, in this order, before topping up from whatever else the signed-in
// role has — "Home, Members, Finance, Settings" for a role that has all four (owner/admin),
// fewer of them (plus filler tabs) for a role missing one, such as leader having no dashboard.
const MOBILE_PRIMARY_PRIORITY = ['dashboard', 'members', 'finance', 'settings'];
const LABEL = { dashboard: 'Home', members: 'Members', ministries: 'Ministries', attendance: 'Attendance', finance: 'Finance', announcements: 'Notices', programmes: 'Programmes', reports: 'Reports', staff: 'Staff', settings: 'Settings' };
const ICON = { dashboard: 'home', members: 'members', ministries: 'church', attendance: 'attendance', finance: 'finance', announcements: 'notices', programmes: 'calendar', reports: 'reports', staff: 'staff', settings: 'settings' };
const VIEW = { dashboard: dashboardView, members: membersView, ministries: ministriesView, attendance: attendanceView, finance: financeView, announcements: announcementsView, programmes: programmesView, reports: reportsView, staff: staffView, settings: settingsView };
// Sidebar section labels (HotspotHub-style uppercase "nav-title" group headers).
// "Money", not "Finance": a group header reading "Finance" right above a tab labelled
// "Finance" broke a `nav >> text=Finance` lookup in e2e/walkthrough.py (two matches) — and
// looked redundant to a person reading the sidebar, too.
const GROUP = { dashboard: 'Main', members: 'People', ministries: 'People', attendance: 'People', announcements: 'People', programmes: 'People', staff: 'People', finance: 'Money', reports: 'Money', settings: 'System' };

// A background sync's render() rebuilds the current tab's content from scratch — fine for most
// views, but one that keeps a live form directly in the page rather than tucked inside a
// separate modal (Members' own inline giving-entry form, notes, etc. — see members.js's detail
// pane) would have any not-yet-submitted typing wiped out from under the person mid-keystroke,
// since a modal lives outside #app and was never touched by this, but an inline pane is part of
// #app and gets rebuilt like everything else. sync() below checks this at each of its own two
// render() calls (not just once when it's first triggered), since the person can easily start
// typing in the gap between them — sync() itself still runs and still reaches the server either
// way, it just skips the *visible* re-render while they're mid-edit.
// Deliberately not limited to INPUT/TEXTAREA/SELECT: clicking "Record giving" itself moves focus
// to that <button> for a moment before its submit handler reads the form (mousedown focuses the
// button before the click/submit events fire), so a render landing in that narrow gap would wipe
// the not-yet-read amount out from under the click. Any focused element inside #app means the
// person is mid-interaction with something there, not necessarily mid-typing.
//
// That activeElement check alone still misses the same race on a phone: real iOS Safari doesn't
// move focus to a tapped <button>/<a> the way a mouse click does on desktop, so a render landing
// between touchstart and the click that follows isn't caught by it there. pointerDownInApp is a
// second, browser-agnostic signal for the same "mid-gesture" window — set the instant a finger
// (or a mouse button) goes down anywhere in #app, cleared once the resulting click has had its
// chance to run (or, if a click never comes — a drag, a cancelled tap — after a short timeout so
// it can't get stuck true forever).
let pointerDownInApp = false;
const markGestureStart = (e) => {
  if (!e.target.closest?.('#app')) return;
  pointerDownInApp = true;
  setTimeout(() => { pointerDownInApp = false; }, 400);
};
addEventListener('pointerdown', markGestureStart, true);
addEventListener('touchstart', markGestureStart, true);
addEventListener('click', () => { pointerDownInApp = false; }, true);

const isEditingPage = () => {
  const el = document.activeElement;
  return pointerDownInApp || (!!el && el !== document.body && !!el.closest('#app'));
};

async function sync({ quiet = true } = {}) {
  if (syncing || !navigator.onLine || !(await repo.user())) return;
  syncing = true; lastError = '';
  // Skip re-rendering (but let the sync itself still run and still reach the server) while the
  // person has a form field focused in the page — see isEditingPage() above for why. Only for
  // the *quiet*, automatic path: an explicit "Sync now" click always shows its own result.
  const maybeRender = () => { if (!quiet || !isEditingPage()) render(); };
  maybeRender();
  try {
    const r = await repo.sync();
    if (r.rejected) toast(`${r.rejected} change${r.rejected > 1 ? 's were' : ' was'} not accepted — you may not have permission. Use Settings → Re-download data to refresh.`, 'err');
    if (r.conflicted) toast(`${r.conflicted} change${r.conflicted > 1 ? 's were' : ' was'} overtaken by an edit from another device — the newer version was kept.`, 'err');
  } catch (e) {
    if (e.status === 401) { toast('Session expired — please sign in again.', 'err'); await repo.logout(); setTab(null); }
    else if (!quiet) toast('Could not reach the server. Your changes are safe on this device.', 'err');
    lastError = e.status === 401 ? '' : 'Server unreachable';
  }
  syncing = false; maybeRender();
}

// The top-bar search: searches across every named thing the signed-in role can actually open
// (members, ministries, programmes, notices — not raw finance/attendance records, which
// aren't really "named" and are better found from inside Finance/Attendance's own filters),
// and shows a live dropdown of matches as soon as there's text, instead of only ever jumping
// to Members. It manages its own dropdown state via direct DOM updates rather than calling the
// app's render() on every keystroke — a full render() would rebuild the input and drop focus/
// the cursor position after every character typed.
function globalSearchBar(tabs, members, ministries, programmes, notices) {
  const canSearch = { members: tabs.includes('members'), ministries: tabs.includes('ministries'),
    programmes: tabs.includes('programmes'), announcements: tabs.includes('announcements') };
  if (!Object.values(canSearch).some(Boolean)) return null; // this role has nothing here to search (e.g. treasurer)

  const results = h('div', { class: 'topsearch-results' });
  results.style.display = 'none';
  const setOpen = (open) => { results.style.display = open ? '' : 'none'; };

  const runSearch = (raw) => {
    const q = raw.trim().toLowerCase();
    if (!q) return setOpen(false);
    const groups = [];
    if (canSearch.members) {
      const hits = members.filter((m) => `${m.name} ${m.phone ?? ''} ${m.email ?? ''}`.toLowerCase().includes(q)).slice(0, 4)
        .map((m) => ({ primary: m.name, secondary: m.phone || m.email || m.status,
          onSelect: () => { pendingMemberQuery = m.name; setTab('members'); render(); } }));
      if (hits.length) groups.push({ type: 'members', label: 'Members', items: hits });
    }
    if (canSearch.ministries) {
      const hits = ministries.filter((m) => (m.name ?? '').toLowerCase().includes(q)).slice(0, 3)
        .map((m) => ({ primary: m.name, secondary: `${members.filter((x) => x.ministryIds?.includes(m.id)).length} members`,
          onSelect: () => { setTab('ministries'); render(); } }));
      if (hits.length) groups.push({ type: 'ministries', label: 'Ministries', items: hits });
    }
    if (canSearch.programmes) {
      const hits = programmes.filter((p) => `${p.name} ${p.location ?? ''}`.toLowerCase().includes(q)).slice(0, 3)
        .map((p) => ({ primary: p.name, secondary: p.location ? `${fmtDate(p.date)} · ${p.location}` : fmtDate(p.date),
          onSelect: () => { setTab('programmes'); render(); } }));
      if (hits.length) groups.push({ type: 'programmes', label: 'Programmes', items: hits });
    }
    if (canSearch.announcements) {
      const hits = notices.filter((n) => `${n.text ?? ''} ${n.author ?? ''}`.toLowerCase().includes(q)).slice(0, 3)
        .map((n) => ({ primary: n.text.length > 64 ? `${n.text.slice(0, 64)}…` : n.text, secondary: `${n.author} · ${fmtDate(n.date)}`,
          onSelect: () => { setTab('announcements'); render(); } }));
      if (hits.length) groups.push({ type: 'announcements', label: 'Notices', items: hits });
    }
    if (!groups.length) { results.replaceChildren(h('div', { class: 'topsearch-empty' }, `No matches for "${raw.trim()}"`)); return setOpen(true); }
    results.replaceChildren(...groups.flatMap((g) => [
      h('div', { class: 'topsearch-group' }, g.label),
      ...g.items.map((it) => h('div', { class: 'topsearch-result', tabindex: 0,
        onmousedown: (e) => e.preventDefault(), // fires before the input's blur, so the click below still lands
        onclick: () => { setOpen(false); input.value = ''; it.onSelect(); } },
        h('span', { class: 'ico' }, icon(ICON[g.type], { size: 14 })),
        h('div', {}, h('b', {}, it.primary), it.secondary && h('div', { class: 'hint' }, it.secondary)))),
    ]));
    setOpen(true);
  };

  let debounceT;
  const input = h('input', { name: 'q', type: 'search', placeholder: 'Search members, ministries, programmes, notices…', 'aria-label': 'Search everything',
    oninput: (e) => { clearTimeout(debounceT); const v = e.target.value; debounceT = setTimeout(() => runSearch(v), 150); },
    onfocus: (e) => { if (e.target.value.trim()) runSearch(e.target.value); },
    onkeydown: (e) => { if (e.key === 'Escape') { setOpen(false); e.target.blur(); } },
    onblur: () => setTimeout(() => setOpen(false), 120) }); // small delay so a result's onmousedown still gets to run first
  const form = h('form', { class: 'topsearch', onsubmit: (e) => {
    e.preventDefault(); const q = input.value.trim(); if (!q) return;
    // Enter with nothing picked from the dropdown falls back to the old "search members" jump —
    // the one category with its own in-page search/filter to land the query on.
    if (canSearch.members) { pendingMemberQuery = q; setTab('members'); render(); }
  } }, icon('search', { size: 15 }), input);
  return h('div', { class: 'topsearch-wrap' }, form, results);
}

// ---- notification bell: a short, deliberately narrow list of things that actually need a
// look — never a duplicate of the dashboard's own "recent activity" feed, which is a log of
// what already happened. Computed fresh on every render from data fetched for this alone
// (attendance/pledges/transactions, gated by role the same way dashboard.js gates its own
// widgets) plus members/programmes the top bar was already loading.
//
// Read/dismissed state: each item gets a stable `key` built from what it's actually about
// (which member(s), which programme, how many days out — see below), not just its category.
// Reading one (clicking it, or its own × ) stores that key in localStorage so it stays gone —
// but only until the key itself changes: a birthday's key carries the date, so it comes back
// next year; a programme/pledge's key carries the days-remaining, so a dismissed "3 days to
// go" doesn't also swallow "tomorrow"; a visitor/absent-member group's key is the exact set of
// member ids, so dismissing "2 visitors to follow up" doesn't hide a THIRD visitor who shows up
// later. Keys no longer produced (resolved, expired, or changed) are pruned from storage below
// so it never grows without bound.
const NOTIF_DISMISSED_KEY = 'dismissedNotifications';
function loadDismissedNotifications() {
  try { return new Set(JSON.parse(localStorage.getItem(NOTIF_DISMISSED_KEY) || '[]')); } catch { return new Set(); }
}
function markNotificationRead(key) {
  const set = loadDismissedNotifications(); set.add(key);
  try { localStorage.setItem(NOTIF_DISMISSED_KEY, JSON.stringify([...set])); } catch {}
}

function buildNotifications({ user, members, attendance, programmes, pledges, tx }) {
  const raw = [];
  if (user.role !== 'treasurer') { // treasurer's tabs have no Members/Attendance/Programmes to point at anyway
    const todayMD = today().slice(5); // 'MM-DD', for a birthday match regardless of year
    const birthdays = members.filter((m) => m.birthday && m.birthday.slice(5) === todayMD);
    if (birthdays.length) raw.push({ key: `birthday:${todayMD}`, ic: 'members', text: `🎂 Birthday today: ${birthdays.map((m) => m.name).join(', ')}`, tab: 'members' });
    const visitors = members.filter((m) => m.status === 'visitor');
    if (visitors.length) raw.push({ key: `visitors:${visitors.map((m) => m.id).sort().join(',')}`, ic: 'members', text: `${visitors.length} visitor${visitors.length === 1 ? '' : 's'} to follow up`, tab: 'members' });
    // Same "missed the last 3 services" rule as the dashboard's own list (dashboard.js) — only
    // once there are at least 3 whole-church records to judge attendance against.
    const church = attendance.filter((a) => !a.ministryId).sort((a, b) => b.date.localeCompare(a.date));
    const recentThree = church.slice(0, 3);
    if (recentThree.length === 3) {
      const absent = members.filter((m) => m.status === 'member' && attendance.some((a) => a.presentIds?.includes(m.id)) && !recentThree.some((a) => a.presentIds?.includes(m.id)));
      if (absent.length) raw.push({ key: `absent:${absent.map((m) => m.id).sort().join(',')}`, ic: 'attendance', text: `${absent.length} member${absent.length === 1 ? '' : 's'} missed the last 3 services`, tab: 'attendance' });
    }
    for (const p of programmes) {
      const days = daysUntil(nextOccurrence(p.date, p.recurring));
      if (days >= 0 && days <= 3) raw.push({ key: `programme:${p.id}:${days}`, ic: 'calendar', text: `${p.name} — ${countdownLabel(days)}`, tab: 'programmes' });
    }
  }
  for (const p of pledges) {
    if (!p.endDate) continue;
    const days = daysUntil(new Date(p.endDate + 'T00:00:00'));
    if (days < 0 || days > 14) continue;
    const paid = sum(tx.filter((t) => t.pledgeId === p.id), (t) => t.amount);
    if (paid < p.amount) raw.push({ key: `pledge:${p.id}:${days}`, ic: 'finance', text: `${p.title} pledge due ${fmtDate(p.endDate)} — ${money(p.amount - paid)} left`, tab: 'finance' });
  }
  const dismissed = loadDismissedNotifications();
  const stillCurrent = new Set(raw.map((it) => it.key));
  const stillNeeded = new Set([...dismissed].filter((k) => stillCurrent.has(k)));
  if (stillNeeded.size !== dismissed.size) { try { localStorage.setItem(NOTIF_DISMISSED_KEY, JSON.stringify([...stillNeeded])); } catch {} }
  return raw.filter((it) => !stillNeeded.has(it.key));
}

// A native <details>/<summary> disclosure rather than hand-rolled open/close state — it needs
// no outside-click handling of its own, and every navigation already triggers a full render()
// that rebuilds this element from scratch (closed, since a fresh element has no `open`
// attribute), so it never has to be closed explicitly after a click. Reading an item (its row,
// or its own ×) marks it read and calls rerender — the badge and list both update from that
// same rebuild, since buildNotifications() re-filters against the just-updated dismissed set.
function notificationBell(items, go, rerender) {
  const readAndGo = (it) => { markNotificationRead(it.key); go(it.tab); };
  const readOnly = (it) => { markNotificationRead(it.key); rerender(); };
  const rows = items.length
    ? items.map((it) => h('div', { class: 'notif-item click', onclick: () => readAndGo(it) },
        h('span', { class: 'ico' }, icon(it.ic, { size: 15 })), h('span', { class: 'notif-text' }, it.text),
        h('button', { type: 'button', class: 'notif-dismiss', title: 'Mark as read', 'aria-label': 'Mark as read',
          onclick: (e) => { e.stopPropagation(); readOnly(it); } }, icon('close', { size: 12 }))))
    : [h('p', { class: 'hint notif-empty' }, 'Nothing needs your attention right now.')];
  return h('details', { class: 'notif-bell' },
    h('summary', { 'aria-label': items.length ? `${items.length} notifications` : 'Notifications' },
      icon('bell', { size: 18 }), items.length > 0 && h('span', { class: 'notif-badge' }, items.length > 9 ? '9+' : String(items.length))),
    h('div', { class: 'notif-dropdown' },
      h('div', { class: 'notif-dropdown-head' }, h('span', { class: 'notif-dropdown-title' }, 'Needs a look'),
        items.length > 0 && h('button', { type: 'button', class: 'notif-clear', onclick: () => { items.forEach((it) => markNotificationRead(it.key)); rerender(); } }, 'Mark all read')),
      ...rows));
}

async function render() {
  const id = ++renderId;
  const user = await repo.user();
  if (!user) {
    // A password-reset email links back here as /?resetToken=... — caught before the normal
    // login screen so following that link works the same whether or not this device happens to
    // already have a stale/expired session lying around.
    const resetToken = new URLSearchParams(location.search).get('resetToken');
    return resetToken ? renderResetPassword(resetToken) : renderLogin();
  }
  const tabs = TABS[user.role];
  if (!tabs.includes(tab)) setTab(tabs[0]);
  // programmes/notices are only pulled for the top-bar search when the signed-in role can
  // actually open those tabs — same gating the search dropdown itself uses below, so a role
  // like treasurer (no Programmes/Notices tab) never even fetches records it can't navigate to.
  // The notification bell's own extra reads (attendance/pledges/transactions) are gated the
  // same way dashboard.js gates its own widgets — a treasurer has no Members/Attendance tab
  // to point at, and pledges/transactions are only ever relevant to a finance role.
  const wantsPeopleNotif = user.role !== 'treasurer';
  const wantsFinanceNotif = ['owner', 'admin', 'treasurer'].includes(user.role);
  const [ministries, members, households, pending, settingsList, programmes, notices, attendanceForNotif, pledgesForNotif, txForNotif] = await Promise.all([
    repo.list('ministries'), repo.list('members'), repo.list('households'), repo.pending(), repo.list('settings'),
    tabs.includes('programmes') ? repo.list('programmes') : [],
    tabs.includes('announcements') ? repo.list('messages') : [],
    wantsPeopleNotif ? repo.list('attendance') : [],
    wantsFinanceNotif ? repo.list('pledges') : [],
    wantsFinanceNotif ? repo.list('transactions') : [],
  ]);
  const churchSettings = settingsList.find((s) => s.id === 'church') ?? {};
  const notifItems = buildNotifications({ user, members, attendance: attendanceForNotif, programmes, pledges: pledgesForNotif, tx: txForNotif });
  // go(tab, ministryId) both switches screens and — for the 'attendance'/'finance' sub-buttons
  // on a ministry's card/detail view — carries which ministry that screen should open already
  // filtered to, the same way a dashboard tile just switches tabs with go(tab) alone.
  const ctx = { repo, user, ministries, members, households, rerender: render, sync: () => sync({ quiet: false }),
    go: (t, ministryId) => { if (ministryId !== undefined) pendingMinistryId = ministryId; setTab(t); render(); },
    initialQuery: tab === 'members' ? pendingMemberQuery : '', initialMinistryId: (tab === 'attendance' || tab === 'finance') ? pendingMinistryId : '' };
  pendingMemberQuery = ''; pendingMinistryId = '';
  let view;
  try { view = await VIEW[tab](ctx); } catch (e) { console.error(e); view = h('div', { class: 'card' }, h('p', { class: 'err' }, 'Something went wrong showing this screen.'), h('pre', { class: 'hint' }, String(e.message))); }
  if (id !== renderId) return; // a newer render started while this one was loading
  const status = h('div', { class: 'status', role: 'status' }, h('span', { class: online ? 'dot' : 'dot off' }),
    !online ? 'Offline — changes are saved on this device' : syncing ? 'Syncing…' : lastError || 'Online',
    pending ? ` · ${pending} waiting to sync` : ' · all saved');
  const topBar = [status];
  const searchBar = globalSearchBar(tabs, members, ministries, programmes, notices);
  if (searchBar) topBar.push(searchBar);
  topBar.push(notificationBell(notifItems, (t) => ctx.go(t), ctx.rerender));
  // Clicking your own name/avatar jumps straight to "My profile" inside Settings — every role
  // can reach Settings (see TABS above), so this is always safe regardless of who's signed in.
  const goToProfile = () => { setTab('settings'); render().then(() => document.getElementById('my-profile')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  topBar.push(h('div', { class: 'account click', role: 'button', tabindex: 0, title: 'View your profile',
      onclick: goToProfile, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToProfile(); } } },
    avatar(user.name, user.photo, 34), h('div', { class: 'who' }, h('b', {}, user.name), h('small', {}, user.role))));
  topBar.push(h('button', { class: 'btn ghost sm', onclick: () => sync({ quiet: false }) }, icon('sync', { size: 16 }), 'Sync now'));
  // one uppercase "nav-title" header per group, only where the group actually changes —
  // this keeps role-specific tab lists (which may skip a group entirely) from showing an
  // empty or duplicate section header.
  let lastGroup = null;
  const navItems = [];
  for (const t of tabs) {
    if (SIDEBAR_HIDDEN.includes(t)) continue; // still a real, reachable tab — just not a top-level nav link (see SIDEBAR_HIDDEN)
    if (GROUP[t] !== lastGroup) { navItems.push(h('div', { class: 'nav-title' }, GROUP[t])); lastGroup = GROUP[t]; }
    navItems.push(h('button', { class: t === tab ? 'on' : '', onclick: () => { setTab(t); render(); } }, h('span', { class: 'ico' }, icon(ICON[t])), h('span', {}, LABEL[t])));
  }
  // Phone's own bottom tab bar (see .mobile-tabbar in style.css) — capped at four primary tabs
  // plus a "More" panel for whatever's left, rather than the sidebar's full button list laid
  // sideways: that scrolled horizontally, and reset back to the start on every navigation, so
  // reaching (or re-tapping) anything past the first few meant swiping across again each time.
  // Which four count as "primary" is role-aware: MOBILE_PRIMARY_PRIORITY is filled in first,
  // skipping any a role doesn't have (a leader has no Home/dashboard tab, say), then topped up
  // from that role's own remaining tabs, in their usual order, until there are four (or the
  // role simply doesn't have four tabs to begin with) — everything left over goes into "More".
  const tabsVisible = tabs.filter((t) => !SIDEBAR_HIDDEN.includes(t));
  const primarySet = new Set(tabsVisible.filter((t) => MOBILE_PRIMARY_PRIORITY.includes(t)));
  for (const t of tabsVisible) { if (primarySet.size >= 4) break; primarySet.add(t); }
  const mobilePrimary = tabsVisible.filter((t) => primarySet.has(t));
  const mobileOverflow = tabsVisible.filter((t) => !primarySet.has(t));
  const mobileNavBtn = (t, extraOnclick) => h('button', { type: 'button', class: t === tab ? 'on' : '',
    onclick: (e) => { extraOnclick?.(e); setTab(t); render(); } }, h('span', { class: 'ico' }, icon(ICON[t], { size: 19 })), h('span', {}, LABEL[t]));
  const mobileTabbar = h('nav', { class: 'mobile-tabbar noprint' },
    mobilePrimary.map((t) => mobileNavBtn(t)),
    mobileOverflow.length > 0 && h('details', { class: 'mobile-more' },
      h('summary', {}, h('span', { class: 'ico' }, icon('more', { size: 19 })), h('span', {}, 'More')),
      h('div', { class: 'mobile-more-sheet' }, mobileOverflow.map((t) =>
        mobileNavBtn(t, (e) => e.currentTarget.closest('details')?.removeAttribute('open'))))));
  // The logo sits plain in its slot by default (see .brand-mark in style.css); a background
  // box is only added, after the fact, if fitLogoToBackground finds the logo's own colours
  // would otherwise blend into the sidebar. No logo set → the generic church icon keeps its
  // usual teal box (the 'icon' class) regardless.
  const brandMark = h('span', { class: churchSettings.logo ? 'brand-mark' : 'brand-mark icon' },
    churchSettings.logo ? h('img', { src: churchSettings.logo, alt: '' }) : icon('church', { size: 22 }));
  if (churchSettings.logo) fitLogoToBackground(brandMark, churchSettings.logo, getComputedStyle(document.documentElement).getPropertyValue('--panel'));
  root.replaceChildren(h('div', { class: 'shell' },
    h('nav', {}, h('div', { class: 'brand' }, brandMark,
        h('h1', {}, 'The Church', h('span', {}, 'Flow'), h('small', {}, churchSettings.motto || 'Church management'))),
      h('div', { class: 'navlinks' }, navItems),
      h('button', { class: 'signout', onclick: async () => { if (!pending || confirm(`${pending} changes haven't synced yet. They'll be kept if you sign back into this church on this device, but lost if a different church signs in here first. Sign out anyway?`)) { await repo.logout(); setTab(null); render(); } } }, h('span', { class: 'ico' }, icon('signout')), h('span', {}, 'Sign out'))),
    h('main', {}, h('div', { class: 'bar top' }, topBar), h('div', { class: 'view-enter' }, view)),
    mobileTabbar));
}

// Two panes on a screen wide enough for them: a teal/navy info side (the same hero-gradient the
// dashboard uses) selling what the app actually does, next to the sign-in/registration card
// itself — a more typical "marketing login" look than a lone card floating on a plain backdrop.
// Phone keeps things simple: the info side just isn't there (see the max-width:760px rule in
// style.css), so it's the same single centered card as before, just with the nicer form controls
// below. `.login-page`/`.login-card` (the plain single-card look) stay as they were for
// admin.js's own separate operator console — this only touches the church app's own login.
const LOGIN_FEATURES = [
  ['members', 'Members & households, all in one directory'],
  ['attendance', 'Attendance in a tap, even offline'],
  ['finance', 'Giving, pledges and reports tracked automatically'],
  ['calendar', 'Programmes and events everyone can see'],
];
// The login screen's "Forgot password?" link — a small modal that always ends with the same
// generic confirmation, whether or not the email actually has an account (the server itself
// never says either way — see its own note on that in server/src/app.js), so this can't be used
// to find out who has an account here.
function openForgotPassword(prefillValue) {
  const emailIn = h('input', { type: 'email', required: true, autocomplete: 'email', value: prefillValue || '' });
  const btn = h('button', { class: 'btn block' }, 'Send reset link');
  const send = async () => {
    const email = emailIn.value.trim();
    if (!email) return emailIn.focus();
    btn.disabled = true;
    try { await repo.requestPasswordReset(email); }
    catch { /* the endpoint itself never errors for a bad/unknown email — only a real network problem lands here, and the message below still covers it fine */ }
    m.close();
    toast("If that email has an account, we've sent a link to reset the password.");
  };
  btn.onclick = send;
  const m = modal('Reset your password', h('div', {},
    h('p', {}, "Enter the email on your account — if it has one, we'll send a link to reset the password."),
    h('label', {}, 'Email'), emailIn,
    h('p', { class: 'actions' }, btn)));
  emailIn.focus();
}

// Reached from /?resetToken=... (see render()'s check above), the link a password-reset email
// (server/src/email.js) sends out. Its own login-shell/login-card markup below deliberately
// mirrors renderLogin()'s — same brand mark and layout — rather than reusing renderLogin() itself,
// since this screen needs none of its login/register mode-switching, just one password field.
function renderResetPassword(token) {
  const err = h('div', { class: 'err', role: 'alert' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      await repo.resetPassword(token, f.elements.password.value);
      // Drop the one-time token from the address bar now that it's spent, so refreshing this tab
      // (or a share/bookmark of it) can't try to reuse it or leave it sitting in browser history.
      history.replaceState(null, '', location.pathname);
      toast('Password updated — sign in with your new password.');
      render();
    } catch (ex) {
      err.textContent = ex.message === 'Failed to fetch' ? 'Cannot reach the server. Try again once you\'re online.' : ex.message;
      btn.disabled = false;
    }
  } },
    passwordField('New password', { autocomplete: 'new-password', withStrength: true }), err,
    h('p', {}, h('button', { class: 'btn block' }, 'Set new password')));
  const brandRow = (cls) => h('div', { class: `brand-row ${cls}` }, h('span', { class: 'brand-mark icon' }, icon('church', { size: 22 })),
    h('div', { class: 'wordmark' }, 'The Church', h('span', {}, 'Flow')));
  root.replaceChildren(h('div', { class: 'login-shell' },
    h('div', { class: 'login-aside' },
      h('div', { class: 'login-aside-body' },
        brandRow('login-aside-brand'),
        h('h2', {}, 'Choose a new password.'), h('p', {}, "Pick something you haven't used here before — you'll use it to sign in from now on.")),
      h('div', { class: 'login-aside-watermark' }, icon('church', { size: 220 }))),
    h('div', { class: 'login-main' }, h('div', { class: 'card login-card' },
      brandRow('login-mobile-brand'),
      h('h1', {}, 'Reset your password'), h('p', { class: 'subtitle' }, 'This link only works once.'),
      f,
      h('p', { class: 'switch' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); history.replaceState(null, '', location.pathname); render(); } }, 'Back to sign in'))))));
}

function renderLogin() {
  let mode = 'login';
  // Set right after a successful registration so the login screen that follows can prefill the
  // email the person just chose — cleared as soon as it's been used, so it never leaks into a
  // later plain sign-in.
  let prefillEmail = '';
  const COPY = {
    login: { h1: 'Welcome back', sub: "Sign in to your church's workspace.", btn: 'Sign in', switchTo: 'Register a new church',
      asideH: 'Good to see you again.', asideP: 'Pick up right where you left off — your members, attendance and giving are all synced and waiting.' },
    register: { h1: 'Register your church', sub: 'Create your account — takes less than a minute.', btn: 'Create church account', switchTo: 'I already have an account',
      asideH: 'Run your whole church from one place.', asideP: "Members, attendance, giving and programmes — organized and synced across every device, even when the internet isn't." },
  };
  const draw = () => {
    const c = COPY[mode];
    const err = h('div', { class: 'err', role: 'alert' });
    const emailInput = h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username', value: prefillEmail });
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const g = (n) => f.elements[n].value.trim();
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        if (mode === 'login') {
          const email = g('email'), password = f.elements.password.value;
          try {
            await repo.login(email, password);
          } catch (ex) {
            if (ex.message !== 'Failed to fetch') throw ex; // a real answer from the server (e.g. wrong password) — don't second-guess it
            await repo.loginOffline(email, password); // couldn't even reach the server — fall back to this device's saved copy, if any
          }
          await sync(); render();
        } else {
          const email = g('email');
          await repo.registerChurch({ churchName: g('church'), name: g('name'), email, password: f.elements.password.value });
          // Registering signs the account in server-side, but we don't want to drop the person
          // straight into the dashboard — send them back to the sign-in screen so they log in
          // explicitly, same as anyone else. Nothing has synced yet at this point, so clearing
          // the session here can't lose any data.
          await repo.logout();
          toast('Church created — sign in to get started.');
          mode = 'login'; prefillEmail = email; draw();
        }
      } catch (ex) { err.textContent = ex.message === 'Failed to fetch' ? 'Cannot reach the server. The first sign-in needs internet.' : ex.message; btn.disabled = false; }
    } },
      mode === 'register' && [h('label', {}, 'Church name'), h('input', { name: 'church', required: true }), h('label', {}, 'Your name'), h('input', { name: 'name', required: true, autocomplete: 'name' })],
      h('label', {}, 'Email'), emailInput,
      // The strength meter only makes sense while picking a *new* password — signing in shows
      // just the reveal toggle, not a live grade of a password that's already set.
      passwordField('Password', { autocomplete: mode === 'login' ? 'current-password' : 'new-password', withStrength: mode === 'register' }), err,
      mode === 'login' && h('p', { class: 'forgot-link' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openForgotPassword(emailInput.value.trim()); } }, 'Forgot password?')),
      h('p', {}, h('button', { class: 'btn block' }, c.btn)));
    prefillEmail = '';
    const brandRow = (cls) => h('div', { class: `brand-row ${cls}` }, h('span', { class: 'brand-mark icon' }, icon('church', { size: 22 })),
      h('div', { class: 'wordmark' }, 'The Church', h('span', {}, 'Flow')));
    root.replaceChildren(h('div', { class: 'login-shell' },
      h('div', { class: 'login-aside' },
        h('div', { class: 'login-aside-body' },
          brandRow('login-aside-brand'),
          h('h2', {}, c.asideH), h('p', {}, c.asideP),
          h('ul', { class: 'login-features' }, LOGIN_FEATURES.map(([ic, text]) =>
            h('li', {}, h('span', { class: 'ico' }, icon(ic, { size: 16 })), text)))),
        h('div', { class: 'login-aside-watermark' }, icon('church', { size: 220 }))),
      h('div', { class: 'login-main' }, h('div', { class: 'card login-card' },
        // Shown only on phone, where .login-aside above is hidden entirely — otherwise the
        // brand mark would be missing from the screen altogether.
        brandRow('login-mobile-brand'),
        h('h1', {}, c.h1), h('p', { class: 'subtitle' }, c.sub),
        f,
        h('p', { class: 'switch' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); } }, c.switchTo))))));
  };
  draw();
}

addEventListener('online', () => { online = true; sync(); });
addEventListener('offline', () => { online = false; render(); });
// The notification bell (see notificationBell() above), any ui.js menu() dropdown, and phone's
// own bottom-bar "More" panel (mobileTabbar's .mobile-more, above) are all native
// <details>/<summary> — clicking their own summary toggles them, and a full render() (e.g.
// after navigating to a tab) rebuilds them closed from scratch, but neither of those covers a
// click elsewhere on the page while nothing else changes (e.g. just glancing at the dashboard
// behind it). One delegated listener at the document level, registered once here rather than
// per-render, closes whichever of them is currently open whenever a click lands outside it.
addEventListener('click', (e) => {
  for (const open of document.querySelectorAll('.notif-bell[open], .menu[open], .mobile-more[open]')) if (!open.contains(e.target)) open.removeAttribute('open');
});
// sync() itself now skips its own render() calls while a form control in the page is focused
// (see isEditingPage() above), so these automatic triggers no longer need to guard themselves.
let t; repo.onChange(() => { clearTimeout(t); t = setTimeout(async () => { if (await repo.pending()) sync(); }, 1500); });
setInterval(() => { sync(); }, 60_000);
render().then(() => sync());

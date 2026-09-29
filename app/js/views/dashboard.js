import { h, byName, sum, money, today, fmtDate, monthKey, barChart, ringStat, relTime, empty, attendanceCount, signedAmount,
  nextOccurrence, daysUntil, countdownLabel, fitLogoToBackground, dateKey } from '../ui.js';
import { icon } from '../icons.js';
import { STATUSES } from './members.js';

export async function dashboardView({ repo, user, ministries, members, go }) {
  const role = user.role;
  const wantsFinance = ['owner', 'admin', 'treasurer'].includes(role);
  const wantsPeople = role !== 'treasurer';
  const [tx, att, updates, messages, programmesRaw, churchName, settingsList] = await Promise.all([wantsFinance ? repo.list('transactions') : [], wantsPeople ? repo.list('attendance') : [],
    wantsPeople ? repo.list('ministryUpdates') : [], wantsPeople ? repo.list('messages') : [], repo.list('programmes'), repo.churchName(), repo.list('settings')]);
  const cs = settingsList.find((s) => s.id === 'church') ?? {};
  const month = monthKey(today());
  // whichever programmes (Harvest, Convention, Watch Night…) fall within the next two
  // weeks, nearest first — every role sees this, since it's not ministry- or role-specific.
  const soonProgrammes = programmesRaw.map((p) => { const occ = nextOccurrence(p.date, p.recurring); return { ...p, occ, days: daysUntil(occ) }; })
    .filter((p) => p.days >= 0 && p.days <= 14).sort((a, b) => a.days - b.days);
  const income = (list) => list.filter((t) => t.type !== 'expense');
  // one of HotspotHub's four tone accents per tile (colors the top tab + icon box) — cycling
  // by which screen the tile links to, so the same screen always gets the same tone.
  const TILE_TONE = { members: 'tone-blue', ministries: 'tone-teal', attendance: 'tone-purple', finance: 'tone-orange' };
  const tile = (ic, n, l, tab) => h('div', { class: `card stat tile ${TILE_TONE[tab] ?? ''} ${tab ? 'click' : ''}`.trim(), onclick: tab && (() => go(tab)) },
    h('span', { class: 'stat-ico' }, icon(ic, { size: 19 })), h('div', { class: 'stat-body' }, h('b', {}, n), h('span', {}, l)));

  const church = att.filter((a) => !a.ministryId).sort((a, b) => b.date.localeCompare(a.date));
  const attChart = church.slice(0, 8).reverse().map((a) => ({ label: a.date.slice(5), value: attendanceCount(a) }));
  const months = [...Array(6)].map((_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i)); return dateKey(d).slice(0, 7); }); // local month, not UTC (toISOString would shift near a month boundary)
  const giveChart = months.map((mo) => ({ label: mo.slice(5), value: sum(income(tx).filter((t) => monthKey(t.date) === mo), signedAmount) }));

  // this week's attendance (all services, last 7 days including today)
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoStr = dateKey(weekAgo); // local calendar day, not UTC (see today()'s own comment in ui.js)
  const weekAttendance = sum(att.filter((a) => a.date >= weekAgoStr), attendanceCount);

  // members by status, one ring-with-percentage widget per status
  const RING_COLORS = ['var(--tone-blue)', 'var(--tone-teal)', 'var(--tone-purple)', 'var(--mute)'];
  const statusCounts = STATUSES.map((s) => ({ label: s, value: members.filter((m) => m.status === s).length }));
  const statusTotal = sum(statusCounts, (s) => s.value);

  // people who need attention
  const thisMonth = new Date().getMonth();
  const birthdays = members.filter((m) => m.birthday && new Date(m.birthday + 'T00:00:00').getMonth() === thisMonth)
    .sort((a, b) => a.birthday.slice(8).localeCompare(b.birthday.slice(8)));
  const visitors = members.filter((m) => m.status === 'visitor');
  const recent = church.slice(0, 3);
  const absent = recent.length === 3 ? members.filter((m) => m.status === 'member' && att.some((a) => a.presentIds?.includes(m.id)) && !recent.some((a) => a.presentIds?.includes(m.id))) : [];

  const list = (title, items, render, none) => h('div', { class: 'card' }, h('b', {}, title), items.length ? h('ul', { class: 'plain' }, items.slice(0, 6).map((x) => h('li', {}, render(x)))) : h('p', { class: 'hint' }, none),
    items.length > 6 && h('p', { class: 'hint' }, `+ ${items.length - 6} more`));

  // ---- recent activity feed: merge announcements, newly added members and attendance
  // takes already loaded above — no extra collections or requests, just re-sort what's here.
  const activity = [
    ...messages.map((m) => ({ date: m.date, at: m.at ?? 0, ic: 'notices', text: `${m.author} posted: ${m.text.length > 70 ? m.text.slice(0, 70) + '…' : m.text}` })),
    ...members.filter((m) => m.joined).map((m) => ({ date: m.joined, at: 0, ic: 'members', text: `${m.name} joined the church` })),
    ...att.map((a) => ({ date: a.date, at: 0, ic: 'attendance', text: `${a.service}${a.ministryId ? '' : ' (whole church)'} — ${attendanceCount(a)} present` })),
  ].sort((x, y) => y.date.localeCompare(x.date) || y.at - x.at).slice(0, 5);

  // ---- hero card: a dark navy gradient card up top (church identity + a few headline
  // numbers), in the spirit of the account-summary card on HotspotHub's own dashboard — same
  // "one dark card with your name and stats on it" feeling, different content and layout.
  const heroStats = [
    { v: fmtDate(today()).replace(/,? \d{4}$/, ''), l: 'Today' },
    wantsPeople && { v: members.length, l: 'Members' },
    wantsPeople ? { v: weekAttendance, l: "This week's attendance" } : wantsFinance && { v: money(sum(income(tx).filter((t) => t.date.startsWith(month)), signedAmount)), l: "This month's giving" },
  ].filter(Boolean);
  const firstName = user.name.split(' ')[0];
  // Time-of-day greeting instead of a flat "Welcome back" — a small touch, but one that makes
  // the dashboard feel like it's actually looking at the clock rather than showing the same
  // static line all day.
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  // The logo sits plain on the hero gradient by default (see .dash-hero-badge in style.css);
  // fitLogoToBackground only adds a contrasting card behind it if the logo's own colours are
  // close to the hero's — checked against --navy, the gradient's own dark corner colour where
  // the badge actually sits, so this stays right even if the palette changes later. No logo
  // set → the generic church icon keeps its usual frosted-glass box (the 'icon' class).
  const heroBadge = h('div', { class: cs.logo ? 'dash-hero-badge' : 'dash-hero-badge icon' },
    cs.logo ? h('img', { src: cs.logo, alt: '' }) : icon('church', { size: 24 }));
  if (cs.logo) fitLogoToBackground(heroBadge, cs.logo, getComputedStyle(document.documentElement).getPropertyValue('--navy'));

  return h('div', {},
    h('div', { class: 'dash-hero' },
      // An admin-picked background photo (Settings → Church profile) replaces the plain
      // decorative watermark icon — the two don't compete for the same space. The gradient
      // itself is unaffected either way: it's .dash-hero's own background, painted underneath.
      cs.heroImage
        ? h('div', { class: 'dash-hero-photo', style: `background-image:url(${cs.heroImage});opacity:${(cs.heroImageOpacity ?? 35) / 100}` })
        : h('div', { class: 'dash-hero-watermark' }, icon('church', { size: 170 })),
      h('div', { class: 'dash-hero-top' },
        heroBadge,
        h('div', { class: 'dash-hero-id' },
          h('div', { class: 'dash-hero-name' }, churchName || 'Your church'),
          h('div', { class: 'dash-hero-tagline' }, `${greeting}, ${firstName} 👋${cs.motto ? ` · ${cs.motto}` : ''}`))),
      h('div', { class: 'dash-hero-stats' }, heroStats.map((s) => h('div', { class: 'dash-hero-stat' }, h('b', {}, s.v), h('span', {}, s.l))))),
    // A month/day date chip (see .date-chip in style.css) reads at a glance, like a paper
    // calendar page, in place of the plain calendar icon every other feed-list uses — the
    // weekday name fills the spot the date used to occupy, so nothing shown before is lost.
    soonProgrammes.length > 0 && h('div', { class: 'card' }, h('b', {}, 'Upcoming programmes'),
      h('ul', { class: 'feed-list' }, soonProgrammes.map((p) => h('li', {},
        h('div', { class: 'date-chip' }, h('span', {}, p.occ.toLocaleDateString(undefined, { month: 'short' })), h('b', {}, p.occ.getDate())),
        h('div', { class: 'fi-body' }, h('b', {}, p.name), h('time', {}, [p.occ.toLocaleDateString(undefined, { weekday: 'long' }), p.location].filter(Boolean).join(' · '))),
        h('span', { class: `pill ${p.days <= 1 ? 'warn' : ''}` }, countdownLabel(p.days)))))),
    h('div', { class: 'grid' },
      wantsPeople && tile('members', members.length, 'Total members', 'members'),
      role !== 'treasurer' && tile('church', ministries.length, 'Active ministries', 'ministries'),
      wantsPeople && tile('attendance', weekAttendance, "This week's attendance", 'attendance'),
      wantsFinance && tile('finance', money(sum(income(tx).filter((t) => t.date.startsWith(month)), signedAmount)), "This month's giving", 'finance')),
    h('div', { class: 'grid wide' },
      attChart.length > 1 && h('div', { class: 'card' }, h('b', {}, 'Attendance trend'), barChart(attChart)),
      wantsFinance && h('div', { class: 'card' }, h('b', {}, 'Giving by month'), barChart(giveChart, { format: (v) => (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)) })),
      wantsPeople && statusTotal > 0 && h('div', { class: 'card' }, h('b', {}, 'Members by status'),
        h('div', { class: 'ring-row' }, statusCounts.map((s, i) => ringStat(statusTotal ? (s.value / statusTotal) * 100 : 0, s.label, RING_COLORS[i % RING_COLORS.length])))),
      wantsPeople && activity.length > 0 && h('div', { class: 'card' }, h('b', {}, 'Recent activity'),
        h('ul', { class: 'feed-list' }, activity.map((a) => h('li', {}, h('span', { class: 'fi-ico' }, icon(a.ic, { size: 15 })),
          h('div', { class: 'fi-body' }, a.text, h('time', {}, relTime(a.date))))))) ),
    wantsPeople && h('div', { class: 'grid wide' },
      list('Birthdays this month', birthdays, (m) => [h('b', {}, m.name), ` · ${fmtDate(m.birthday).replace(/,? \d{4}$/, '')}`], 'No birthdays recorded this month.'),
      list('Visitors to follow up', visitors, (m) => [h('b', {}, m.name), m.phone ? ` · ${m.phone}` : ''], 'No visitors on the list.'),
      list('Not seen in the last 3 services', absent, (m) => [h('b', {}, m.name), m.phone ? ` · ${m.phone}` : ''], recent.length < 3 ? 'Shows once 3 services are recorded.' : 'Everyone is attending. 🙌'),
      role !== 'treasurer' && list('Latest ministry updates', updates.sort((a, b) => b.date.localeCompare(a.date)), (u) => [h('b', {}, ministries.find((m) => m.id === u.ministryId)?.name ?? ''), `: ${u.text.slice(0, 80)}`], 'No updates posted yet.')),
    !members.length && !ministries.length && wantsPeople && h('div', { class: 'card' }, h('b', {}, 'Getting started'), h('ol', {}, h('li', {}, 'Add your ministries (Choir, Youth, Ushers…).'), h('li', {}, 'Add members and assign them to ministries.'),
      h('li', {}, 'Create login accounts for your ministry leaders under Staff.'), h('li', {}, 'Record attendance and giving each week.'))));
}

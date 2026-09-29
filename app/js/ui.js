// Shared UI helpers: element builder, modal, toast, formatting, CSV, SVG charts.
import { CURRENCY } from './config.js';
import { icon } from './icons.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(2)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

// The ChurchFlow's own brand mark — as opposed to a church's own uploaded logo, which always takes
// priority wherever one exists (see churchSettings.logo/cs.logo throughout, and the ministry/give
// logo fallbacks, which still fall back to the generic icon('church') outline, not this: those slots
// represent a specific church's or ministry's own identity, not the product's). This is what shows
// wherever the product itself needs to speak for itself instead: every sign-in/sign-up/reset screen,
// the platform-admin console's own brand, and the public giving/check-in pages before a church's
// own branding loads. A plain <img> onto the existing .brand-mark box (see style.css's
// `.brand-mark img { width:100%; height:100%; object-fit:contain; }`) rather than one of the
// inline icon() SVGs used elsewhere, since the real logo is a raster asset with its own colour and
// background baked in — callers drop the 'icon' class (which would otherwise paint a redundant
// teal box behind it) from the wrapping .brand-mark element.
export const brandLogo = () => h('img', { src: 'brand/logo-192.png', alt: '' });

// A fetch()-level failure — offline, DNS failure, CORS, the server simply not reachable — always
// throws a TypeError, but its exact wording differs by browser engine: "Failed to fetch" in
// Chrome/Edge/WebView2 (the Windows desktop build), "Load failed" in Safari/WKWebView (the Mac
// desktop build), "NetworkError when attempting to fetch resource." in Firefox. Matching on the
// message text — as this used to do — only ever caught the Chrome wording, so on Mac this class
// of error slipped through as a generic, unhelpful message instead of "you're offline" (and, in
// the login form, meant the offline-sign-in fallback never even triggered). Checking the error's
// TYPE instead of its wording works the same on every engine. Never true for an error `sync.js`'s
// http() throws for a real server response (a plain Error with a `.status`, even for 4xx/5xx).
export const isNetworkError = (ex) => ex instanceof TypeError;

// dateKey (below) is the local-calendar-day version of this — today() is defined up here since
// it's used throughout the file before dateKey's own definition further down, but it delegates
// to the exact same local Date parts rather than toISOString(), which is UTC and can be a day
// off depending on the browser's time zone (harmless in Ghana itself, UTC+0, but wrong anywhere
// else — e.g. any time after 8pm Eastern time is already "tomorrow" in UTC).
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const money = (n) => `${CURRENCY} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const byName = (a, b) => (a.name ?? '').localeCompare(b.name ?? '');
export const sum = (xs, f = (x) => x) => xs.reduce((s, x) => s + Number(f(x) || 0), 0);
export const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
// Whole years since a plain YYYY-MM-DD birthday, as of today — used next to a member's
// birthday in their profile (e.g. "Apr 4, 1990 · Age 36").
export function ageFromBirthday(d) {
  if (!d) return null;
  const b = new Date(d + 'T00:00:00'), t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) age--;
  return age;
}
// A plain 24-hour "HH:MM" (what <input type=time> stores) as a locale-formatted clock time,
// e.g. "6:00 PM" — used for a ministry's meeting time.
export const fmtTime = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
// A short "3 days ago" style label for a plain YYYY-MM-DD (or full ISO) date string —
// used by the dashboard's recent-activity feed.
export function relTime(d) {
  if (!d) return '';
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d.slice(0, 10) + 'T00:00:00').getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} week${Math.round(days / 7) > 1 ? 's' : ''} ago`;
  if (days < 365) return `${Math.round(days / 30)} month${Math.round(days / 30) > 1 ? 's' : ''} ago`;
  return `${Math.round(days / 365)} year${Math.round(days / 365) > 1 ? 's' : ''} ago`;
}
export const monthKey = (d) => d.slice(0, 7);
// Late still means they showed up — just not on time — so it counts toward the attendance
// total the same as Present. Excused means they did NOT attend (there's just a known reason),
// so it's deliberately left out of the count, same as an unmarked/absent person.
export const attendanceCount = (a) => (a.presentIds?.length ?? 0) + (a.lateIds?.length ?? 0) + (a.extra ?? 0);

// The roster widget for taking attendance: each person gets three small status buttons —
// present / late / excused — instead of the plain checkbox this used to be before Late/Excused
// existed. Unmarked (none "on") means absent, same meaning an unchecked box had before. Shared
// between attendance.js's own take-attendance form and ministries.js's identical inline one, so
// the three-state behaviour (and its little bit of DOM bookkeeping) only lives in one place.
export function attendanceChecklist(people, rec) {
  const statusOf = (p) => (rec.presentIds?.includes(p.id) ? 'present' : rec.lateIds?.includes(p.id) ? 'late' : rec.excusedIds?.includes(p.id) ? 'excused' : null);
  const status = new Map(people.map((p) => [p.id, statusOf(p)]));
  const STATUS_BTNS = [['present', 'P', 'Present'], ['late', 'L', 'Late'], ['excused', 'E', 'Excused']];
  let onChange = () => {};
  const rows = people.map((p) => {
    const group = h('div', { class: 'att-status-group' });
    const redraw = () => group.replaceChildren(...STATUS_BTNS.map(([key, short, label]) =>
      h('button', { type: 'button', class: `att-status att-status-${key}${status.get(p.id) === key ? ' on' : ''}`, title: `Mark ${label.toLowerCase()}`,
        onclick: () => { status.set(p.id, status.get(p.id) === key ? null : key); redraw(); onChange(); } }, short)));
    redraw();
    return { p, redraw, el: h('div', { class: 'att-row' }, h('span', { class: 'att-name' }, p.name), group) };
  });
  return {
    el: h('div', { class: 'checklist att-checklist' }, rows.map((r) => r.el)),
    onChange: (fn) => { onChange = fn; },
    filter: (q) => rows.forEach(({ p, el }) => (el.hidden = q && !p.name.toLowerCase().includes(q.toLowerCase()))),
    markAllShown: () => { rows.forEach(({ p, el, redraw }) => { if (!el.hidden) status.set(p.id, 'present'); redraw(); }); onChange(); },
    clear: () => { rows.forEach(({ p, redraw }) => { status.set(p.id, null); redraw(); }); onChange(); },
    counts: () => { const c = { present: 0, late: 0, excused: 0 }; for (const s of status.values()) if (s) c[s]++; return c; },
    result: () => {
      const out = { presentIds: [], lateIds: [], excusedIds: [] };
      for (const [id, s] of status) { if (s === 'present') out.presentIds.push(id); else if (s === 'late') out.lateIds.push(id); else if (s === 'excused') out.excusedIds.push(id); }
      return out;
    },
  };
}
// A reversal entry carries the same type/member/ministry as what it cancels but should net
// against it, not double-count alongside it, wherever transactions are totaled.
export const signedAmount = (t) => (t.reverses ? -t.amount : t.amount);

// ---- forms ----
export const field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint && h('div', { class: 'hint' }, hint));
export const val = (form, name) => form.elements[name].value.trim();
export const opts = (list, selected) => list.map((o) => {
  const [value, label] = Array.isArray(o) ? o : [o, o];
  return h('option', { value, selected: value === selected }, label);
});

// A crude but reasonable-enough heuristic: length plus how many different character kinds are
// mixed in, capped so a single very long run of one kind (e.g. "aaaaaaaaaaaa") doesn't read as
// "Strong". Good enough to nudge someone off a weak password without pretending to be a real
// entropy calculation.
function passwordStrength(v) {
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 12) score++;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
  if (/\d/.test(v)) score++;
  if (/[^a-zA-Z0-9]/.test(v)) score++;
  score = Math.min(score, 4);
  return { score, text: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

// A password field with an eye button to reveal what's actually been typed (`type=password`
// hides typos as much as it hides shoulder-surfers), and — for registration only — a live
// strength meter underneath so someone picks a stronger password before they submit rather than
// finding out it's rejected server-side. Returns the wrapping element; the input itself keeps
// its `name` so it's still reachable as the usual `form.elements.<name>`/`val(form, name)`.
export function passwordField(label, { name = 'password', autocomplete = 'current-password', minlength = 8, withStrength = false } = {}) {
  const input = h('input', { name, type: 'password', minlength, required: true, autocomplete });
  const toggle = h('button', { type: 'button', class: 'pw-toggle', 'aria-label': 'Show password' }, icon('eye', { size: 17 }));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye', { size: 17 }));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  const wrap = h('div', { class: 'pw-wrap' }, input, toggle);
  let meter = null;
  if (withStrength) {
    const bar = h('div', { class: 'pw-meter-bar' });
    const meterLabel = h('span', { class: 'pw-meter-label' });
    meter = h('div', { class: 'pw-meter', hidden: true }, h('div', { class: 'pw-meter-track' }, bar), meterLabel);
    input.addEventListener('input', () => {
      meter.hidden = !input.value;
      if (!input.value) return;
      const { score, text } = passwordStrength(input.value);
      bar.className = `pw-meter-bar s${score}`;
      bar.style.width = `${(score + 1) * 20}%`;
      meterLabel.className = `pw-meter-label s${score}`;
      meterLabel.textContent = text;
    });
  }
  return h('div', {}, h('label', {}, label), wrap, meter);
}

// ---- toast ----
export function toast(msg, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  while (box.children.length >= 3) box.firstChild.remove();
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t); setTimeout(() => t.remove(), 3200);
}

// ---- modal ----
// `wide` (760px) suits a form; `xwide` (920px) is for content-heavy screens like a member's
// full profile, where two-column stat/kv grids otherwise get squeezed into one narrow column.
// Both fall back to a full-width bottom sheet on phone (see the max-width:760px rule in
// style.css) — the size option only changes anything on a screen wide enough to show it.
export function modal(title, body, { wide = false, xwide = false } = {}) {
  const close = () => { back.classList.add('closing'); setTimeout(() => back.remove(), 140); document.removeEventListener('keydown', esc); };
  const esc = (e) => e.key === 'Escape' && close();
  const back = h('div', { class: 'backdrop', onclick: (e) => e.target === back && close() },
    h('div', { class: `modal ${xwide ? 'xwide' : wide ? 'wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('b', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, icon('close', { size: 18 }))),
      h('div', { class: 'modal-body' }, body)));
  document.addEventListener('keydown', esc);
  document.body.append(back);
  return { close, el: back };
}

export function confirmDialog(message, action = 'Delete') {
  return new Promise((resolve) => {
    const m = modal('Please confirm', h('div', {}, h('p', {}, message),
      h('p', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => { m.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => { m.close(); resolve(true); } }, action))));
  });
}

// ---- dropdown menu ----
// A small "Button ▾" action menu (a person's profile header, a row with several things you
// could do to it) — a native <details>/<summary> exactly like main.js's own notification bell,
// so it needs no outside-click handling of its own beyond the one delegated listener main.js
// already registers for every `.menu[open]` (a generalized version of what it already did for
// `.notif-bell`). `items` is an array of {label, icon?, danger?, onclick} — or {href, target?,
// rel?} instead of onclick for a real link (tel:/https:), which behaves better than a handler
// that fakes navigation. Pass `false`/`null` for an item that doesn't apply right now (e.g. no
// phone on file) and it's left out entirely.
export function menu(label, items, { cls = '' } = {}) {
  const visible = items.filter(Boolean);
  const d = h('details', { class: `menu ${cls}` },
    h('summary', { class: 'btn' }, label, icon('chevronDown', { size: 14 })),
    h('div', { class: 'menu-dropdown' }, visible.map((it) => {
      const tag = it.href ? 'a' : 'button';
      const attrs = it.href ? { href: it.href, target: it.target, rel: it.rel } : { type: 'button', onclick: () => { d.removeAttribute('open'); it.onclick(); } };
      return h(tag, { class: `menu-item ${it.danger ? 'danger' : ''}`, ...attrs, ...(it.href && { onclick: () => d.removeAttribute('open') }) },
        it.icon && icon(it.icon, { size: 14 }), it.label);
    })));
  return d;
}

// ---- bulk selection ----
// Shared by any list/table screen that lets staff select several records and act on them
// together (Members, Attendance, Notices, Programme calendar): a row checkbox, a "select all
// visible" header checkbox, and a small toolbar of actions that appears once one or more rows
// are selected. One of these per screen; the screen's own draw() calls bar.sync(visibleIds)
// every time it redraws so the selection, header checkbox and toolbar always match what's
// actually on screen right now — a filter change (or a row disappearing after some other edit)
// never leaves a stale, no-longer-visible id "selected" behind the scenes.
// `actions` is a list of { label, danger?, run(ids) } — run() gets the selected ids as a plain
// array and is responsible for its own confirmation dialog (for a destructive action) and
// calling the screen's rerender() when it's done; the toolbar itself doesn't rerender the
// screen; a full rerender rebuilds this bar from scratch anyway, which already clears selection.
export function bulkBar(actions) {
  const selected = new Set();
  const boxes = new Map(); // id -> that row's currently-rendered checkbox element
  const bar = h('div', { class: 'bulk-bar', hidden: true });
  let ids = [], headEl = null;
  const refreshHead = () => { if (headEl) { headEl.checked = ids.length > 0 && ids.every((id) => selected.has(id)); headEl.indeterminate = selected.size > 0 && !headEl.checked; } };
  // Toggling selection anywhere other than a direct click on a row's own checkbox (the header
  // "select all", or the toolbar's "Clear selection") changes `selected` without that row
  // checkbox ever getting its own click event — a real DOM checkbox doesn't pick up a `checked`
  // change made after it was created just because the underlying Set changed, so those two
  // callers explicitly resync every currently-rendered checkbox's .checked afterwards.
  const refreshBoxes = () => { for (const [id, el] of boxes) el.checked = selected.has(id); };
  const drawBar = () => {
    bar.hidden = selected.size === 0;
    bar.replaceChildren(h('b', {}, `${selected.size} selected`),
      ...actions.map((a) => h('button', { class: `btn sm ${a.danger ? 'danger' : 'ghost'}`, onclick: () => a.run([...selected]) }, a.label)),
      h('button', { class: 'btn ghost sm', onclick: () => { selected.clear(); refreshBoxes(); drawBar(); refreshHead(); } }, 'Clear selection'));
  };
  // Called once per row by the screen's own draw(); the checkbox click stops the click from
  // also bubbling up to the row's own onclick (which usually opens that record).
  const box = (id) => {
    const el = h('input', { type: 'checkbox', checked: selected.has(id),
      onclick: (e) => { e.stopPropagation(); selected[e.target.checked ? 'add' : 'delete'](id); drawBar(); refreshHead(); } });
    boxes.set(id, el);
    return el;
  };
  const headBox = () => { headEl = h('input', { type: 'checkbox', onclick: (e) => {
    if (e.target.checked) ids.forEach((id) => selected.add(id)); else selected.clear();
    refreshBoxes(); drawBar(); refreshHead();
  } }); refreshHead(); return headEl; };
  // Call after every draw(): visibleIds is the full set of ids currently on screen (respecting
  // whatever filters/search are applied), so "select all" only ever selects what's actually shown.
  const sync = (visibleIds) => {
    ids = visibleIds;
    for (const id of [...selected]) if (!ids.includes(id)) selected.delete(id);
    for (const id of [...boxes.keys()]) if (!ids.includes(id)) boxes.delete(id); // drop refs to rows no longer on screen
    drawBar(); refreshHead();
  };
  sync([]);
  return { bar, sync, box, headBox, selected };
}

// ---- files ----
export function download(name, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
export const toCsv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');

// ---- charts (inline SVG, no libraries) ----
export function barChart(data, { height = 140, format = (v) => v } = {}) {
  const W = 320, pad = 22, max = Math.max(1, ...data.map((d) => d.value));
  const bw = (W - pad) / Math.max(1, data.length);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${height + pad}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.append(e); };
  data.forEach((d, i) => {
    const bh = (d.value / max) * (height - 16), x = pad / 2 + i * bw + bw * 0.15, y = height - bh;
    add('rect', { x, y, width: bw * 0.7, height: Math.max(bh, d.value ? 1 : 0), rx: 3, class: 'col' });
    if (d.value) add('text', { x: x + bw * 0.35, y: y - 4, 'text-anchor': 'middle', class: 'val' }, format(d.value));
    add('text', { x: x + bw * 0.35, y: height + 14, 'text-anchor': 'middle', class: 'lab' }, d.label);
  });
  if (!data.some((d) => d.value)) add('text', { x: W / 2, y: height / 2, 'text-anchor': 'middle', class: 'lab' }, 'No data yet');
  return svg;
}

// Same hand-rolled, zero-dependency approach as barChart above: a donut built from plain
// SVG circles (arcs via stroke-dasharray), colored from the app's existing CSS custom
// properties so it stays on-theme in light and dark. Returns a container with the chart
// plus a small legend, ready to drop straight into a card like barChart(...) is.
const DONUT_COLORS = ['var(--tone-blue)', 'var(--tone-teal)', 'var(--tone-purple)', 'var(--tone-orange)', 'var(--mute)'];
export function donutChart(data, { size = 130, thickness = 20 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const total = sum(data, (d) => d.value);
  const r = (size - thickness) / 2, c = 2 * Math.PI * r, cx = size / 2, cy = size / 2;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('class', 'chart donut'); svg.setAttribute('role', 'img');
  const add = (attrs) => { const e = document.createElementNS(ns, 'circle'); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); };
  add({ cx, cy, r, fill: 'none', stroke: 'var(--pill)', 'stroke-width': thickness });
  let offset = 0;
  data.forEach((d, i) => {
    const frac = total ? d.value / total : 0;
    if (frac > 0) add({ cx, cy, r, fill: 'none', stroke: DONUT_COLORS[i % DONUT_COLORS.length], 'stroke-width': thickness,
      'stroke-dasharray': `${frac * c} ${c - frac * c}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${cx} ${cy})` });
    offset += frac * c;
  });
  const addText = (attrs, text) => { const e = document.createElementNS(ns, 'text'); for (const k in attrs) e.setAttribute(k, attrs[k]); e.textContent = text; svg.append(e); };
  addText({ x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'val', style: 'font-size:19px' }, total);
  addText({ x: cx, y: cy + 15, 'text-anchor': 'middle', style: 'font-size:10px' }, 'total');
  const legend = h('ul', { class: 'legend' }, data.map((d, i) => h('li', {},
    h('i', { style: `background:${DONUT_COLORS[i % DONUT_COLORS.length]}` }), h('span', {}, d.label), h('b', {}, d.value))));
  return h('div', { class: 'donut-wrap' }, svg, total ? legend : empty('No data yet'));
}

export const empty = (msg) => h('p', { class: 'empty' }, msg);

// A small hand-rolled-SVG ring with a percentage in the middle and a label underneath —
// same technique as donutChart/barChart above (plain <circle> stroke-dasharray arcs, colored
// from the app's CSS custom properties). Used for the dashboard's one-ring-per-status row.
export function ringStat(percent, label, color = 'var(--primary)', { size = 76, thickness = 8 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const r = (size - thickness) / 2, c = 2 * Math.PI * r, cx = size / 2, cy = size / 2;
  const frac = Math.max(0, Math.min(1, (percent || 0) / 100));
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('class', 'chart ring'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}: ${Math.round(percent || 0)}%`);
  const addC = (attrs) => { const e = document.createElementNS(ns, 'circle'); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); };
  addC({ cx, cy, r, fill: 'none', stroke: 'var(--pill)', 'stroke-width': thickness });
  if (frac > 0) addC({ cx, cy, r, fill: 'none', stroke: color, 'stroke-width': thickness, 'stroke-linecap': 'round',
    'stroke-dasharray': `${frac * c} ${c - frac * c}`, transform: `rotate(-90 ${cx} ${cy})` });
  const t = document.createElementNS(ns, 'text');
  t.setAttribute('x', cx); t.setAttribute('y', cy + 5); t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'val'); t.setAttribute('style', 'font-size:15px');
  t.textContent = `${Math.round(percent || 0)}%`; svg.append(t);
  return h('div', { class: 'ring-stat' }, svg, h('span', {}, label));
}

// Up to two initials from a person's name, for a small colored avatar circle (sidebar).
export function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// ---- photos (member passport pictures, church logo) ----
// There's no server-side file storage, so a picked image is resized and compressed
// client-side, in the browser, into a small base64 data URI that just rides along as an
// ordinary field on the record — well under the sync request's size limit even alongside
// whatever else is in the same batch. maxSize bounds the longer edge in pixels.
export function compressImage(file, { maxSize = 320, quality = 0.72, maxBytes = 500 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file.'));
    // A PNG/WebP/GIF source may have a transparent background (a church logo cut out in an
    // image editor, say). JPEG has no alpha channel, so re-encoding one as JPEG paints every
    // see-through pixel solid black — a logo that looked fine in the file picker shows up with
    // a black box around it. WebP keeps transparency and still compresses like JPEG; where a
    // browser can't encode WebP (older Safari), fall back to plain PNG (lossless, alpha-safe,
    // just with no quality knob — it's shrunk by pixel size only instead).
    const preserveAlpha = /^image\/(png|webp|gif)$/.test(file.type);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = canvas.height = 2;
      const webpOk = preserveAlpha && canvas.toDataURL('image/webp').startsWith('data:image/webp');
      const mime = !preserveAlpha ? 'image/jpeg' : webpOk ? 'image/webp' : 'image/png';
      // Every member's passport photo and the church logo sync down to every permitted
      // device's IndexedDB store and live in the server's database for every church on the
      // plan, so each one is kept well under maxBytes (500KB by default) — not just resized
      // once. If a first pass still comes out too big (a very detailed photo, or a source
      // image an unusual aspect ratio), keep re-encoding at a lower quality and then a
      // smaller pixel size until it fits, rather than storing whatever the first attempt gave.
      let size = maxSize, q = quality, dataUri;
      for (let attempt = 0; attempt < 8; attempt++) {
        const scale = Math.min(1, size / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        canvas.width = w; canvas.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        dataUri = mime === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL(mime, q);
        if (dataUri.length * 0.75 <= maxBytes) break; // base64 length → approx decoded bytes
        if (mime === 'image/png') size = Math.round(size * 0.8); // lossless — only dimensions can shrink it
        else if (q > 0.5) q -= 0.12; else size = Math.round(size * 0.8);
      }
      resolve(dataUri);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

// ---- logo-vs-background contrast check ------------------------------------------------
// A church logo is shown plain wherever it appears in the chrome (sidebar brand mark,
// dashboard hero badge) — no coloured box behind it — since most logos already read fine
// against the teal/cream chrome they sit on. The only time that's wrong is a logo whose own
// colours are close enough to that background to nearly disappear into it (e.g. an
// all-white logo against a white sidebar in light mode). fitLogoToBackground() checks for
// that once the image has decoded and, only then, adds a small contrasting card behind it —
// light behind a dark background, dark behind a light one, whichever actually shows the
// logo up — via one of two CSS classes the caller's stylesheet defines. Results are cached
// by data URI so re-renders (route changes, re-syncs) don't re-decode the same logo.
const _logoLumCache = new Map();
function logoLuminance(dataUri) {
  if (_logoLumCache.has(dataUri)) return Promise.resolve(_logoLumCache.get(dataUri));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let result = null;
      try {
        const canvas = document.createElement('canvas');
        const w = (canvas.width = 48), h = (canvas.height = 48);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let sum = 0, weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3] / 255;
          if (a < 0.15) continue; // ignore near-transparent pixels — they show the page/hero through, not the logo
          sum += ((0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255) * a;
          weight += a;
        }
        if (weight > 0) result = sum / weight;
      } catch { /* canvas can throw on a cross-origin or corrupt image — just skip the contrast check */ }
      _logoLumCache.set(dataUri, result);
      resolve(result);
    };
    img.onerror = () => { _logoLumCache.set(dataUri, null); resolve(null); };
    img.src = dataUri;
  });
}
// bgColor is a plain '#rrggbb' — usually read straight off a CSS custom property
// (getComputedStyle(...).getPropertyValue('--panel')) so this follows light/dark mode and
// any future palette change automatically, rather than a luminance guess baked in here.
function hexLuminance(hexColor) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hexColor || '').trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
// `el` is the element the logo <img> already lives in (e.g. .brand-mark, .dash-hero-badge).
// Async: resolves after el is already in the DOM, so this just toggles a class on it — no
// rerender needed, and nothing shows until the (cheap, cached) check has an answer.
export function fitLogoToBackground(el, dataUri, bgColor) {
  if (!dataUri || !el) return;
  const bgLum = hexLuminance(bgColor);
  logoLuminance(dataUri).then((logoLum) => {
    if (logoLum == null) return; // couldn't read it — leave the logo plain rather than guess
    const clashes = Math.abs(logoLum - bgLum) < 0.28;
    el.classList.toggle('logo-boxed-light', clashes && bgLum < 0.5);
    el.classList.toggle('logo-boxed-dark', clashes && bgLum >= 0.5);
  });
}

// A branded masthead for anything printed via window.print() — Members' directory export and
// one member's own "Print card", Reports' giving statements, Finance's receipts and reports,
// and Attendance/Programmes exports all show this at the top of the page so every PDF a church
// hands out carries its own logo and location, not a generic printout, and names who generated
// it. Screen-hidden (see .pdf-header in style.css); only @media print shows it, styled in the
// church's own teal/gold palette rather than plain black-and-white. Falls back to a generic
// church icon when no logo has been uploaded yet (Settings → Church). `subLabel` is the small
// caption under the church name (e.g. "Member Directory", "Giving statement 2026"); `meta` is an
// optional node on the right for print-run details like a row count; `generatedBy` (the logged-
// in user's own name — no separate prompt, so exporting stays a single click) prints under it.
export function pdfHeader(churchName, cs, subLabel, meta, generatedBy) {
  const location = [cs?.location, cs?.district, cs?.region].filter(Boolean).join(', ');
  return h('div', { class: 'pdf-header' },
    h('div', { class: 'pdf-header-brand' }, cs?.logo ? h('img', { src: cs.logo, alt: '' }) : icon('church', { size: 28 }),
      h('div', {}, h('div', { class: 'pdf-header-name' }, churchName || 'Church'),
        location && h('div', { class: 'pdf-header-location' }, location),
        h('div', { class: 'pdf-header-sub' }, subLabel))),
    h('div', { class: 'pdf-header-right' }, meta,
      generatedBy && h('div', { class: 'pdf-header-generated' }, `Generated by ${generatedBy} · ${fmtDate(today())}`)));
}

// A small round avatar: the photo if there is one, otherwise the person's initials —
// same "photo or initials" fallback used for members and the account badge in the top bar.
export function avatar(name, photo, size = 34) {
  return photo
    ? h('img', { src: photo, class: 'avatar-img', style: `width:${size}px;height:${size}px`, alt: '' })
    : h('span', { class: 'avatar', style: `width:${size}px;height:${size}px;line-height:${size}px;font-size:${Math.round(size * 0.36)}px` }, initials(name));
}

// A "pick a photo" control: a preview (photo or fallback icon) plus a file input and a
// Remove button once a photo is set. onChange(dataUri | null) fires with the compressed
// image, or null when Remove is clicked. `round` gives a circular preview (member photo);
// square (default) suits a church logo. `compress` is passed straight through to
// compressImage — a wider destination (e.g. a dashboard background photo, versus a small
// square logo/avatar) wants a larger maxSize so it doesn't come out soft when stretched.
// `fit: 'contain'` shows the whole picture letterboxed instead of cropping it to fill the
// box — right for a logo (which may not be square, and shouldn't lose its edges), wrong for
// a person's photo or a background image (those are meant to fill the frame).
export function photoPicker(current, onChange, { round = false, label = 'Photo', compress, fit = 'cover' } = {}) {
  let photo = current || null;
  const preview = h('div', { class: `photo-preview ${round ? 'round' : ''} ${fit === 'contain' ? 'fit-contain' : ''}` });
  const removeBtn = h('button', { type: 'button', class: 'btn ghost sm', style: 'display:none' }, 'Remove');
  const draw = () => {
    preview.replaceChildren(photo ? h('img', { src: photo, alt: '' }) : icon('members', { size: 22 }));
    removeBtn.style.display = photo ? '' : 'none';
  };
  const input = h('input', { type: 'file', accept: 'image/*', onchange: async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try { photo = await compressImage(file, compress); draw(); onChange(photo); } catch (ex) { toast(ex.message, 'err'); }
  } });
  removeBtn.addEventListener('click', () => { photo = null; draw(); onChange(null); });
  draw();
  return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'photo-pick' }, preview, h('div', {}, input, removeBtn)));
}

// ---- programme calendar (annual, some entries recurring) ----
// Given a programme's stored anchor date and whether it repeats every year, find when it
// next falls: this year's date if that hasn't passed yet, otherwise next year's. A
// non-recurring programme's "next occurrence" is just its own date (which may be in the
// past, once — the programmes screen sorts those into a separate "past" list).
export function nextOccurrence(dateStr, recurring) {
  const base = new Date(dateStr + 'T00:00:00');
  if (!recurring) return base;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  let occ = new Date(now.getFullYear(), base.getMonth(), base.getDate());
  if (occ < now) occ = new Date(now.getFullYear() + 1, base.getMonth(), base.getDate());
  return occ;
}
// Whole days from today (midnight-to-midnight) to a given Date — negative once it's past.
export const daysUntil = (date) => { const now = new Date(); now.setHours(0, 0, 0, 0); return Math.round((date - now) / 86400000); };
// A Date back to the plain 'YYYY-MM-DD' fmtDate()/<input type=date> expect — built from
// local getFullYear/Month/Date rather than toISOString(), which converts to UTC and can
// shift the date by a day depending on the browser's time zone.
export const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function countdownLabel(days) {
  if (days < 0) return 'Past';
  if (days === 0) return 'Today!';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

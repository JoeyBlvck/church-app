// Public QR self-check-in page (app/checkin.html) — reached by scanning the QR code a church
// displays at the door, not by signing in. The second unauthenticated, member-facing surface in
// the app (the first is app/give.html) — same reasoning: a member checking themselves in for a
// service is not staff, so this never touches the local-first store/repo (sync.js) or a signed-in
// session, and talks to the server's own /checkin/* routes directly (see server/src/app.js).
import { h, field, val } from './ui.js';
import { icon } from './icons.js';
import { API_URL } from './config.js';

const root = document.getElementById('app');

async function api(method, path, body) {
  const res = await fetch(API_URL + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

const shell = (...kids) => h('div', { class: 'login-page' }, h('div', { class: 'card login-card give-card' }, ...kids));
const brand = () => h('div', { class: 'brand-row' }, h('span', { class: 'brand-mark icon' }, icon('church', { size: 22 })),
  h('div', { class: 'wordmark' }, 'Church ', h('span', {}, 'Manager')));

function renderError(message) {
  root.replaceChildren(shell(brand(), h('h1', {}, "Check-in link not found"), h('p', { class: 'subtitle' }, message)));
}

function renderLoading() {
  root.replaceChildren(shell(brand(), h('p', { class: 'subtitle' }, 'Loading…')));
}

function renderSuccess(churchName, tenantId, name, alreadyCheckedIn) {
  const checkinLink = `${location.origin}${location.pathname}?t=${tenantId}`;
  root.replaceChildren(shell(brand(),
    h('div', { class: 'give-check' }, icon('attendance', { size: 40 })),
    h('h1', {}, alreadyCheckedIn ? `You're already checked in, ${name.split(' ')[0]}!` : `You're checked in, ${name.split(' ')[0]}!`),
    h('p', { class: 'subtitle' }, alreadyCheckedIn ? `See you there — you were already marked present at ${churchName}.` : `Welcome to ${churchName} today — you've been marked present.`),
    h('p', {}, h('a', { class: 'btn ghost', href: checkinLink }, 'Done'))));
}

async function renderForm(tenantId) {
  renderLoading();
  let info;
  try { info = await api('GET', `/checkin/info?t=${encodeURIComponent(tenantId)}`); }
  catch (e) { return renderError(e.message); }

  const err = h('div', { class: 'err', role: 'alert' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const result = await api('POST', '/checkin', { tenantId, phone: val(f, 'phone') });
      renderSuccess(info.churchName, tenantId, result.name, result.alreadyCheckedIn);
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  } },
    field('Your phone number', h('input', { name: 'phone', type: 'tel', inputmode: 'tel', placeholder: '024 000 0000', required: true, autofocus: true })),
    err,
    h('p', {}, h('button', { class: 'btn block', type: 'submit' }, icon('attendance', { size: 16 }), ' Check in')));

  root.replaceChildren(shell(
    info.logo ? h('img', { src: info.logo, alt: '', class: 'give-logo' }) : brand(),
    h('h1', {}, info.churchName), h('p', { class: 'subtitle' }, "Checking in for today's service — enter the phone number on your member record."),
    f,
    h('p', { class: 'give-footer' }, 'Powered by ', h('b', {}, 'Church Manager'))));
}

const params = new URLSearchParams(location.search);
const tenantId = params.get('t');
if (tenantId) renderForm(tenantId);
else renderError('This check-in link is missing some information. Ask your church for the correct QR code.');

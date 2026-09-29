// Public online giving page (app/give.html) — the ONE unauthenticated, member-facing surface in
// the whole app. Deliberately its own small standalone script rather than a route inside main.js:
// it never touches the local-first store/repo (sync.js) or a signed-in session at all — a donor
// is a member of the public, not staff — and it talks to the server's own /give/* routes
// directly (see server/src/app.js). Shares ui.js's plain DOM helpers and style.css's look, so it
// reads as the same product as the rest of the app, without dragging in anything that assumes a
// logged-in user.
import { h, field, val, opts, money, isNetworkError, brandLogo } from './ui.js';
import { icon } from './icons.js';
import { API_URL } from './config.js';

const root = document.getElementById('app');
const PURPOSES = [['tithe', 'Tithe'], ['offering', 'Offering'], ['welfare', 'Welfare'], ['donation', 'Donation']];
const QUICK_AMOUNTS = [20, 50, 100, 200, 500];

async function api(method, path, body) {
  const res = await fetch(API_URL + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

const shell = (...kids) => h('div', { class: 'login-page' }, h('div', { class: 'card login-card give-card' }, ...kids));
const brand = () => h('div', { class: 'brand-row' }, h('span', { class: 'brand-mark' }, brandLogo()),
  h('div', { class: 'wordmark' }, 'The Church', h('span', {}, 'Flow')));

function renderError(message, isNetworkErr) {
  root.replaceChildren(shell(brand(),
    h('h1', {}, isNetworkErr ? "Can't reach the server" : 'Giving link not found'),
    h('p', { class: 'subtitle' }, isNetworkErr ? 'Check your connection and try again.' : message)));
}

function renderLoading() {
  root.replaceChildren(shell(brand(), h('p', { class: 'subtitle' }, 'Loading…')));
}

// ---- the donation form itself: ?t=<tenantId> ----
async function renderForm(tenantId) {
  renderLoading();
  let info;
  try { info = await api('GET', `/give/info?t=${encodeURIComponent(tenantId)}`); }
  catch (e) { return renderError(e.message, isNetworkError(e)); }

  let amount = QUICK_AMOUNTS[1];
  const amountInput = h('input', { name: 'amount', type: 'number', min: '1', step: '0.01', inputmode: 'decimal', required: true, value: amount });
  const quickRow = h('div', { class: 'give-quick' }, QUICK_AMOUNTS.map((n) => h('button', { type: 'button', class: n === amount ? 'btn ghost sm on' : 'btn ghost sm',
    onclick: (e) => { amount = n; amountInput.value = n; quickRow.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, money(n).replace(/\.00$/, ''))));
  amountInput.addEventListener('input', () => quickRow.querySelectorAll('button').forEach((b) => b.classList.remove('on')));

  const ministrySel = info.ministries.length > 0 && h('select', { name: 'ministryId' }, h('option', { value: '' }, 'General / no particular ministry'), opts(info.ministries.map((m) => [m.id, m.name])));
  const fundSel = info.funds.length > 0 && h('select', { name: 'fundId' }, h('option', { value: '' }, 'No particular fund'), opts(info.funds.map((f) => [f.id, f.name])));

  const err = h('div', { class: 'err', role: 'alert' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const donorEmail = val(f, 'donorEmail'), donorPhone = val(f, 'donorPhone');
      if (!donorEmail && !donorPhone) throw new Error('Enter an email or phone number so we can confirm your payment.');
      const callbackUrl = `${location.origin}${location.pathname}`;
      const { authorizationUrl } = await api('POST', '/give/init', {
        tenantId, amount: Number(val(f, 'amount')), purpose: val(f, 'purpose'),
        ministryId: ministrySel ? val(f, 'ministryId') : undefined, fundId: fundSel ? val(f, 'fundId') : undefined,
        donorName: val(f, 'donorName'), donorEmail, donorPhone, callbackUrl,
      });
      location.href = authorizationUrl;
    } catch (ex) { err.textContent = isNetworkError(ex) ? 'Cannot reach the server. Check your connection and try again.' : ex.message; btn.disabled = false; }
  } },
    field('Amount (GHS)', amountInput), quickRow,
    field('Giving towards', h('select', { name: 'purpose' }, opts(PURPOSES))),
    ministrySel && field('Ministry (optional)', ministrySel),
    fundSel && field('Fund (optional)', fundSel),
    field('Your name', h('input', { name: 'donorName', placeholder: 'Optional — leave blank to give anonymously' })),
    h('div', { class: 'row' },
      field('Email', h('input', { name: 'donorEmail', type: 'email', placeholder: 'you@example.com' })),
      field('Phone', h('input', { name: 'donorPhone', type: 'tel', placeholder: '024 000 0000' }))),
    h('p', { class: 'hint' }, "We'll only use this to send you a payment confirmation."),
    err,
    h('p', {}, h('button', { class: 'btn block', type: 'submit' }, icon('gift', { size: 16 }), ' Give securely via Paystack')));

  root.replaceChildren(shell(
    info.logo ? h('img', { src: info.logo, alt: '', class: 'give-logo' }) : brand(),
    h('h1', {}, info.churchName), h('p', { class: 'subtitle' }, 'Give online — MTN MoMo, Telecel Cash, AirtelTigo, or card, via Paystack.'),
    f,
    h('p', { class: 'give-footer' }, 'Powered by ', h('b', {}, 'The ChurchFlow'))));
}

// ---- the post-checkout confirmation screen: ?reference=<ref> (Paystack appends this itself) ----
async function renderStatus(reference, attempt = 0) {
  if (attempt === 0) renderLoading();
  let s;
  try { s = await api('GET', `/give/status?ref=${encodeURIComponent(reference)}`); }
  catch (e) { return renderError(e.message, isNetworkError(e)); }

  if (s.status === 'pending' && attempt < 8) { setTimeout(() => renderStatus(reference, attempt + 1), 2000); return; }

  const givingLink = `${location.origin}${location.pathname}?t=${s.tenantId}`;
  if (s.status === 'paid') {
    root.replaceChildren(shell(brand(), h('div', { class: 'give-check' }, icon('attendance', { size: 40 })),
      h('h1', {}, 'Thank you!'), h('p', { class: 'subtitle' }, `Your gift of ${money(s.amount)} to ${s.churchName} was received.`),
      h('p', {}, h('a', { class: 'btn ghost', href: givingLink }, 'Make another gift'))));
  } else if (s.status === 'failed') {
    root.replaceChildren(shell(brand(), h('h1', {}, 'Payment not completed'), h('p', { class: 'subtitle' }, "That payment didn't go through — no funds were taken. You can try again."),
      h('p', {}, h('a', { class: 'btn', href: givingLink }, 'Try again'))));
  } else {
    root.replaceChildren(shell(brand(), h('h1', {}, 'Still confirming…'), h('p', { class: 'subtitle' }, "This is taking longer than usual. If money left your account, it will still be recorded shortly — check back in a few minutes, or contact the church directly."),
      h('p', {}, h('a', { class: 'btn ghost', href: givingLink }, 'Back to giving page'))));
  }
}

const params = new URLSearchParams(location.search);
const reference = params.get('reference') || params.get('trxref');
const tenantId = params.get('t');
if (reference) renderStatus(reference);
else if (tenantId) renderForm(tenantId);
else renderError('This giving link is missing some information. Ask your church for the correct link, found under Settings > Online giving.');

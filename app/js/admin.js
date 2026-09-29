// Platform admin console — a separate, small, online-only app (own login, own page:
// admin.html) for the SaaS operator only. It is NOT part of the regular church app: no tab in
// its sidebar links here (though its own nav links back to it — see renderConsole), and its
// token/login are entirely separate from any church's own users (server/src/app.js's
// `authAdmin`, server/src/platformAdmin.js). Scoped to each church's basic profile/account info
// (name, plan, logo/motto/location/district/region, SMS sender setup), its non-owner staff
// accounts (create, edit role/ministry, reset password, deactivate — see staffForm below), and
// church-level actions (create a new church, suspend/reactivate, delete the whole church). It
// never reads or writes a church's own members, finance, attendance, or ministry data (beyond
// the {id, name} list needed for the leader-ministry dropdown) — and the owner account itself is
// still untouchable here, created once at church creation and never edited from this console,
// the same line server/src/app.js's own POST /users/update already draws for a church's own
// admins.
import { h, field, val, opts, byName, fmtDate, modal, confirmDialog, toast, photoPicker, isNetworkError } from './ui.js';
import { icon } from './icons.js';
import { API_URL } from './config.js';

const root = document.getElementById('app');
let token = localStorage.getItem('adminToken') || null;

function setToken(t) { token = t; try { if (t) localStorage.setItem('adminToken', t); else localStorage.removeItem('adminToken'); } catch {} }

async function api(method, path, body) {
  const res = await fetch(API_URL + path, {
    method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

async function render() {
  if (!token) return renderLogin();
  let tenants;
  try { tenants = await api('GET', '/admin/tenants'); }
  catch (e) {
    if (e.message === 'unauthorized') { setToken(null); return renderLogin(); }
    root.replaceChildren(h('div', { class: 'login-page' }, h('div', { class: 'card' }, h('p', { class: 'err' }, isNetworkError(e) ? 'Cannot reach the server. Check your connection and try again.' : e.message),
      h('p', { class: 'actions' }, h('button', { class: 'btn', onclick: render }, 'Retry')))));
    return;
  }
  renderConsole(tenants);
}

// Full-bleed navy background + centered white card — same login look as the church app itself
// (app/style.css's .login-page/.login-card), so it's visually obvious this is part of the same
// product even though it's a completely separate login.
function renderLogin() {
  const err = h('div', { class: 'err', role: 'alert' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const r = await api('POST', '/admin/login', { email: val(f, 'email'), password: f.elements.password.value });
      setToken(r.token); render();
    } catch (ex) { err.textContent = isNetworkError(ex) ? 'Cannot reach the server.' : ex.message; btn.disabled = false; }
  } },
    h('label', {}, 'Email'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' }),
    h('label', {}, 'Password'), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' }), err,
    h('p', {}, h('button', { class: 'btn block' }, 'Sign in')));
  root.replaceChildren(h('div', { class: 'login-page' }, h('div', { class: 'card login-card' },
    h('div', { class: 'brand-row' }, h('span', { class: 'brand-mark icon' }, icon('church', { size: 22 })),
      h('div', { class: 'wordmark' }, 'The Church', h('span', {}, 'Flow'))),
    h('h1', {}, 'Platform admin'), h('p', { class: 'subtitle' }, 'Operator console — separate from every church’s own sign-in.'),
    f)));
}

const PLANS = ['trial', 'active', 'suspended'];
const GHANA_REGIONS = ['Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East',
  'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North'];

// Creates a brand-new church + owner account (POST /admin/tenants/create). Deliberately asks for
// nothing more than the owner's name and email — no password field here at all: the server sets
// one at random and emails the owner a one-time "choose your password" link instead (see
// showSetupLink below), so this console is never the thing generating or displaying a real
// password on someone else's behalf.
function addChurchForm(refresh) {
  const err = h('div', { class: 'err' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/admin/tenants/create', {
        churchName: val(f, 'churchName'), ownerName: val(f, 'ownerName'), ownerEmail: val(f, 'ownerEmail'),
      });
      dlg.close(); refresh(); showSetupLink(r);
    } catch (ex) { err.textContent = ex.message; }
  } },
    field('Church name', h('input', { name: 'churchName', required: true })),
    field('Owner name', h('input', { name: 'ownerName', required: true })),
    field('Owner email', h('input', { name: 'ownerEmail', type: 'email', required: true })), err,
    h('p', { class: 'hint' }, "The owner gets an email to set their own password — you never see or choose it."),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Create church')));
  const dlg = modal('Add a church', f);
}

// Shown right after a church is created — confirms the setup email went out, and always includes
// the raw link too (not just when the email fails) so there's a manual fallback if it bounces,
// lands in spam, or BREVO_API_KEY/EMAIL_FROM isn't set on the server at all.
function showSetupLink(r) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.setupUrl); toast('Link copied'); }
    catch { toast('Could not copy — select and copy it manually', 'err'); }
  };
  modal('Church created', h('div', {},
    r.emailSent
      ? h('p', {}, 'A setup email was sent to ', h('b', {}, r.ownerEmail), '.')
      : h('p', { class: 'err' }, `Couldn't send the setup email to ${r.ownerEmail} — share this link with them yourself:`),
    r.setupUrl
      ? h('div', { class: 'row' }, h('input', { readonly: true, value: r.setupUrl, onclick: (e) => e.target.select() }),
          h('button', { type: 'button', class: 'btn ghost', onclick: copy }, 'Copy link'))
      : h('p', { class: 'hint' }, 'No setup link could be generated — check the server has APP_URL set.')));
}

// A destructive action, gated behind typing the church's own name back — a plain yes/no confirm
// is too easy to click through for something this permanent (every member/finance/attendance/
// staff record, gone for good).
function confirmDeleteChurch(t, onConfirmed) {
  const err = h('div', { class: 'err' });
  const f = h('form', { onsubmit: (e) => {
    e.preventDefault();
    if (val(f, 'confirmName').trim() !== t.name) { err.textContent = 'That doesn’t match the church name — nothing was deleted.'; return; }
    m.close(); onConfirmed();
  } },
    h('p', {}, 'This permanently deletes ', h('b', {}, t.name), ' — every member, finance, attendance and staff record. This cannot be undone.'),
    field(`Type "${t.name}" to confirm`, h('input', { name: 'confirmName', autocomplete: 'off' })), err,
    h('p', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn danger' }, 'Delete permanently')));
  const m = modal('Delete church', f);
}

function editTenant(t, refresh) {
  let logo = t.logo ?? null;

  // Quick suspend/reactivate — the one-click version of the Plan field below, for "cut this
  // church off right now". Enforced server-side (auth.js/app.js), not just a label here: a
  // suspended church's own users are refused at login and at every synced call.
  const statusCard = h('div', { class: 'card' }, h('b', {}, 'Status'),
    h('p', {}, h('span', { class: `pill ${t.plan === 'suspended' ? 'bad' : t.plan === 'active' ? 'good' : 'warn'}` }, t.plan)),
    h('p', { class: 'hint' }, t.plan === 'suspended'
      ? 'Every account at this church is blocked from signing in or syncing.'
      : 'Suspending blocks every account at this church from signing in or syncing, without deleting anything.'),
    h('p', { class: 'actions' }, t.plan === 'suspended'
      ? h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/admin/tenants/set-plan', { id: t.id, plan: 'active' }); toast('Reactivated'); dlg.close(); refresh(); } catch (ex) { toast(ex.message, 'err'); } } }, 'Reactivate')
      : h('button', { class: 'btn del', onclick: async () => { try { await api('POST', '/admin/tenants/set-plan', { id: t.id, plan: 'suspended' }); toast('Suspended'); dlg.close(); refresh(); } catch (ex) { toast(ex.message, 'err'); } } }, 'Suspend access')));

  const profileForm = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/admin/tenants/update', { id: t.id, name: val(profileForm, 'name'), plan: val(profileForm, 'plan') });
      await api('POST', '/admin/tenants/church-profile', { id: t.id, motto: val(profileForm, 'motto'), location: val(profileForm, 'location'),
        district: val(profileForm, 'district'), region: val(profileForm, 'region'), logo: logo ?? '' });
      toast('Church updated'); dlg.close(); refresh();
    } catch (ex) { toast(ex.message, 'err'); }
  } },
    photoPicker(logo, (p) => { logo = p; }, { label: 'Church logo', fit: 'contain' }),
    h('div', { class: 'row' },
      field('Church name', h('input', { name: 'name', required: true, value: t.name })),
      field('Plan', h('select', { name: 'plan' }, opts(PLANS, t.plan))),
      field('Motto', h('input', { name: 'motto', value: t.motto ?? '', maxlength: 120 })),
      field('Location', h('input', { name: 'location', value: t.location ?? '' })),
      field('District', h('input', { name: 'district', value: t.district ?? '' })),
      field('Region', h('select', { name: 'region' }, h('option', { value: '' }, '— select —'), opts(GHANA_REGIONS, t.region ?? '')))),
    h('p', { class: 'hint' }, `Members: ${t.members} · Active staff: ${t.staff} · Created ${fmtDate(new Date(t.createdAt).toISOString().slice(0, 10))} — this console only edits the church's own profile/account info, never its members, finance, or attendance.`),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save church')));

  const smsForm = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/admin/tenants/sms-config', { id: t.id, apiKey: val(smsForm, 'apiKey'), senderId: val(smsForm, 'senderId') });
      toast(r.configured ? 'SMS sender saved' : 'SMS sender removed'); dlg.close(); refresh();
    } catch (ex) { toast(ex.message, 'err'); }
  } },
    h('p', { class: 'hint' }, t.smsConfigured
      ? `Configured — sender ID "${t.smsSenderId}". To change either field, re-enter the Arkesel API key (it's never sent back here).`
      : 'Set this church up to send SMS notices via Arkesel.'),
    h('div', { class: 'row' },
      field('Arkesel API key', h('input', { name: 'apiKey', type: 'password', autocomplete: 'off', placeholder: t.smsConfigured ? 'Leave blank to keep the current key' : 'Paste the Arkesel API key' })),
      field('Sender ID', h('input', { name: 'senderId', value: t.smsSenderId ?? '', maxlength: 11 }))),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save SMS settings'),
      t.smsConfigured && h('button', { type: 'button', class: 'btn del', onclick: async () => {
        try { await api('POST', '/admin/tenants/sms-config', { id: t.id, apiKey: '', senderId: '' }); toast('SMS sender removed'); dlg.close(); refresh(); }
        catch (ex) { toast(ex.message, 'err'); }
      } }, 'Remove')));

  // Add/edit non-owner staff from this console — same rules server-side as that church's own
  // Settings > Staff page (POST /admin/tenants/staff/create + .../staff/update), just reachable
  // by the platform operator too. The owner row stays non-clickable, same as it is in the
  // church's own staff list (app/js/views/people.js's staffView) — fixing an owner's own login
  // is a password-reset-email matter, never something edited here.
  const staffCard = h('div', { class: 'card' }, h('b', {}, 'Staff & leaders'), h('p', { class: 'hint' }, 'Loading…'));
  Promise.all([api('GET', `/admin/tenants/staff?id=${t.id}`), api('GET', `/admin/tenants/ministries?id=${t.id}`)]).then(([r, mins]) => {
    const mName = Object.fromEntries(mins.map((m) => [m.id, m.name]));
    const ROLE_HELP = { admin: 'Everything except the owner account', secretary: 'Members, attendance, announcements', treasurer: 'Finance and pledges', leader: 'Only their own ministry' };

    const staffForm = (u = {}) => {
      const roleSel = h('select', { name: 'role', onchange: () => (minBox.hidden = roleSel.value !== 'leader') }, opts(Object.keys(ROLE_HELP), u.role ?? 'leader'));
      const minSel = h('select', { name: 'ministry' }, opts(mins.slice().sort(byName).map((m) => [m.id, m.name]), u.ministryIds?.[0]));
      const minBox = field('Ministry they lead', minSel);
      minBox.hidden = (u.role ?? 'leader') !== 'leader';
      const sf = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try {
          const role = val(sf, 'role'), ministryIds = role === 'leader' ? [val(sf, 'ministry')].filter(Boolean) : [];
          if (role === 'leader' && !ministryIds.length) return toast('This church needs a ministry first — add one before assigning a leader.', 'err');
          if (u.id) await api('POST', '/admin/tenants/staff/update', { tenantId: t.id, id: u.id, role, ministryIds, password: val(sf, 'password') || undefined });
          else await api('POST', '/admin/tenants/staff/create', { tenantId: t.id, name: val(sf, 'name'), email: val(sf, 'email'), password: val(sf, 'password'), role, ministryIds });
          sDlg.close(); toast('Saved'); dlg.close(); refresh();
        } catch (ex) { toast(ex.message, 'err'); }
      } },
        h('div', { class: 'row' }, !u.id && field('Name', h('input', { name: 'name', required: true })), !u.id && field('Email (login)', h('input', { name: 'email', type: 'email', required: true })),
          field(u.id ? 'New password (leave blank to keep)' : 'Temporary password', h('input', { name: 'password', minlength: 8, required: !u.id, autocomplete: 'new-password' }), '8+ characters'),
          field('Role', roleSel, 'Admin sees everything at this church; leaders see only their ministry.'), minBox),
        h('p', { class: 'actions' }, h('button', { class: 'btn' }, u.id ? 'Save' : 'Create account'),
          u.id && h('button', { type: 'button', class: 'btn del', onclick: async () => {
            if (await confirmDialog(`Deactivate ${u.name}? They are signed out immediately.`, 'Deactivate')) {
              try { await api('POST', '/admin/tenants/staff/update', { tenantId: t.id, id: u.id, active: false }); sDlg.close(); toast('Deactivated'); dlg.close(); refresh(); }
              catch (ex) { toast(ex.message, 'err'); }
            }
          } }, icon('trash', { size: 15 }), 'Deactivate')));
      const sDlg = modal(u.id ? `Edit ${u.name}` : 'New staff account', sf);
    };

    staffCard.replaceChildren(h('b', {}, 'Staff & leaders'),
      h('p', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => staffForm() }, icon('plus', { size: 15 }), 'Add staff')),
      r.staff.length
        ? h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Ministry', 'Status'].map((c) => h('th', {}, c)))),
            h('tbody', {}, r.staff.map((s) => h('tr', { class: s.role === 'owner' ? '' : 'click', onclick: s.role === 'owner' ? null : () => staffForm(s) },
              h('td', {}, s.name), h('td', {}, s.email), h('td', {}, h('span', { class: 'pill' }, s.role)),
              h('td', {}, (s.ministryIds ?? []).map((i) => mName[i]).filter(Boolean).join(', ')),
              h('td', {}, s.active ? h('span', { class: 'pill good' }, 'Active') : h('span', { class: 'pill bad' }, 'Deactivated'))))))
        : h('p', { class: 'hint' }, 'No staff accounts yet.'));
  }).catch((ex) => staffCard.replaceChildren(h('b', {}, 'Staff & leaders'), h('p', { class: 'err' }, ex.message)));

  const dangerCard = h('div', { class: 'card' }, h('b', {}, 'Danger zone'),
    h('p', { class: 'hint' }, 'Permanently delete this church and everything in it — members, finance, attendance, ministries and every staff login.'),
    h('p', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger', onclick: () => confirmDeleteChurch(t, async () => {
      try { await api('POST', '/admin/tenants/delete', { id: t.id }); toast(`${t.name} deleted`); dlg.close(); refresh(); }
      catch (ex) { toast(ex.message, 'err'); }
    }) }, icon('trash', { size: 15 }), 'Delete church')));

  const dlg = modal(t.name, h('div', {}, statusCard, h('div', { class: 'card' }, h('b', {}, 'Church profile'), profileForm),
    h('div', { class: 'card' }, h('b', {}, 'SMS (Arkesel)'), smsForm), staffCard, dangerCard), { wide: true });
}

function renderConsole(tenants) {
  const refresh = () => api('GET', '/admin/tenants').then(renderConsole).catch((e) => toast(e.message, 'err'));
  const q = h('input', { type: 'search', placeholder: 'Search churches…' });
  const body = h('tbody');
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = tenants.filter((t) => !term || t.name.toLowerCase().includes(term)).sort(byName);
    body.replaceChildren(...rows.map((t) => h('tr', { class: 'click', onclick: () => editTenant(t, refresh) },
      h('td', {}, h('b', {}, t.name), t.location ? h('div', { class: 'hint' }, t.location) : null),
      h('td', {}, h('span', { class: `pill ${t.plan === 'suspended' ? 'bad' : t.plan === 'active' ? '' : 'warn'}` }, t.plan)),
      h('td', {}, t.members), h('td', {}, t.staff),
      h('td', {}, t.smsConfigured ? h('span', { class: 'pill' }, 'SMS on') : h('span', { class: 'hint' }, '—')),
      h('td', {}, fmtDate(new Date(t.createdAt).toISOString().slice(0, 10))))));
    if (!rows.length) body.append(h('tr', {}, h('td', { colspan: 6 }, h('p', { class: 'hint' }, 'No churches match.'))));
  };
  q.oninput = draw; draw();

  root.replaceChildren(h('div', { class: 'shell' },
    h('nav', {}, h('div', { class: 'brand' }, h('span', { class: 'brand-mark icon' }, icon('church', { size: 22 })),
        h('h1', {}, 'The Church', h('span', {}, 'Flow'), h('small', {}, 'Platform admin'))),
      h('div', { class: 'navlinks' }, h('div', { class: 'nav-title' }, 'Console'), h('button', { class: 'on' }, h('span', { class: 'ico' }, icon('church')), h('span', {}, 'Churches'))),
      // Back to the regular church app — a separate page (its own login, own token), not another
      // tab in this console, so a plain navigation is all this needs. Grouped with Sign out below
      // the same divider (.signout's own border/margin), rather than repeating it on both.
      h('div', { class: 'signout', style: 'display:flex;flex-direction:column;gap:2px' },
        h('button', { onclick: () => { location.href = '/'; } }, h('span', { class: 'ico' }, icon('church')), h('span', {}, 'Open church app')),
        h('button', { onclick: () => { setToken(null); render(); } }, h('span', { class: 'ico' }, icon('signout')), h('span', {}, 'Sign out')))),
    h('main', {},
      h('div', { class: 'bar top' }, h('div', { class: 'status', role: 'status' }, `${tenants.length} church${tenants.length === 1 ? '' : 'es'} on the platform`), q),
      h('div', { class: 'bar' }, h('h2', {}, 'Churches'), h('button', { class: 'btn', onclick: () => addChurchForm(refresh) }, icon('plus', { size: 15 }), 'Add church')),
      h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Church', 'Plan', 'Members', 'Staff', 'SMS', 'Created'].map((t) => h('th', {}, t)))), body)))));
}

render();

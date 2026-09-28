// Staff accounts + announcements board
import { icon } from '../icons.js';
import { h, field, val, opts, byName, today, fmtDate, modal, confirmDialog, toast, empty, bulkBar } from '../ui.js';

export async function staffView({ repo, ministries, rerender }) {
  let list = [], err = '';
  try { list = await repo.listStaff(); } catch { err = 'Connect to the internet to manage staff accounts.'; }
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const ROLE_HELP = { admin: 'Everything except the owner account', secretary: 'Members, attendance, announcements', treasurer: 'Finance and pledges', leader: 'Only their own ministry' };

  const form = (u = {}) => {
    const roleSel = h('select', { name: 'role', onchange: () => (minBox.hidden = roleSel.value !== 'leader') }, opts(Object.keys(ROLE_HELP), u.role ?? 'leader'));
    const minSel = h('select', { name: 'ministry' }, opts(ministries.slice().sort(byName).map((m) => [m.id, m.name]), u.ministry_ids?.[0]));
    const minBox = field('Ministry they lead', minSel);
    minBox.hidden = (u.role ?? 'leader') !== 'leader';
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try {
        const role = val(f, 'role'), ministryIds = role === 'leader' ? [val(f, 'ministry')].filter(Boolean) : [];
        if (role === 'leader' && !ministryIds.length) return toast('Create a ministry first, then assign the leader.', 'err');
        if (u.id) await repo.updateStaff({ id: u.id, role, ministryIds, password: val(f, 'password') || undefined });
        else await repo.createStaff({ name: val(f, 'name'), email: val(f, 'email'), password: val(f, 'password'), role, ministryIds });
        dlg.close(); toast('Saved'); rerender();
      } catch (ex) { toast(ex.message, 'err'); }
    } },
      h('div', { class: 'row' }, !u.id && field('Name', h('input', { name: 'name', required: true })), !u.id && field('Email (login)', h('input', { name: 'email', type: 'email', required: true })),
        field(u.id ? 'New password (leave blank to keep)' : 'Temporary password', h('input', { name: 'password', minlength: 8, required: !u.id, autocomplete: 'new-password' }), '8+ characters'),
        field('Role', roleSel, 'Admin sees everything; leaders see only their ministry.'), minBox),
      h('p', { class: 'actions' }, h('button', { class: 'btn' }, u.id ? 'Save' : 'Create account'),
        u.id && h('button', { type: 'button', class: 'btn del', onclick: async () => { if (await confirmDialog(`Deactivate ${u.name}? They are signed out immediately.`, 'Deactivate')) { await repo.updateStaff({ id: u.id, active: false }); dlg.close(); rerender(); } } }, icon('trash', { size: 15 }), 'Deactivate')));
    const dlg = modal(u.id ? `Edit ${u.name}` : 'New staff account', f);
  };

  return h('div', {}, h('div', { class: 'bar' }, h('h2', {}, 'Staff & leaders'), !err && h('button', { class: 'btn', onclick: () => form() }, icon('plus', { size: 15 }), 'Add account')),
    err && h('p', { class: 'err' }, err),
    h('div', { class: 'card' }, list.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Login', 'Role', 'Ministry', 'Status'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((u) => h('tr', { class: u.role === 'owner' ? '' : 'click', onclick: u.role === 'owner' ? null : () => form(u) }, h('td', {}, h('b', {}, u.name)), h('td', {}, u.email), h('td', {}, u.role),
        h('td', {}, (u.ministry_ids ?? []).map((i) => mName[i]).filter(Boolean).join(', ')), h('td', {}, u.active ? 'Active' : h('span', { class: 'pill bad' }, 'Deactivated')))))) : empty('No accounts.')),
    h('div', { class: 'card' }, h('b', {}, 'Roles'), h('ul', { class: 'plain' }, Object.entries(ROLE_HELP).map(([k, v]) => h('li', {}, h('b', {}, k), ` — ${v}`)))));
}

export async function announcementsView({ repo, user, ministries, rerender }) {
  const canPost = user.role !== 'treasurer' && user.role !== 'leader'; // matches who the server lets post 'messages' and send SMS
  const [log, smsConfig, whatsappConfig] = await Promise.all([
    repo.list('messages').then((l) => l.sort((a, b) => (b.date + (b.at ?? 0)).localeCompare(a.date + (a.at ?? 0)))),
    canPost ? repo.getSmsConfig().catch(() => ({ configured: false })) : { configured: false },
    canPost ? repo.getWhatsappConfig().catch(() => ({ configured: false })) : { configured: false },
  ]);
  const mName = Object.fromEntries(ministries.map((m) => [m.id, m.name]));
  const sortedMinistries = ministries.slice().sort(byName);
  // A notice can be deleted (individually or in bulk) by an owner/admin, or by whoever posted
  // it — same rule either way, so bulk-selecting never offers to delete a notice you couldn't
  // remove one at a time.
  const canDeleteMsg = (m) => ['owner', 'admin'].includes(user.role) || m.author === user.name;
  const bulkDeleteNotices = async (ids) => {
    if (!(await confirmDialog(`Delete ${ids.length} notice${ids.length === 1 ? '' : 's'}? This can't be undone.`, 'Delete'))) return;
    for (const id of ids) await repo.remove('messages', id);
    toast(`${ids.length} notice${ids.length === 1 ? '' : 's'} deleted`); rerender();
  };
  const sel = bulkBar([{ label: 'Delete', danger: true, run: bulkDeleteNotices }]);
  sel.sync(log.filter(canDeleteMsg).map((m) => m.id));

  // ---- who gets the SMS: independent of the notice's own single "Audience" field below, so a
  // church can post a whole-church notice on the board while texting just one or two ministries
  // about it — or the reverse. "Whole church" and specific ministries are mutually exclusive:
  // checking one clears the other, and whichever is checked at send time wins.
  const smsWhole = h('input', { type: 'checkbox', name: 'smsWhole', checked: true, onchange: (e) => { if (e.target.checked) smsMinBoxes.forEach((b) => (b.checked = false)); } });
  const smsMinBoxes = sortedMinistries.map((mm) => h('input', { type: 'checkbox', name: 'smsMin', value: mm.id, onchange: (e) => { if (e.target.checked) smsWhole.checked = false; } }));
  const smsTargets = h('div', { class: 'sms-targets', hidden: true },
    h('p', { class: 'hint' }, 'Text which members? (can differ from the audience above)'),
    h('label', { class: 'check' }, smsWhole, ' Whole church'),
    sortedMinistries.length > 0 && h('div', {}, sortedMinistries.map((mm, i) => h('label', { class: 'check' }, smsMinBoxes[i], ' ', mm.name))));
  const resetSmsTargets = () => { smsWhole.checked = true; smsMinBoxes.forEach((b) => (b.checked = false)); smsTargets.hidden = true; };

  // ---- who gets the WhatsApp broadcast: same independent-audience pattern as SMS above ----
  const waWhole = h('input', { type: 'checkbox', name: 'waWhole', checked: true, onchange: (e) => { if (e.target.checked) waMinBoxes.forEach((b) => (b.checked = false)); } });
  const waMinBoxes = sortedMinistries.map((mm) => h('input', { type: 'checkbox', name: 'waMin', value: mm.id, onchange: (e) => { if (e.target.checked) waWhole.checked = false; } }));
  const waTargets = h('div', { class: 'sms-targets', hidden: true },
    h('p', { class: 'hint' }, 'Message which members on WhatsApp? (can differ from the audience above)'),
    h('label', { class: 'check' }, waWhole, ' Whole church'),
    sortedMinistries.length > 0 && h('div', {}, sortedMinistries.map((mm, i) => h('label', { class: 'check' }, waMinBoxes[i], ' ', mm.name))));
  const resetWaTargets = () => { waWhole.checked = true; waMinBoxes.forEach((b) => (b.checked = false)); waTargets.hidden = true; };

  const f = canPost && h('form', { onsubmit: async (e) => { e.preventDefault();
    const text = val(f, 'text'), ministryId = val(f, 'ministryId') || undefined, alsoSms = f.elements.sms?.checked, alsoWa = f.elements.wa?.checked;
    let smsTargetIds = [], waTargetIds = [];
    if (alsoSms) {
      smsTargetIds = smsWhole.checked ? [] : smsMinBoxes.filter((b) => b.checked).map((b) => b.value);
      if (!smsWhole.checked && !smsTargetIds.length) return toast('Pick at least one ministry to text, or check "Whole church."', 'err');
    }
    if (alsoWa) {
      waTargetIds = waWhole.checked ? [] : waMinBoxes.filter((b) => b.checked).map((b) => b.value);
      if (!waWhole.checked && !waTargetIds.length) return toast('Pick at least one ministry to message on WhatsApp, or check "Whole church."', 'err');
    }
    await repo.save('messages', { ministryId, text, date: today(), at: Date.now(), author: user.name });
    f.reset(); resetSmsTargets(); resetWaTargets(); toast('Posted'); rerender();
    if (alsoSms) {
      try {
        const r = await repo.sendSms(text, smsTargetIds);
        if (!r.total) toast('No members matched that audience to text.', 'err');
        else if (!r.sent) toast(`None of the ${r.total} members in that audience have a usable phone number on file.`, 'err');
        else toast(`Texted ${r.sent} member${r.sent === 1 ? '' : 's'}${r.missing ? ` (${r.missing} had no usable phone number)` : ''}${r.failed ? ` — ${r.failed} failed to send` : ''}.`, r.failed || r.errors?.length ? 'err' : 'ok');
      } catch (ex) { toast(`Posted, but the SMS couldn't be sent: ${ex.message}`, 'err'); }
    }
    if (alsoWa) {
      try {
        const r = await repo.sendWhatsapp(text, waTargetIds);
        if (!r.total) toast('No members matched that audience to message.', 'err');
        else if (!r.sent) toast(`None of the ${r.total} members in that audience have a usable phone number on file.`, 'err');
        else toast(`Sent to ${r.sent} member${r.sent === 1 ? '' : 's'} on WhatsApp${r.missing ? ` (${r.missing} had no usable phone number)` : ''}${r.failed ? ` — ${r.failed} failed to send` : ''}.`, r.failed || r.errors?.length ? 'err' : 'ok');
      } catch (ex) { toast(`Posted, but the WhatsApp broadcast couldn't be sent: ${ex.message}`, 'err'); }
    }
  } },
    h('div', { class: 'row' }, field('Audience', h('select', { name: 'ministryId' }, h('option', { value: '' }, 'Whole church'), opts(sortedMinistries.map((m) => [m.id, m.name])))),
      field('Announcement', h('textarea', { name: 'text', rows: 3, required: true, placeholder: 'Sunday service starts at 8am. Harvest planning meeting after church…' }))),
    smsConfig.configured
      ? h('div', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'sms', onchange: (e) => { smsTargets.hidden = !e.target.checked; } }), ' Also send as SMS to members’ phones (via Arkesel)'), smsTargets)
      : h('p', { class: 'hint' }, 'Set up an SMS sender under Settings → SMS to also text this to members’ phones.'),
    whatsappConfig.configured
      ? h('div', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'wa', onchange: (e) => { waTargets.hidden = !e.target.checked; } }), ' Also send as a WhatsApp broadcast'), waTargets)
      : h('p', { class: 'hint' }, 'Set up WhatsApp under Settings → WhatsApp to also broadcast this on WhatsApp.'),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Post announcement')));
  return h('div', {}, h('h2', {}, 'Announcements'), h('p', { class: 'hint' }, 'A notice board shared with your team — optionally also sent to members by SMS, to the whole church or just one or more ministries.'), canPost && h('div', { class: 'card' }, f),
    h('div', { class: 'card' }, sel.bar, log.length ? log.map((m) => h('div', { class: 'feed' },
      canDeleteMsg(m) && sel.box(m.id), ' ',
      h('span', { class: 'hint' }, `${fmtDate(m.date)} · ${m.author} → ${mName[m.ministryId] ?? 'Whole church'}`), h('div', {}, m.text),
      h('button', { class: 'btn ghost sm', onclick: async () => { await navigator.clipboard?.writeText(m.text); toast('Copied'); } }, icon('chat', { size: 13 }), 'Copy'),
      canDeleteMsg(m) && h('button', { class: 'btn del sm', onclick: async () => { await repo.remove('messages', m.id); rerender(); } }, icon('trash', { size: 13 })))) : empty('No announcements yet.')));
}

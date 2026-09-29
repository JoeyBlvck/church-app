import { h, field, val, opts, download, today, toast, confirmDialog, fmtDate, photoPicker } from '../ui.js';
import { icon } from '../icons.js';
import { toCSV } from '../csv.js';
import { renderQrToCanvas, qrToSvgString } from '../vendor/qrcode.js';
import { getTheme, setTheme } from '../theme.js';
import { APP_VERSION } from '../config.js';

// The 16 regions of Ghana (2019 boundaries) — a convenience picker, since this app is built
// for Ghanaian churches; District and Location stay free text since there are far too many
// districts/towns to enumerate, and it keeps the app usable outside Ghana too.
const GHANA_REGIONS = ['Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East',
  'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North'];

export async function settingsView({ repo, user, sync, rerender, go }) {
  const canManageChurch = ['owner', 'admin'].includes(user.role);
  // A secretary can't rename the check-in service, but — same as sending a Notice by SMS/WhatsApp —
  // is exactly who'd be asked to pull up and display the QR code at the door, so they can view it.
  const canViewCheckin = canManageChurch || user.role === 'secretary';
  const [last, church, pending, settingsList, smsConfig, paystackConfig, whatsappConfig, checkinConfig] = await Promise.all([repo.lastSync(), repo.churchName(), repo.pending(), repo.list('settings'),
    canManageChurch ? repo.getSmsConfig().catch(() => ({ configured: false, senderId: null })) : Promise.resolve(null),
    canManageChurch ? repo.getPaystackConfig().catch(() => ({ configured: false, publicKey: null, testMode: null })) : Promise.resolve(null),
    canManageChurch ? repo.getWhatsappConfig().catch(() => ({ configured: false })) : Promise.resolve(null),
    canViewCheckin ? repo.getCheckinConfig().catch(() => ({ serviceName: '' })) : Promise.resolve(null)]);
  const cs = settingsList.find((s) => s.id === 'church') ?? {};

  let myPhoto = user.photo ?? null;
  const profile = h('form', { onsubmit: async (e) => { e.preventDefault();
    try { await repo.updateProfile(val(profile, 'name'), val(profile, 'email'), myPhoto); toast('Profile updated'); rerender(); } catch (ex) { toast(ex.message, 'err'); } } },
    photoPicker(myPhoto, (p) => { myPhoto = p; }, { round: true, label: 'Your photo' }),
    h('div', { class: 'row' }, field('Your name', h('input', { name: 'name', required: true, value: user.name, autocomplete: 'name' })),
      field('Your email', h('input', { name: 'email', type: 'email', required: true, value: user.email, autocomplete: 'email' }))),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save profile')));

  const pw = h('form', { onsubmit: async (e) => { e.preventDefault();
    try { await repo.changePassword(val(pw, 'cur'), val(pw, 'next')); pw.reset(); toast('Password changed'); } catch (ex) { toast(ex.message, 'err'); } } },
    h('div', { class: 'row' }, field('Current password', h('input', { name: 'cur', type: 'password', required: true, autocomplete: 'current-password' })), field('New password', h('input', { name: 'next', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }))),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Change password')));

  // Light/dark is a personal, per-device display preference (app/js/theme.js), not something
  // that syncs between a person's own devices or is visible to anyone else — so this just flips
  // it immediately and re-renders, with no form/save step of its own.
  const themeTabs = h('div', { class: 'tabs' },
    h('button', { type: 'button', class: getTheme() === 'light' ? 'on' : '', onclick: () => { setTheme('light'); rerender(); } }, 'Light'),
    h('button', { type: 'button', class: getTheme() === 'dark' ? 'on' : '', onclick: () => { setTheme('dark'); rerender(); } }, 'Dark'));
  // ---- church profile: logo, motto, location, district, region, dashboard background photo ----
  // Everyone can read this (it shows in the sidebar for every role); only owner/admin may
  // change it, so a leader/treasurer/secretary just sees it laid out, not an edit form.
  let logo = cs.logo ?? null;
  // The dashboard hero's background photo: it sits BEHIND the hero's own gradient (see
  // dashboard.js/.dash-hero-photo in style.css), so the gradient's colour always still washes
  // over it — the slider only controls how much of the photo shows through that gradient, not
  // how much of the gradient shows. Capped at 70% (not 100%) so the gradient can never be
  // fully hidden, no matter what the slider is set to.
  let heroImage = cs.heroImage ?? null;
  const heroOpacityOut = h('output', {}, `${cs.heroImageOpacity ?? 35}%`);
  const heroOpacityInput = h('input', { name: 'heroOpacity', type: 'range', min: 0, max: 70, value: cs.heroImageOpacity ?? 35, disabled: !heroImage,
    oninput: (e) => { heroOpacityOut.textContent = `${e.target.value}%`; } });
  const churchForm = h('form', { onsubmit: async (e) => { e.preventDefault();
    try {
      await repo.save('settings', { ...cs, id: 'church', logo: logo ?? undefined, motto: val(churchForm, 'motto'),
        location: val(churchForm, 'location'), district: val(churchForm, 'district'), region: val(churchForm, 'region'),
        heroImage: heroImage ?? undefined, heroImageOpacity: Number(val(churchForm, 'heroOpacity')) });
      toast('Church profile updated'); rerender();
    } catch (ex) { toast(ex.message, 'err'); }
  } },
    photoPicker(logo, (p) => { logo = p; }, { label: 'Church logo', fit: 'contain' }),
    h('div', { class: 'row' },
      field('Motto', h('input', { name: 'motto', value: cs.motto ?? '', placeholder: 'e.g. Faith and Works', maxlength: 120 })),
      field('Location', h('input', { name: 'location', value: cs.location ?? '', placeholder: 'e.g. Adenta' })),
      field('District', h('input', { name: 'district', value: cs.district ?? '', placeholder: 'e.g. Adenta Municipal' })),
      field('Region', h('select', { name: 'region' }, h('option', { value: '' }, '— select —'), opts(GHANA_REGIONS, cs.region ?? '')))),
    photoPicker(heroImage, (p) => { heroImage = p; heroOpacityInput.disabled = !p; }, { label: 'Dashboard background photo (optional)', compress: { maxSize: 960, maxBytes: 600 * 1024 } }),
    field('Background photo strength', h('div', { style: 'display:flex;align-items:center;gap:10px;max-width:320px' }, heroOpacityInput, heroOpacityOut),
      "How much of the photo shows through the dashboard header, behind the gradient — the gradient's colour always stays on top."),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save church profile')));
  const churchCard = canManageChurch
    ? h('div', { class: 'card' }, h('b', {}, 'Church profile'), h('p', { class: 'hint' }, 'Shown in the sidebar and on printed reports.'), churchForm)
    : (cs.logo || cs.motto || cs.location || cs.district || cs.region) && h('div', { class: 'card' }, h('b', {}, 'Church profile'),
        h('div', { class: 'kv' }, [['Motto', cs.motto], ['Location', cs.location], ['District', cs.district], ['Region', cs.region]]
          .filter(([, v]) => v).map(([k, v]) => h('div', {}, h('span', { class: 'hint' }, k), h('div', {}, v)))));

  // ---- SMS (Arkesel): owner/admin only. The API key is never sent back to the client once
  // saved (server/src/app.js's GET /sms/config only ever returns whether it's configured and
  // the sender ID), so changing the sender ID later means re-entering the API key too.
  const smsForm = canManageChurch && h('form', { onsubmit: async (e) => { e.preventDefault();
    try {
      const r = await repo.saveSmsConfig(val(smsForm, 'apiKey'), val(smsForm, 'senderId'));
      toast(r.configured ? 'SMS sender saved' : 'SMS sender removed'); rerender();
    } catch (ex) { toast(ex.message, 'err'); }
  } },
    h('p', { class: 'hint' }, smsConfig?.configured
      ? `Configured — sender ID "${smsConfig.senderId}". To change either field, re-enter your Arkesel API key (it's never shown back here for security).`
      : 'Get an API key from your Arkesel dashboard (sms.arkesel.com) and a registered sender ID, then enter them here to let Notices text members.'),
    h('div', { class: 'row' },
      field('Arkesel API key', h('input', { name: 'apiKey', type: 'password', autocomplete: 'off', placeholder: smsConfig?.configured ? 'Leave blank to keep the current key' : 'Paste your Arkesel API key' })),
      field('Sender ID', h('input', { name: 'senderId', value: smsConfig?.senderId ?? '', maxlength: 11, placeholder: 'e.g. GraceChapel' }), '3–11 letters/numbers, as registered with Arkesel.')),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save SMS settings'),
      smsConfig?.configured && h('button', { type: 'button', class: 'btn del', onclick: async () => {
        if (await confirmDialog('Remove the SMS sender configuration? Notices will no longer be able to text members.', 'Remove')) { try { await repo.saveSmsConfig('', ''); toast('SMS sender removed'); rerender(); } catch (ex) { toast(ex.message, 'err'); } }
      } }, 'Remove')));

  // ---- Paystack (online giving): owner/admin only. Each church connects its OWN Paystack
  // account, so a gift lands straight in that church's own balance — this app never touches the
  // money. The secret key is never sent back once saved, same as the Arkesel API key above.
  const givingLink = `${location.origin}/give.html?t=${user.tenantId}`;
  const paystackForm = canManageChurch && h('form', { onsubmit: async (e) => { e.preventDefault();
    try {
      const r = await repo.savePaystackConfig(val(paystackForm, 'secretKey'), val(paystackForm, 'publicKey'));
      toast(r.configured ? 'Online giving connected' : 'Online giving disconnected'); rerender();
    } catch (ex) { toast(ex.message, 'err'); }
  } },
    h('p', { class: 'hint' }, paystackConfig?.configured
      ? `Connected${paystackConfig.testMode ? ' — test mode keys (switch to live keys when you\'re ready to accept real payments)' : ' — live'}. To change either field, re-enter your Paystack secret key (it's never shown back here for security).`
      : "Create a free account at paystack.com, then copy your API keys from Settings > API Keys & Webhooks (use the test keys first) and paste them here to let members give online by mobile money or card."),
    h('div', { class: 'row' },
      field('Paystack secret key', h('input', { name: 'secretKey', type: 'password', autocomplete: 'off', placeholder: paystackConfig?.configured ? 'Leave blank to keep the current key' : 'sk_test_… or sk_live_…' })),
      field('Paystack public key', h('input', { name: 'publicKey', value: paystackConfig?.configured ? paystackConfig.publicKey : '', placeholder: 'pk_test_… or pk_live_…' }))),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save giving settings'),
      paystackConfig?.configured && h('button', { type: 'button', class: 'btn del', onclick: async () => {
        if (await confirmDialog('Disconnect Paystack? Your giving link will stop accepting payments until you reconnect it.', 'Disconnect')) { try { await repo.savePaystackConfig('', ''); toast('Online giving disconnected'); rerender(); } catch (ex) { toast(ex.message, 'err'); } }
      } }, 'Disconnect')),
    paystackConfig?.configured && h('div', {}, h('p', { class: 'hint' }, 'Share this link with your members so they can give online — post it in Notices, WhatsApp, or your church bulletin:'),
      h('div', { class: 'row' }, h('input', { readonly: true, value: givingLink, onclick: (e) => e.target.select() }),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: async () => { await navigator.clipboard?.writeText(givingLink); toast('Link copied'); } }, icon('download', { size: 13 }), 'Copy link'))));

  // ---- WhatsApp (broadcast + check-in-by-reply): owner/admin only. Each church connects its OWN
  // WhatsApp Business API access — from Meta directly, or through a BSP such as Arkesel — the
  // same "bring your own account" pattern as SMS/Paystack above. The access token is never sent
  // back once saved. A member who replies "IN" to the church's WhatsApp number is automatically
  // marked present on today's attendance (server/src/app.js's POST /whatsapp/webhook) — nothing
  // to set up for that beyond connecting the account below.
  const whatsappForm = canManageChurch && h('form', { onsubmit: async (e) => { e.preventDefault();
    try {
      const r = await repo.saveWhatsappConfig({
        phoneNumberId: val(whatsappForm, 'phoneNumberId'), accessToken: val(whatsappForm, 'accessToken'),
        baseUrl: val(whatsappForm, 'baseUrl'), templateName: val(whatsappForm, 'templateName'),
        templateLang: val(whatsappForm, 'templateLang'), checkinService: val(whatsappForm, 'checkinService'),
      });
      toast(r.configured ? 'WhatsApp connected' : 'WhatsApp disconnected'); rerender();
    } catch (ex) { toast(ex.message, 'err'); }
  } },
    h('p', { class: 'hint' }, whatsappConfig?.configured
      ? "Connected. To change the phone number or reconnect, re-enter your access token (it's never shown back here for security)."
      : 'Set up a WhatsApp Business API connection — from Meta directly (developers.facebook.com, after Business Verification) or through a provider like Arkesel — then paste the phone number ID and access token here.'),
    h('div', { class: 'row' },
      field('WhatsApp phone number ID', h('input', { name: 'phoneNumberId', value: whatsappConfig?.configured ? whatsappConfig.phoneNumberId : '', placeholder: 'e.g. 109876543210987' })),
      field('Access token', h('input', { name: 'accessToken', type: 'password', autocomplete: 'off', placeholder: whatsappConfig?.configured ? 'Leave blank to keep the current token' : 'Paste your access token' }))),
    h('div', { class: 'row' },
      field('Notice template name', h('input', { name: 'templateName', value: whatsappConfig?.templateName ?? '', placeholder: 'e.g. church_notice' }), 'The one Meta-approved template (with a single {{1}} body variable) a broadcast notice is sent through.'),
      field('Template language code', h('input', { name: 'templateLang', value: whatsappConfig?.templateLang ?? 'en_US', placeholder: 'en_US' })),
      field('Default check-in service name', h('input', { name: 'checkinService', value: whatsappConfig?.checkinService ?? '', placeholder: 'Sunday service' }), 'Used when a member texts "IN" and no attendance record exists yet for today.')),
    h('details', {}, h('summary', {}, 'Advanced: custom API base URL'),
      field('Base URL', h('input', { name: 'baseUrl', value: whatsappConfig?.baseUrl ?? '', placeholder: 'Default: https://graph.facebook.com/v20.0' }), "Only change this if your provider (e.g. a BSP other than Meta directly) gave you a different address to send through.")),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save WhatsApp settings'),
      whatsappConfig?.configured && h('button', { type: 'button', class: 'btn del', onclick: async () => {
        if (await confirmDialog('Disconnect WhatsApp? Broadcasts and check-in-by-reply will stop working until you reconnect it.', 'Disconnect')) { try { await repo.saveWhatsappConfig({}); toast('WhatsApp disconnected'); rerender(); } catch (ex) { toast(ex.message, 'err'); } }
      } }, 'Disconnect')),
    whatsappConfig?.configured && h('p', { class: 'hint' }, 'Members can also text "IN" to your WhatsApp number to check themselves into today\'s attendance — no setup needed beyond this.'));

  // ---- QR self-check-in: nothing to "connect" — no third-party account is involved at all, the
  // QR code just encodes a link to this church's own public check-in page (app/checkin.html) with
  // this church's tenantId baked in. Display it on a screen or print it at the entrance; a member
  // scans it with their own phone's camera (no app to install), enters their phone number, and is
  // marked present on today's whole-church attendance the same way a WhatsApp "IN" reply is.
  const checkinLink = `${location.origin}/checkin.html?t=${user.tenantId}`;
  const qrCanvas = canViewCheckin && h('canvas', { class: 'checkin-qr', 'aria-label': 'Check-in QR code' });
  const checkinForm = canManageChurch && h('form', { onsubmit: async (e) => { e.preventDefault();
    try { await repo.saveCheckinConfig(val(checkinForm, 'serviceName')); toast('Check-in settings saved'); rerender(); } catch (ex) { toast(ex.message, 'err'); }
  } },
    field('Default check-in service name', h('input', { name: 'serviceName', value: checkinConfig?.serviceName ?? '', placeholder: 'Sunday service' }),
      "Used when a member scans the code and no attendance record exists yet for today — falls back to your WhatsApp check-in service name, then \"Sunday service\", if left blank."),
    h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Save')));
  if (qrCanvas) renderQrToCanvas(qrCanvas, checkinLink, { moduleSize: 6 });

  // ---- Help & Support: everyone can see this (no role check) -- an about blurb, a short FAQ
  // (native <details>/<summary>, the same disclosure pattern already used above for WhatsApp's
  // "Advanced" field and elsewhere in the app), and two direct contact buttons. Placed right
  // before the Danger zone so it's the last "normal" card on the page, not mixed in among the
  // admin-only integration cards above it.
  const helpFaqs = [
    ["Does it work without an internet connection?", "Yes \u2014 every screen works fully offline on each device. Anything you enter is saved immediately on that device and syncs automatically the next time it's back online."],
    ["Is my church's data safe?", "Each church's data is kept completely separate, and only your own staff accounts can sign in to it. Giving and finance records are append-only, so a posted entry can never be silently edited or deleted \u2014 corrections are always recorded as new, linked entries."],
    ["How do updates work?", "The desktop app checks for updates automatically while it's open and connected to the internet, and lets you install them with one click."],
    ["How do I get help or report a problem?", "Use the buttons below to email or WhatsApp us directly, any time."],
  ];
  const helpCard = h('div', { class: 'card' }, h('b', {}, 'Help & Support'),
    h('p', { class: 'hint' }, `The ChurchFlow v${APP_VERSION} \u00b7 by Joey Studios`),
    ...helpFaqs.map(([q, a]) => h('details', {}, h('summary', {}, q), h('p', { class: 'hint' }, a))),
    h('p', { class: 'actions' },
      h('a', { class: 'btn ghost', href: 'mailto:joelmensah40@gmail.com' }, icon('chat', { size: 15 }), 'Email support'),
      h('a', { class: 'btn ghost', href: 'https://wa.me/233547580808', target: '_blank', rel: 'noopener' }, icon('phone', { size: 15 }), 'WhatsApp support')));

  // ---- Factory reset: owner/admin only, and deliberately the very last, most visually distinct
  // thing on the page (see '.card.danger-zone' in style.css) -- wipes every member, household,
  // attendance record, transaction, ministry, and setting this church has ever saved, but keeps
  // this login and every other staff login working, so there's something to sign back into
  // afterwards. See server/src/app.js's POST /account/factory-reset for exactly what "wipe"
  // means (a real tombstone-based delete, not a local-only one) -- every other signed-in device
  // picks this up on its own next sync, same as any other delete.
  const resetForm = canManageChurch && h('form', { onsubmit: async (e) => { e.preventDefault();
    const typedName = val(resetForm, 'churchName');
    if (typedName !== (church ?? '')) return toast("That doesn't match your church's name exactly.", 'err');
    if (!(await confirmDialog(`This permanently deletes every member, attendance record, transaction, and everything else "${church}" has ever saved -- on every device, the next time each one syncs. Staff logins are kept, so you can sign back in to an empty church afterwards. This cannot be undone.`, 'Delete everything'))) return;
    const btn = resetForm.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    try {
      await repo.factoryReset(val(resetForm, 'password'), typedName);
      toast('Church data wiped -- starting fresh.');
      rerender();
    } catch (ex) { toast(ex.message, 'err'); }
    finally { if (btn) btn.disabled = false; }
  } },
    h('p', { class: 'hint' }, `Type your church's name exactly ("${church ?? ''}") and enter your password to permanently wipe every member, household, attendance record, transaction, ministry, and setting this church has ever saved. Staff logins are kept -- there's just nothing left in them afterwards. This cannot be undone.`),
    h('div', { class: 'row' },
      field('Church name', h('input', { name: 'churchName', placeholder: church ?? '', autocomplete: 'off' })),
      field('Your password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' }))),
    h('p', { class: 'actions' }, h('button', { type: 'submit', class: 'btn danger' }, 'Delete all church data')));

  return h('div', {}, h('h2', {}, 'Settings'),
    h('div', { class: 'card' }, h('b', {}, church ?? 'Your church'), h('p', { class: 'hint' }, `${user.name} · ${user.email} · ${user.role}`)),
    // My profile and Password come right after the church summary, ahead of church-wide/admin
    // settings — this is where the top bar's account badge jumps to (see main.js), so it's the
    // signed-in person's own settings, not something they have to scroll past the rest to find.
    h('div', { class: 'card', id: 'my-profile' }, h('b', {}, 'My profile'), profile),
    h('div', { class: 'card' }, h('b', {}, 'Password'), pw),
    h('div', { class: 'card' }, h('b', {}, 'Appearance'),
      h('p', { class: 'hint' }, 'Only affects this device/browser — everyone signed in here chooses their own.'), themeTabs),
    churchCard,
    canManageChurch && h('div', { class: 'card' }, h('b', {}, 'SMS (Arkesel)'), smsForm),
    canManageChurch && h('div', { class: 'card' }, h('b', {}, 'Online giving (Paystack)'), paystackForm),
    canManageChurch && h('div', { class: 'card' }, h('b', {}, 'WhatsApp (broadcast + check-in)'), whatsappForm),
    canViewCheckin && h('div', { class: 'card' }, h('b', {}, 'QR check-in'),
      h('p', { class: 'hint' }, 'Display this on a screen or print it at the entrance — a member scans it with their own phone camera, enters their phone number, and is marked present for today. No account to connect, nothing to install.'),
      h('div', { class: 'checkin-qr-row' }, qrCanvas,
        h('div', { class: 'checkin-qr-actions' },
          h('div', { class: 'row' }, h('input', { readonly: true, value: checkinLink, onclick: (e) => e.target.select() }),
            h('button', { type: 'button', class: 'btn ghost sm', onclick: async () => { await navigator.clipboard?.writeText(checkinLink); toast('Link copied'); } }, icon('download', { size: 13 }), 'Copy link')),
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => download('check-in-qr-code.svg', qrToSvgString(checkinLink, { moduleSize: 10 }), 'image/svg+xml') }, icon('print', { size: 13 }), 'Download for printing (SVG)'))),
      canManageChurch && checkinForm),
    canManageChurch && go && h('div', { class: 'card' }, h('b', {}, 'Staff & leaders'),
      h('p', { class: 'hint' }, 'Create logins for other office staff and ministry leaders, change roles, reset passwords, or deactivate an account.'),
      h('p', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => go('staff') }, icon('staff', { size: 15 }), 'Manage staff & leaders'))),
    h('div', { class: 'card' }, h('b', {}, 'Sync & backup'), h('p', { class: 'hint' }, `Last synced: ${last ? new Date(last).toLocaleString() : 'never'} · ${pending} change${pending === 1 ? '' : 's'} waiting`),
      h('p', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { await sync(); toast('Sync finished'); } }, 'Sync now'),
        h('button', { class: 'btn ghost', onclick: async () => download(`church-backup-${today()}.json`, await repo.backup(), 'application/json') }, icon('download', { size: 15 }), 'Download backup (JSON)'),
        h('button', { class: 'btn ghost', onclick: async () => { if (!navigator.onLine) return toast('You need to be online.', 'err');
          if (await confirmDialog('Re-download all data from the server? Use this if something looks out of date.', 'Re-download')) { try { await repo.resync(); toast('Data refreshed'); rerender(); } catch (e) { toast(e.message, 'err'); } } } }, icon('sync', { size: 15 }), 'Re-download data'))),
    h('div', { class: 'card' }, h('b', {}, 'Clock-in device'),
      h('p', { class: 'hint' }, 'Pull the list of people already enrolled on the Hikvision face/fingerprint clock-in terminal, as a spreadsheet you can open in Excel — review and fill in the rest (phone, status, household…), then upload it under Members → "Upload member spreadsheet" to actually create or update those member records. This only works when this app is running on a computer on the same network as the device (see README, "Hikvision clock-in integration").'),
      h('p', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const r = await fetch('/api/device/pull-users', { method: 'POST' });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `Could not reach the device (HTTP ${r.status}).`);
          const rows = [['Name', 'Device ID', 'Phone', 'Email', 'Gender', 'Status', 'Birthday', 'Household'],
            ...data.users.map((u) => [u.name ?? '', u.deviceUserId ?? '', '', '', '', '', '', ''])];
          download(`clock-in-device-users-${today()}.csv`, toCSV(rows), 'text/csv');
          toast(`Downloaded ${data.users.length} enrolled ${data.users.length === 1 ? 'person' : 'people'} as a spreadsheet — open it in Excel, fill in the rest, then upload it under Members.`);
        } catch (ex) { toast(ex.message, 'err'); }
        finally { btn.disabled = false; }
      } }, icon('download', { size: 15 }), 'Pull enrolled users from device'))),
    helpCard,
    canManageChurch && h('div', { class: 'card danger-zone' }, h('b', {}, 'Danger zone'), resetForm));
}

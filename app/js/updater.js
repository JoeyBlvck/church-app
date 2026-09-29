// Desktop-only auto-update check, using Tauri's own updater plugin (src-tauri/Cargo.toml /
// lib.rs, and the "updater" block in src-tauri/tauri.conf.json for where it checks and which key
// a build must be signed with). A no-op everywhere else -- the web/PWA build has no
// window.__TAURI__ at all, so every function here just returns immediately there.
//
// Deliberately notifies rather than silently installing (see main.js's own note on why: someone
// could be mid-entry on a form) -- a small modal offers "Update now" or "Later", and only
// downloads/installs once they say so. "Later" is remembered for that one version only, for the
// rest of this launch, so it doesn't nag again a minute later, but does come back for whatever
// version ships after it, and again next time the app is opened.
import { h, modal, toast } from './ui.js';

let dismissedVersion = null;
let checking = false;

export async function checkForUpdate() {
  const updater = window.__TAURI__?.updater;
  if (!updater || checking) return;
  checking = true;
  try {
    const update = await updater.check();
    // check() resolves to null/undefined when this is already the newest version -- any other
    // truthy result IS an available update (not every Tauri version populates an `.available`
    // field on it, so presence is what's checked here, not that field).
    if (update && update.version !== dismissedVersion) showUpdateModal(update);
  } catch (e) {
    console.warn('Update check failed:', e); // a flaky connection or GitHub hiccup here should never interrupt normal use
  } finally {
    checking = false;
  }
}

function showUpdateModal(update) {
  const notes = (update.body ?? '').trim();
  const installBtn = h('button', { class: 'btn', onclick: async () => {
    installBtn.disabled = true; installBtn.textContent = 'Downloading…';
    try {
      await update.downloadAndInstall();
      // Restarts the app straight into the new version -- there's nothing unsaved to lose here:
      // every screen already saves to the local store immediately (see sync.js), and a relaunch
      // is no different from a normal quit-and-reopen. Tried under both names since which one
      // the installed plugin version exposes has moved around between Tauri releases.
      const proc = window.__TAURI__.process;
      await (proc.relaunch ?? proc.restart)?.call(proc);
    } catch (e) {
      console.warn('Update install failed:', e);
      toast("Couldn't install the update — try again later.", 'err');
      installBtn.disabled = false; installBtn.textContent = `Update to v${update.version}`;
    }
  } }, `Update to v${update.version}`);
  const m = modal('Update available', h('div', {},
    h('p', {}, `A new version of The ChurchFlow (v${update.version}) is ready to install.`),
    notes && h('p', { class: 'hint' }, notes),
    h('p', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: () => { dismissedVersion = update.version; m.close(); } }, 'Later'),
      installBtn)));
}

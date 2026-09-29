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

// Deciding whose session a freshly-launched build should keep -- see
// signOutIfInstalledOutsideUpdater() below for the actual rule.
const LAST_SEEN_VERSION_KEY = 'churchflowLastSeenVersion';
const RELAUNCHED_BY_UPDATER_KEY = 'churchflowRelaunchedByUpdater';

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
      // Tells signOutIfInstalledOutsideUpdater() (below) that the version about to start up got
      // there through THIS in-app flow, not a manually re-run installer, so it should leave the
      // signed-in session alone rather than treating it as a fresh, unattended install.
      try { localStorage.setItem(RELAUNCHED_BY_UPDATER_KEY, '1'); } catch {}
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

// Called once, early, on every app startup (main.js, before the first render()). Tells apart two
// very different reasons the app might be opening on a version it hasn't seen before:
//
//  - Someone clicked "Update now" above, in an already-open, already-signed-in app: keep the
//    session going -- see the RELAUNCHED_BY_UPDATER_KEY flag set right before relaunch, above.
//  - Someone (re)installed a build by hand -- e.g. downloading it fresh from the website -- onto
//    a device that had a DIFFERENT build's session cached in its local storage from before. That
//    install may have happened while nobody was watching, or the person opening it now may not be
//    whoever was last signed in here, so it should land on the sign-in screen, not silently
//    resume a stranger's (or a previous tester's) church.
//
// A device seeing its very first-ever version (nothing recorded yet) is neither of these -- it's
// simply a normal new install with nothing cached to protect, so it's left alone either way.
export async function signOutIfInstalledOutsideUpdater(repo) {
  const version = await window.__TAURI__?.app?.getVersion?.().catch(() => null);
  if (!version) return; // web/PWA build, or a desktop build old enough to predate this
  let lastSeen = null, relaunchedByUpdater = false;
  try {
    lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    relaunchedByUpdater = localStorage.getItem(RELAUNCHED_BY_UPDATER_KEY) === '1';
    localStorage.removeItem(RELAUNCHED_BY_UPDATER_KEY);
    localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
  } catch { return; } // no localStorage (very unlikely in a Tauri webview) -- nothing safe to compare, so don't guess
  if (lastSeen && lastSeen !== version && !relaunchedByUpdater && (await repo.user())) await repo.logout();
}

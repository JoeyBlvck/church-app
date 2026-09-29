import test from 'node:test';
import assert from 'node:assert/strict';

// Same module-load stubbing as ui.test.js (updater.js imports from ui.js, which pulls in
// config.js) -- nothing under test here touches the DOM.
globalThis.location = { hostname: 'test', protocol: 'http:' };
globalThis.localStorage = { getItem: () => null };
const { signOutIfInstalledOutsideUpdater } = await import('../js/updater.js');

// A tiny in-memory localStorage, fresh per test, standing in for the real one.
function fakeLocalStorage(initial = {}) {
  const store = { ...initial };
  return { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, _dump: () => ({ ...store }) };
}
function fakeRepo(signedIn = true) {
  let loggedOut = false;
  return { user: async () => (signedIn && !loggedOut ? { name: 'Ama' } : null), logout: async () => { loggedOut = true; }, wasLoggedOut: () => loggedOut };
}

test('signOutIfInstalledOutsideUpdater: a brand new device (no version recorded yet) is left alone', async () => {
  globalThis.localStorage = fakeLocalStorage();
  globalThis.window = { __TAURI__: { app: { getVersion: async () => '0.18.5' } } };
  const repo = fakeRepo(true);
  await signOutIfInstalledOutsideUpdater(repo);
  assert.equal(repo.wasLoggedOut(), false);
  assert.equal(globalThis.localStorage.getItem('churchflowLastSeenVersion'), '0.18.5');
});

test('signOutIfInstalledOutsideUpdater: reopening the same version normally never signs anyone out', async () => {
  globalThis.localStorage = fakeLocalStorage({ churchflowLastSeenVersion: '0.18.5' });
  globalThis.window = { __TAURI__: { app: { getVersion: async () => '0.18.5' } } };
  const repo = fakeRepo(true);
  await signOutIfInstalledOutsideUpdater(repo);
  assert.equal(repo.wasLoggedOut(), false);
});

test('signOutIfInstalledOutsideUpdater: a different version with no "relaunched by the updater" flag (someone ran a fresh installer by hand) signs the device out', async () => {
  globalThis.localStorage = fakeLocalStorage({ churchflowLastSeenVersion: '0.18.5' });
  globalThis.window = { __TAURI__: { app: { getVersion: async () => '0.19.0' } } };
  const repo = fakeRepo(true);
  await signOutIfInstalledOutsideUpdater(repo);
  assert.equal(repo.wasLoggedOut(), true);
  assert.equal(globalThis.localStorage.getItem('churchflowLastSeenVersion'), '0.19.0');
});

test('signOutIfInstalledOutsideUpdater: a different version WITH the "relaunched by the updater" flag (the in-app "Update now" flow) keeps the session, and clears the flag', async () => {
  globalThis.localStorage = fakeLocalStorage({ churchflowLastSeenVersion: '0.18.5', churchflowRelaunchedByUpdater: '1' });
  globalThis.window = { __TAURI__: { app: { getVersion: async () => '0.19.0' } } };
  const repo = fakeRepo(true);
  await signOutIfInstalledOutsideUpdater(repo);
  assert.equal(repo.wasLoggedOut(), false);
  assert.equal(globalThis.localStorage.getItem('churchflowRelaunchedByUpdater'), null);
});

test('signOutIfInstalledOutsideUpdater: never calls repo at all when nobody is signed in yet (nothing to protect)', async () => {
  globalThis.localStorage = fakeLocalStorage({ churchflowLastSeenVersion: '0.18.5' });
  globalThis.window = { __TAURI__: { app: { getVersion: async () => '0.19.0' } } };
  const repo = fakeRepo(false);
  await signOutIfInstalledOutsideUpdater(repo);
  assert.equal(repo.wasLoggedOut(), false); // logout() would be a no-op anyway, but user() correctly reported nobody signed in
});

test('signOutIfInstalledOutsideUpdater: no-ops entirely on the web/PWA build (no window.__TAURI__ at all)', async () => {
  globalThis.localStorage = fakeLocalStorage({ churchflowLastSeenVersion: '0.18.5' });
  globalThis.window = {};
  const repo = fakeRepo(true);
  await signOutIfInstalledOutsideUpdater(repo);
  assert.equal(repo.wasLoggedOut(), false);
});

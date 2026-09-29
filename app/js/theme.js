// Light/dark theme — manual only, never following the device's system setting. The dark
// palette used to live behind `@media (prefers-color-scheme: dark)` in style.css, so the app
// silently went dark for anyone whose device happened to be set to dark mode, with no way back
// short of changing an OS-level setting. Now it always opens light unless someone explicitly
// turns dark mode on here (Settings > Appearance), and that choice sticks to this one
// device/browser via localStorage — it's a personal display preference, not church data, so it
// deliberately isn't synced anywhere.
const KEY = 'theme';

export function getTheme() {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

// Sets the `data-theme` attribute style.css's `:root[data-theme="dark"]` block keys off — called
// once at startup (see the inline snippet in index.html's <head>, which runs this same check
// before the stylesheet paints anything, so there's no flash of the wrong theme) and again
// whenever the Appearance card's toggle changes it.
export function applyTheme(theme = getTheme()) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme === 'dark' ? 'dark' : 'light'); } catch {}
  applyTheme(theme);
}

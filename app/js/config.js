// Point this at your deployed sync server. Wrapped desktop/mobile builds use the same value.
// Deployed on Railway (see README "Deploying").
const PRODUCTION_API_URL = 'https://church-manager-server-production.up.railway.app';
// Tauri's webview serves the app from a custom "tauri://localhost" scheme on
// macOS/Linux, so location.hostname is literally "localhost" even in the
// packaged desktop app — that used to get misdetected as local dev and made
// the installed app try (and fail) to reach a dev server on the user's own
// machine. window.__TAURI_INTERNALS__ is always present in a Tauri build
// (dev or packaged), so check that first and never treat a Tauri build as
// local dev.
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const isLocalDev = !isTauri && ['localhost', '127.0.0.1', ''].includes(location.hostname);
export const API_URL = localStorage.getItem('apiUrl') ?? (isLocalDev ? 'http://localhost:8787' : PRODUCTION_API_URL);
export const CURRENCY = 'GHS';

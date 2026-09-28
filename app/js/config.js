// Point this at your deployed sync server. Wrapped desktop/mobile builds use the same value.
// Deployed on Railway (see README "Deploying").
const PRODUCTION_API_URL = 'https://church-manager-server-production.up.railway.app';
const isLocalDev = ['localhost', '127.0.0.1', ''].includes(location.hostname);
export const API_URL = localStorage.getItem('apiUrl') ?? (isLocalDev ? 'http://localhost:8787' : PRODUCTION_API_URL);
export const CURRENCY = 'GHS';

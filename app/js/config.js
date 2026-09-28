// Point this at your deployed sync server. Wrapped desktop/mobile builds use the same value.
// Set this once the Render web service exists (see render.yaml / README "Deploying").
const PRODUCTION_API_URL = 'https://church-manager-server.onrender.com';
const isLocalDev = ['localhost', '127.0.0.1', ''].includes(location.hostname);
export const API_URL = localStorage.getItem('apiUrl') ?? (isLocalDev ? 'http://localhost:8787' : PRODUCTION_API_URL);
export const CURRENCY = 'GHS';

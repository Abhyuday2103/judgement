// Stand-in for Firebase's app module. Hands the real config to hybrid.js. See hybrid.js and core.js.
import { setConfig } from './hybrid.js';
export function initializeApp(config) { setConfig(config); return { options: config || {} }; }

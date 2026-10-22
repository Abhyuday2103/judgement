// The switch between the two ways a table can run:
//   cloud: the Firebase function deals and runs the table (nobody's browser ever holds other hands)
//   host:  the host's browser runs the same server code and friends connect to it (core.js)
// New tables try the cloud first. If the cloud server can't be reached, the table runs on the host.
// Each table remembers which way it runs, so joining and rejoining go to the right place.
import * as core from './core.js';
import CFG from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const KEY = `hy_${CFG.fn}_backend`;
const loadMap = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
const where = loadMap();
export function backendOf(code) { return where[code]; }
export function remember(code, b) {
  if (!code) return;
  where[code] = b;
  try { localStorage.setItem(KEY, JSON.stringify(where)); } catch (e) { /* storage blocked */ }
}
const timeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { infra: true })), ms))]);

let cfg = null;
export function setConfig(c) { cfg = c; }

// Firebase SDK, loaded once. Resolves to null if the cloud can't be used at all.
let cloudP = null;
export let cloud = null;
export function getCloud() {
  if (cloudP) return cloudP;
  cloudP = (async () => {
    if (!cfg) return null;
    try {
      const [appM, authM, fsM, fnM] = await timeout(Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-functions.js'].map((f) => import(SDK + f))), 10000, 'sdk');
      const app = appM.initializeApp(cfg, 'cloud-' + CFG.fn);
      const auth = authM.getAuth(app);
      await auth.authStateReady();
      if (!auth.currentUser) await timeout(authM.signInAnonymously(auth), 8000, 'auth');
      core.setUid(auth.currentUser.uid);
      const db = fsM.initializeFirestore(app, { experimentalForceLongPolling: true });
      const fns = fnM.getFunctions(app);
      cloud = { fsM, fnM, db, fns, call: fnM.httpsCallable(fns, CFG.fn, { timeout: 15000 }) };
      return cloud;
    } catch (e) {
      console.warn('Cloud server unavailable, tables will run on the host.', e && e.message);
      return null;
    }
  })();
  return cloudP;
}

let cloudDown = false; // set once a call shows the server itself is broken; resets on reload
const isInfra = (e) => {
  if (!e) return true;
  if (e.infra) return true;
  const c = String(e.code || '').replace('functions/', '');
  return ['internal', 'unavailable', 'deadline-exceeded', 'unknown', 'not-found', 'resource-exhausted'].includes(c) && !/table|seat|turn|name|code/i.test(e.message || '');
};
const gameErr = (e) => new Error((e && e.message) || 'Request failed');

async function cloudCall(data) {
  const c = await getCloud();
  if (!c || cloudDown) throw Object.assign(new Error('cloud off'), { infra: true });
  try { return (await timeout(c.call(data), 16000, 'timeout')).data; }
  catch (e) { if (isInfra(e)) { cloudDown = true; e.infra = true; } throw e; }
}

export async function call(data) {
  data = data || {};
  await getCloud(); // settles which id we sign in with before anything else happens
  if (data.op === 'create') {
    try {
      const r = await cloudCall(data);
      remember(core.cleanCode(r && r.tableId), 'cloud');
      return r;
    } catch (e) {
      if (!e.infra) throw gameErr(e);
      const r = await core.call(data);
      remember(core.cleanCode(r && r.tableId), 'host');
      return r;
    }
  }
  const code = core.cleanCode(data.tableId || data.id || data.code);
  const b = backendOf(code) || (core.isHostOf(code) ? 'host' : null);
  if (b === 'host') return core.call(data);
  if (b === 'cloud') {
    try { return await cloudCall(data); } catch (e) { throw gameErr(e); }
  }
  // Unknown table (first time joining): ask the cloud, then the host network.
  let firstErr = null;
  try {
    const r = await cloudCall(data);
    if (!(r && r.ok === false && /No table/i.test(r.error || ''))) { if (code) remember(code, 'cloud'); return r; }
  } catch (e) {
    if (!e.infra && !/No table|expired/i.test(e.message || '')) throw gameErr(e);
    firstErr = e.infra ? null : e;
  }
  try {
    const r = await core.call(data);
    if (code) remember(code, 'host');
    return r;
  } catch (e) {
    throw gameErr(firstErr && /No table/i.test(e.message) ? firstErr : e);
  }
}

// Which side a database path belongs to (paths look like collection/CODE/...).
export function sideOf(path) {
  const code = core.cleanCode(String(path).split('/')[1]);
  const b = backendOf(code) || (core.isHostOf(code) ? 'host' : null);
  if (b) return b;
  return cloud && !cloudDown ? 'cloud' : 'host';
}

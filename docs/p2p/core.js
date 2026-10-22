// Online play fallback when the cloud server is down (see hybrid.js for the switch).
// The host's browser runs the game's original server code (srv/index.js) against a small in-memory
// database. Everyone else connects straight to the host over PeerJS (same setup as Ultimate Hold'em).
// The firebase-*.js files next to this one give the game page the same calls it used with Firebase,
// so the game code itself did not have to change.
import CFG from './config.js';

const LS = (k) => `p2p_${CFG.fn}_${k}`;
const lsGet = (k, d) => { try { const v = localStorage.getItem(LS(k)); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS(k), JSON.stringify(v)); } catch (e) { /* storage blocked */ } };

export let uid = (() => {
  let u = lsGet('uid', null);
  if (!u) { u = 'u' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); lsSet('uid', u); }
  return u;
})();
// When the Firebase server is reachable we use its sign-in id everywhere, so one id works in both modes.
export function setUid(u) { if (u && u !== uid) { uid = u; lsSet('uid', u); } }

// ---------- timestamps ----------
export const TS_SENTINEL = '__p2p_server_ts__';
const resolveTs = (v, now) => {
  if (v && typeof v === 'object') {
    if (v[TS_SENTINEL]) return { __ts: now };
    if (v instanceof Date) return { __ts: v.getTime() };
    if (Array.isArray(v)) return v.map((x) => resolveTs(x, now));
    const o = {};
    for (const k of Object.keys(v)) o[k] = resolveTs(v[k], now);
    return o;
  }
  return v;
};
export const hydrate = (v) => {
  if (v && typeof v === 'object') {
    if (typeof v.__ts === 'number' && Object.keys(v).length === 1) {
      const ms = v.__ts;
      return { toMillis: () => ms, toDate: () => new Date(ms), valueOf: () => ms, seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
    }
    if (Array.isArray(v)) return v.map(hydrate);
    const o = {};
    for (const k of Object.keys(v)) o[k] = hydrate(v[k]);
    return o;
  }
  return v;
};

// ---------- in-memory database (lives in the host's browser, saved so a refresh keeps the table) ----------
const store = new Map(Object.entries(lsGet('db', {})));
const docSubs = new Map();  // path -> Set(cb)
const colSubs = new Map();  // collection path -> Set(cb)
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}
function saveNow() {
  clearTimeout(saveTimer);
  {
    // Keep only tables touched in the last day so storage never fills up.
    const cutoff = Date.now() - 26 * 3600 * 1000;
    const live = new Set();
    for (const [p, v] of store) {
      const seg = p.split('/');
      if (seg.length === 2 && v && v.updatedAt && v.updatedAt.__ts > cutoff) live.add(seg[0] + '/' + seg[1]);
    }
    const out = {};
    for (const [p, v] of store) { const s = p.split('/'); if (live.has(s[0] + '/' + s[1])) out[p] = v; }
    lsSet('db', out);
  }
}
window.addEventListener('pagehide', saveNow);
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
function colDocs(colPath) {
  const depth = colPath.split('/').length + 1;
  const docs = [];
  for (const [p, v] of store) if (p.startsWith(colPath + '/') && p.split('/').length === depth) docs.push({ id: p.split('/').pop(), data: v });
  return docs;
}
export const mem = {
  get: (path) => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined),
  list: (colPath) => JSON.parse(JSON.stringify(colDocs(colPath))),
  set(path, data) {
    const v = resolveTs(JSON.parse(JSON.stringify(data, (k, x) => (x instanceof Date ? { __ts: x.getTime() } : x))), Date.now());
    const before = store.has(path) ? JSON.stringify(store.get(path)) : null;
    const after = JSON.stringify(v);
    store.set(path, v);
    persist();
    if (before === after) return;
    for (const cb of docSubs.get(path) || []) cb(this.get(path));
    const col = parentOf(path);
    for (const cb of colSubs.get(col) || []) cb(this.list(col));
  },
  subDoc(path, cb) {
    if (!docSubs.has(path)) docSubs.set(path, new Set());
    docSubs.get(path).add(cb);
    cb(this.get(path));
    return () => docSubs.get(path).delete(cb);
  },
  subCol(path, cb) {
    if (!colSubs.has(path)) colSubs.set(path, new Set());
    colSubs.get(path).add(cb);
    cb(this.list(path));
    return () => colSubs.get(path).delete(cb);
  },
};

// ---------- the game's own server code, run in this browser when we host ----------
let serverFn = null;
async function server() {
  if (!serverFn) {
    const mod = await import(CFG.server);
    serverFn = mod[CFG.fn];
  }
  return serverFn;
}
let chain = Promise.resolve();
async function runServer(callerUid, data) {
  const fn = await server();
  const job = chain.then(() => fn({ auth: { uid: callerUid }, data, rawRequest: {} }));
  chain = job.catch(() => {});
  return job;
}

// ---------- PeerJS ----------
let peerLib = null;
function loadPeer() {
  if (peerLib) return peerLib;
  peerLib = new Promise((res, rej) => {
    if (window.Peer) return res(window.Peer);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = () => res(window.Peer);
    s.onerror = () => { peerLib = null; rej(new Error('Could not load the connection library. Check your internet.')); };
    document.head.appendChild(s);
  });
  return peerLib;
}
const PEER_OPTS = { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };
const peerId = (code) => `abh-${CFG.fn}-v1-${code}`;
export const cleanCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
export const isHostOf = (code) => !!code && store.has(`${CFG.col}/${code}/secret/state`);

// ----- host side -----
const hosting = new Map(); // code -> Promise<Peer>
export function hostOpen(code) {
  if (hosting.has(code)) return hosting.get(code);
  const p = (async () => {
    const Peer = await loadPeer();
    for (let attempt = 0; ; attempt++) {
      const peer = new Peer(peerId(code), PEER_OPTS);
      const ok = await new Promise((res) => {
        peer.on('open', () => res(true));
        peer.on('error', (e) => { if (e.type === 'unavailable-id' || e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') res(false); });
      });
      if (ok) {
        peer.on('connection', serveConn);
        peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* retry below */ } });
        return peer;
      }
      peer.destroy();
      // The old tab (after a refresh) can hold the address for a few seconds. Keep trying.
      await new Promise((r) => setTimeout(r, Math.min(5000, 1000 + attempt * 500)));
    }
  })();
  hosting.set(code, p);
  return p;
}
function allowedRead(path, connUid) {
  const s = path.split('/');
  if (s[0] !== CFG.col || s.includes('secret')) return false;
  const vi = s.indexOf('views');
  if (vi >= 0 && s[vi + 1] && s[vi + 1] !== connUid) return false;
  return true;
}
function allowedWrite(path, connUid) {
  const s = path.split('/');
  return s[0] === CFG.col && s.length === 4 && s[2] === 'presence' && s[3] === connUid;
}
function serveConn(conn) {
  let connUid = null;
  const subs = new Map();
  const send = (m) => { try { if (conn.open) conn.send(m); } catch (e) { /* closed */ } };
  conn.on('data', async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') { connUid = String(m.uid || '').slice(0, 64); return; }
    if (!connUid) return;
    if (m.t === 'call') {
      try { const data = await runServer(connUid, m.data); send({ t: 'res', id: m.id, ok: true, data }); }
      catch (e) { send({ t: 'res', id: m.id, ok: false, error: (e && e.message) || 'Something went wrong' }); }
    } else if (m.t === 'sub') {
      if (!allowedRead(m.path, connUid)) return send({ t: 'snap', sid: m.sid, denied: true });
      const fn = m.kind === 'col' ? mem.subCol.bind(mem) : mem.subDoc.bind(mem);
      subs.set(m.sid, fn(m.path, (v) => send({ t: 'snap', sid: m.sid, v })));
    } else if (m.t === 'unsub') {
      const u = subs.get(m.sid); if (u) u(); subs.delete(m.sid);
    } else if (m.t === 'get') {
      if (!allowedRead(m.path, connUid)) return send({ t: 'res', id: m.id, ok: false, error: 'Not allowed' });
      send({ t: 'res', id: m.id, ok: true, data: m.kind === 'col' ? mem.list(m.path) : mem.get(m.path) });
    } else if (m.t === 'set') {
      if (allowedWrite(m.path, connUid)) mem.set(m.path, m.data);
      send({ t: 'res', id: m.id, ok: true, data: null });
    }
  });
  const drop = () => { for (const u of subs.values()) u(); subs.clear(); };
  conn.on('close', drop);
  conn.on('error', drop);
}

// ----- guest side -----
const links = new Map(); // code -> Link
class Link {
  constructor(code) {
    this.code = code; this.seq = 0; this.pending = new Map(); this.subs = new Map();
    this.everOpen = false; this.conn = null; this.connecting = null; this.closed = false;
  }
  async open() {
    if (this.conn && this.conn.open) return this.conn;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const Peer = await loadPeer();
      if (!this.peer || this.peer.destroyed || this.peer.disconnected) {
        if (this.peer) try { this.peer.destroy(); } catch (e) { /* ignore */ }
        this.peer = new Peer(PEER_OPTS);
        await new Promise((res, rej) => {
          this.peer.on('open', res);
          this.peer.on('error', (e) => rej(new Error('Could not reach the game network. Check your internet.')));
          setTimeout(() => rej(new Error('Could not reach the game network. Check your internet.')), 12000);
        });
      }
      const conn = this.peer.connect(peerId(this.code), { reliable: true });
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(this.missing()), 12000);
        conn.on('open', () => { clearTimeout(t); res(); });
        this.peer.once('error', (e) => { clearTimeout(t); rej(e.type === 'peer-unavailable' ? this.missing() : new Error('Connection to the host failed. Try again.')); });
      });
      conn.send({ t: 'hello', uid });
      conn.on('data', (m) => this.onMsg(m));
      conn.on('close', () => this.lost());
      conn.on('error', () => this.lost());
      this.conn = conn; this.everOpen = true;
      // Re-subscribe anything we were watching before a drop.
      for (const [sid, s] of this.subs) conn.send({ t: 'sub', sid, path: s.path, kind: s.kind });
      return conn;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  missing() {
    return this.everOpen
      ? new Error('The host dropped off. Waiting for them to come back.')
      : new Error('No table with that code, or the host is offline. Check the code and try again.');
  }
  lost() {
    if (this.conn) { this.conn = null; }
    for (const [, p] of this.pending) p.rej(new Error('The host dropped off. Waiting for them to come back.'));
    this.pending.clear();
    if (this.subs.size && !this.retry) {
      this.retry = setTimeout(async () => { this.retry = null; try { await this.open(); } catch (e) { this.lost(); } }, 2500);
    }
  }
  onMsg(m) {
    if (!m) return;
    if (m.t === 'res') {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.res(m.data) : p.rej(new Error(m.error));
    } else if (m.t === 'snap') {
      const s = this.subs.get(m.sid);
      if (s && !m.denied) s.cb(m.v);
    }
  }
  async req(msg) {
    const conn = await this.open();
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); conn.send({ ...msg, id }); });
  }
  sub(path, kind, cb) {
    const sid = 's' + (++this.seq);
    this.subs.set(sid, { path, kind, cb });
    this.open().then((c) => { if (this.subs.has(sid)) c.send({ t: 'sub', sid, path, kind }); }).catch(() => this.lost());
    return () => {
      this.subs.delete(sid);
      if (this.conn && this.conn.open) this.conn.send({ t: 'unsub', sid });
    };
  }
}
const link = (code) => { if (!links.has(code)) links.set(code, new Link(code)); return links.get(code); };

// ---------- what the firebase-*.js stand-ins call ----------
export async function call(data) {
  data = data || {};
  if (data.op === 'create') {
    const r = await runServer(uid, data);
    const code = cleanCode(r && (r.tableId || r.id || r.code));
    if (code) await hostOpen(code);
    return r;
  }
  const code = cleanCode(data.tableId || data.id || data.code);
  if (isHostOf(code)) { hostOpen(code); return runServer(uid, data); }
  if (!code) return runServer(uid, data); // lets the server give its own "type the code" message
  return link(code).req({ t: 'call', data });
}
const codeOfPath = (path) => cleanCode(path.split('/')[1]);
export function watch(path, kind, cb) {
  const code = codeOfPath(path);
  if (isHostOf(code)) return kind === 'col' ? mem.subCol(path, cb) : mem.subDoc(path, cb);
  return link(code).sub(path, kind, cb);
}
export async function read(path, kind) {
  const code = codeOfPath(path);
  if (isHostOf(code)) return kind === 'col' ? mem.list(path) : mem.get(path);
  return link(code).req({ t: 'get', path, kind });
}
export async function write(path, data) {
  const code = codeOfPath(path);
  if (isHostOf(code)) return mem.set(path, data);
  return link(code).req({ t: 'set', path, data });
}

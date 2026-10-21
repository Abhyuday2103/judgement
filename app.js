import * as E from './engine.js';
import { firebaseConfig } from './firebase-config.js';

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('jg_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('jg_' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem('jg_' + k); } catch (e) { /* storage blocked */ } },
};
const params = new URLSearchParams(location.search);
const EMU = params.get('emu'); // ?emu=127.0.0.1 runs against the local Firebase emulators (testing only)
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function loading(on, msg = 'Connecting') { $('#loading').hidden = !on; $('#loading-msg').textContent = msg; }
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const SYM = { S: '♠︎', H: '♥︎', D: '♦︎', C: '♣︎' };
const isRed = (s) => s === 'H' || s === 'D';
function cardHTML(c, trump) {
  const r = c[0] === 'T' ? '10' : c[0];
  return `<div class="card ${isRed(c[1]) ? 'red' : ''} ${c[1] === trump ? 'trumpc' : ''}" role="img" aria-label="${E.cardLabel(c)}"><span class="idx"><span class="rk">${r}</span><span class="st">${SYM[c[1]]}</span></span><span class="pip">${SYM[c[1]]}</span></div>`;
}
const suitTag = (s) => `<span class="${isRed(s) ? 'red' : ''}">${SYM[s]}</span>`;

// ---------- practice: the whole game runs in this browser ----------
class LocalServer {
  constructor(name, bots) {
    this.mode = 'local';
    this.uid = 'me';
    this.code = 'PRACTICE';
    this.st = E.createTable('PRACTICE', 'me', name);
    for (let i = 0; i < bots; i++) E.dispatch(this.st, 'me', { type: 'addBot' }, Date.now());
    this.timer = setInterval(() => {
      let acted = false;
      try { acted = E.runBots(this.st, Date.now()); } catch (e) { console.error(e); }
      if (acted) this.emit();
    }, 120);
  }
  watch(cb) { this.cb = cb; this.emit(); }
  emit() { this.st.now = Date.now(); lastOk = Date.now(); if (this.cb) this.cb(E.viewFor(this.st, this.uid)); }
  async act(a) {
    const snap = structuredClone(this.st);
    try { E.dispatch(this.st, this.uid, a, Date.now()); } catch (e) { this.st = snap; throw e; }
    this.emit();
  }
  stop() { clearInterval(this.timer); }
}

// ---------- online: the Firebase function owns the deck. This browser only ever receives its own view. ----------
let fb = null;
async function firebase() {
  if (fb) return fb;
  if (!firebaseConfig) throw new Error('Online play is not set up yet. Add your Firebase config (see README).');
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [appM, authM, fsM, fnM] = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-functions.js'].map((f) => import(base + f)));
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  if (EMU) authM.connectAuthEmulator(auth, `http://${EMU}:9099`, { disableWarnings: true });
  // Anonymous sign-in. The id lives in this browser, so refreshing or coming back later keeps your seat.
  await auth.authStateReady();
  if (!auth.currentUser) await authM.signInAnonymously(auth);
  const db = fsM.initializeFirestore(app, { experimentalForceLongPolling: true });
  if (EMU) fsM.connectFirestoreEmulator(db, EMU, 8080);
  const fns = fnM.getFunctions(app);
  if (EMU) fnM.connectFunctionsEmulator(fns, EMU, 5001);
  const call = fnM.httpsCallable(fns, 'jg', { timeout: 15000 });
  const uid = auth.currentUser.uid;
  const viewRef = (id) => fsM.doc(db, 'jtables', id, 'views', uid);
  const readView = (s) => (s.exists() ? JSON.parse(s.data().json) : null);
  fb = {
    uid,
    call: async (data) => {
      const sent = Date.now();
      try {
        const r = (await call(data)).data;
        if (r && r.view && r.view.serverNow) offset = r.view.serverNow - (sent + Date.now()) / 2;
        lastOk = Date.now();
        return r;
      } catch (e) { throw new Error(e.message || 'Request failed'); }
    },
    watch: (id, cb) => fsM.onSnapshot(viewRef(id), (s) => { lastOk = Date.now(); const v = readView(s); if (v) cb(v); }, () => { /* the poll covers it */ }),
    get: async (id) => { const s = await fsM.getDocFromServer(viewRef(id)); lastOk = Date.now(); return readView(s); },
    ping: (id) => fsM.setDoc(fsM.doc(db, 'jtables', id, 'presence', uid), { at: fsM.serverTimestamp() }),
    watchPresence: (id, cb) => fsM.onSnapshot(fsM.collection(db, 'jtables', id, 'presence'), (qs) => {
      const out = {};
      qs.forEach((d) => { const at = d.data({ serverTimestamps: 'estimate' }).at; out[d.id] = at && at.toMillis ? at.toMillis() : 0; });
      cb(out);
    }, () => {}),
  };
  return fb;
}
class CloudServer {
  constructor(api, code) { this.mode = 'cloud'; this.api = api; this.code = code; this.uid = api.uid; this.polling = false; this.lastPing = 0; }
  watch(cb) {
    this.cb = cb;
    // Two ways to stay in sync. The live listener is instant when it works.
    // The check-in asks the server directly every few seconds, so a frozen listener can never freeze the game.
    this.unsub = this.api.watch(this.code, cb);
    this.unsubP = this.api.watchPresence(this.code, (p) => { presence = p; render(); });
    this.stopped = false;
    this.schedule(0);
    this.onWake = () => { if (document.visibilityState === 'visible') { this.relisten(); this.schedule(0); } };
    document.addEventListener('visibilitychange', this.onWake);
    window.addEventListener('online', this.onWake);
    window.addEventListener('focus', this.onWake);
  }
  relisten() {
    if (this.unsub) this.unsub();
    this.unsub = this.api.watch(this.code, this.cb);
    if (this.unsubP) this.unsubP();
    this.unsubP = this.api.watchPresence(this.code, (p) => { presence = p; render(); });
  }
  schedule(ms) {
    clearTimeout(this.pollTimer);
    if (!this.stopped) this.pollTimer = setTimeout(() => this.checkIn(), ms);
  }
  // How soon to check in again: quickly when a computer seat is about to move, otherwise every 2.5 seconds.
  nextDelay() {
    const v = view;
    if (document.visibilityState === 'hidden') return 10000;
    if (v && ['bid', 'play', 'roundEnd'].includes(v.phase)) {
      const actor = v.phase === 'bid' ? v.bidTurn : v.phase === 'play' ? v.turn : null;
      const p = v.players.find((x) => x.uid === actor);
      if (p && (p.bot || p.auto)) return Math.min(2500, Math.max(250, (v.botAt || 0) - srvNow() + 60));
    }
    return 2500;
  }
  async checkIn() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    const ping = Date.now() - this.lastPing > 9000;
    try {
      const r = await withTimeout(this.api.call({ op: 'view', tableId: this.code, ping }), 9000);
      if (ping) { this.lastPing = Date.now(); this.api.ping(this.code).catch(() => {}); } // backup stamp straight from the browser
      if (r && r.view) this.cb(r.view);
      this.fails = 0;
    } catch (e) {
      this.fails = (this.fails || 0) + 1;
      if (/not at this table/i.test(e.message)) { this.stopped = true; seatLost(); return; }
      if (/No table|expired/i.test(e.message)) { this.stopped = true; toast(e.message, 5000); goHome(); return; }
    } finally {
      this.polling = false;
    }
    this.schedule(this.fails ? Math.min(8000, 1500 * this.fails) : this.nextDelay());
  }
  async act(a) {
    let r;
    try {
      r = await withTimeout(this.api.call({ op: 'act', tableId: this.code, action: { ...a, rid: rid() } }), 12000);
    } catch (e) {
      this.schedule(0); // whatever happened, get the real table right away
      throw e;
    }
    if (r && r.view) this.cb(r.view);
    this.schedule(this.nextDelay());
    if (r && r.ok === false) throw new Error(r.error || 'Try again.');
  }
  stop() {
    this.stopped = true;
    if (this.unsub) this.unsub();
    if (this.unsubP) this.unsubP();
    clearTimeout(this.pollTimer);
    document.removeEventListener('visibilitychange', this.onWake);
    window.removeEventListener('online', this.onWake);
    window.removeEventListener('focus', this.onWake);
  }
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('That took too long. Check your connection and try again.')), ms))]);
}

// ---------- app state ----------
let server = null;
let view = null;
let offset = 0;
let lastOk = Date.now();
let presence = {};
const srvNow = () => Date.now() + offset;
const AWAY = 70000;
const isOnline = (uid) => !server || server.mode === 'local' || (presence[uid] && srvNow() - presence[uid] < AWAY);
const ui = { sel: null, busy: false, sheet: null, show: null, showKey: '', resultSeen: '', dealKey: '', trickSeen: new Set() };

function onView(v) {
  if (!v || !Array.isArray(v.players) || !Array.isArray(v.trick)) return; // ignore anything that isn't a real table view
  if (view && v.id === view.id && v.seq < view.seq) return; // older than what we have
  const prev = view;
  view = v;
  // A finished trick stays on the felt for a moment so everyone sees who took it.
  if (v.lastTrick) {
    const key = `${v.round ? v.round.no : 0}-${v.lastTrick.no}`;
    if (key !== ui.showKey) {
      ui.showKey = key;
      if (prev && prev.id === v.id) {
        ui.show = { ...v.lastTrick };
        clearTimeout(ui.showTimer);
        ui.showTimer = setTimeout(() => { ui.show = null; render(); }, 1600);
      }
    }
  }
  if (v.trick.length) ui.show = null;
  if (ui.sel && !v.hand.includes(ui.sel)) ui.sel = null;
  render();
}
async function act(a) {
  if (!server || ui.busy) return false;
  ui.busy = true;
  render();
  try { await server.act(a); return true; }
  catch (e) { toast(e.message); return false; }
  finally { ui.busy = false; render(); }
}

// ---------- home ----------
const nameInput = $('#name');
nameInput.value = store.get('name', '');
const getName = () => {
  const n = nameInput.value.trim();
  if (!n) { nameInput.focus(); toast('Put your name in first.'); return null; }
  store.set('name', n);
  return n;
};
if (!firebaseConfig) {
  $('#online-note').hidden = false;
  $('#online-note').textContent = 'Online tables need the one-time Firebase setup in the README. Practice works now.';
}
if (params.get('t')) {
  $('#code').value = params.get('t').toUpperCase();
  $('#join').classList.add('primary');
  if (!nameInput.value) setTimeout(() => nameInput.focus(), 50);
}

$('#create').onclick = async () => {
  const name = getName(); if (!name) return;
  loading(true, 'Making your table');
  try {
    const api = await firebase();
    const r = await api.call({ op: 'create', name });
    enterCloud(api, r.tableId, r.view);
  } catch (e) { toast(e.message); }
  finally { loading(false); }
};
const definite = (msg) => /No table|expired|Type the table code|name/i.test(msg);
async function joinCode(code, quiet) {
  const name = getName(); if (!name) return;
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { toast('Type the table code.'); return; }
  loading(true, quiet ? 'Getting you back to your table' : 'Joining');
  let lastErr = null;
  try {
    // Phones on bad signal, or a server that's been asleep, can fail the first try. Retry before giving up.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const api = await firebase();
        const r = await withTimeout(api.call({ op: 'join', tableId: code, name }), 15000);
        if (r.needSeat) { showSeatPicker(api, code, r.seats); return; }
        enterCloud(api, r.tableId, r.view);
        return;
      } catch (e) {
        lastErr = e;
        if (definite(e.message)) break;
        loading(true, `Connection is slow, trying again (${attempt + 2} of 4)`);
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
    toast(lastErr ? lastErr.message : 'Could not reach the table.', 5000);
    // Only forget the table when it's really gone. A network failure keeps it, so the next reload tries again.
    if (lastErr && definite(lastErr.message)) { store.del('table'); clearUrl(); }
    else if (code) $('#code').value = code;
  } finally { loading(false); }
}
// This device isn't seated but the game is going: let them pick the seat that was theirs.
let seatPick = null;
function showSeatPicker(api, code, seats) {
  if (seatPick) clearInterval(seatPick.timer);
  seatPick = { api, code, seats };
  $('#code').value = code;
  openSheet('seat');
  // Keep checking on its own while the picker is open, so their seat shows up as soon as it's free.
  const timer = setInterval(() => { if (!seatPick || ui.sheet !== 'seat') { clearInterval(timer); return; } refreshSeats(true); }, 4000);
  seatPick.timer = timer;
}
async function claimSeat(seatUid) {
  const { api, code } = seatPick;
  loading(true, 'Taking your seat');
  try {
    const r = await withTimeout(api.call({ op: 'claim', tableId: code, seatUid }), 15000);
    clearInterval(seatPick.timer);
    seatPick = null;
    closeSheet();
    enterCloud(api, r.tableId, r.view);
    toast("You're back in. Same cards, same score.");
  } catch (e) { toast(e.message, 6000); }
  finally { loading(false); }
}
async function refreshSeats(quiet) {
  if (!seatPick || seatPick.busy) return;
  seatPick.busy = true;
  try { await refreshSeatsNow(quiet); } finally { if (seatPick) seatPick.busy = false; }
}
async function refreshSeatsNow(quiet) {
  const name = getName(); if (!name) return;
  try {
    const r = await seatPick.api.call({ op: 'join', tableId: seatPick.code, name });
    if (r.needSeat) { seatPick.seats = r.seats; renderSheet(); }
    else { const { api, timer } = seatPick; clearInterval(timer); seatPick = null; closeSheet(); enterCloud(api, r.tableId, r.view); }
  } catch (e) { if (!quiet) toast(e.message); }
}
// The server says this device isn't at the table any more (someone took the seat over on another device).
function seatLost() {
  toast('Your seat was picked up on another device.', 6000);
  goHome();
}
$('#join').onclick = () => joinCode($('#code').value);
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode($('#code').value); });
$('#practice').onclick = () => {
  const name = getName(); if (!name) return;
  leaveServer();
  server = new LocalServer(name, Number($('#bots').value));
  view = null;
  server.watch(onView);
};

function enterCloud(api, code, v) {
  leaveServer();
  server = new CloudServer(api, code);
  store.set('table', code);
  const u = new URL(location.href); u.searchParams.set('t', code); history.replaceState(null, '', u);
  view = null;
  onView(v);
  server.watch(onView);
}
function clearUrl() { const u = new URL(location.href); u.searchParams.delete('t'); history.replaceState(null, '', u); }
function leaveServer() {
  if (server) server.stop();
  server = null; view = null; presence = {};
  closeSheet();
}
function goHome() {
  leaveServer();
  store.del('table');
  clearUrl();
  render();
}
async function leaveTable() {
  if (!server) return goHome();
  if (server.mode === 'cloud') {
    const midGame = view && view.phase !== 'lobby' && view.phase !== 'over';
    if (midGame && !confirm('Leave the game? The computer will play your seat. You can come back with the same link.')) return;
    try { await server.act({ type: 'leave' }); } catch (e) { /* leaving anyway */ }
  }
  goHome();
}
async function copyInvite() {
  const u = new URL(location.href);
  u.search = ''; u.searchParams.set('t', server.code);
  if (EMU) u.searchParams.set('emu', EMU);
  const link = u.toString();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Judgment', text: `Join my Judgment table: ${server.code}`, url: link }); return; } catch (e) { /* fall through to copy */ }
  }
  try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); }
  catch (e) { prompt('Copy this link:', link); }
}

// ---------- render ----------
function show(id) { for (const s of ['home', 'lobby', 'table']) $('#' + s).hidden = s !== id; }
function render() {
  if (!server || !view) { show('home'); $('#recon').hidden = true; return; }
  if (view.phase === 'lobby') { show('lobby'); renderLobby(view); } else { show('table'); renderTable(view); }
  autoSheets(view);
  if (ui.sheet) renderSheet();
  renderRecon();
}

function renderRecon() {
  const cloud = server && server.mode === 'cloud';
  const gone = cloud && (!navigator.onLine || Date.now() - lastOk > 10000);
  $('#recon').hidden = !gone;
  $('#recon-reload').hidden = !(gone && Date.now() - lastOk > 25000);
  $('#recon-msg').textContent = !navigator.onLine ? 'Your phone is offline. Your seat is saved.' : 'Lost the connection for a moment. Your seat is saved.';
}
setInterval(() => {
  if (!server) return;
  renderRecon();
  // Nothing heard for 12 seconds: restart the live listener and check in now.
  if (server.mode === 'cloud' && Date.now() - lastOk > 12000 && Date.now() - (server.kicked || 0) > 12000) {
    server.kicked = Date.now();
    server.relisten();
    server.schedule(0);
  }
}, 1000);
window.addEventListener('offline', () => renderRecon());
$('#recon-reload').onclick = () => location.reload();

// ---------- lobby ----------
function renderLobby(v) {
  const host = v.hostUid === v.me;
  const local = server.mode === 'local';
  $('#lobby-code').textContent = local ? 'Practice' : v.id;
  $('#copy-link').hidden = local;
  $('#lobby-count').textContent = `${v.players.length} of 8`;
  $('#lobby-players').innerHTML = v.players.map((p) => {
    const tags = [p.uid === v.hostUid ? '<span class="pill host">Host</span>' : '', p.uid === v.me ? '<span class="pill you">You</span>' : '', p.bot ? '<span class="pill">Computer</span>' : ''].join('');
    const online = p.bot || isOnline(p.uid);
    const rm = host && p.uid !== v.me ? `<button class="x" data-remove="${esc(p.uid)}" aria-label="Remove ${esc(p.name)}">&times;</button>` : '';
    return `<li><span class="dot ${online ? '' : 'off'}" title="${online ? 'Connected' : 'Not connected'}"></span><span class="pname">${esc(p.name)}</span>${tags}${rm}</li>`;
  }).join('');
  $('#host-tools').hidden = !host;
  $('#add-bot').disabled = v.players.length >= 8 || ui.busy;
  const start = $('#start');
  start.hidden = !host;
  start.disabled = v.players.length < 3 || ui.busy;
  const top = E.maxCardsFor(Math.max(3, v.players.length), v.settings);
  const rounds = E.buildSchedule(Math.max(3, v.players.length), v.settings).length;
  start.textContent = v.players.length < 3 ? `Need ${3 - v.players.length} more to deal` : `Deal (${rounds} rounds, starting at ${top} cards)`;
  $('#lobby-wait').textContent = host ? (local ? '' : 'Waiting for friends? Share the link. Computer players fill empty seats.') : 'Waiting for the host to deal.';
  renderSettings(v, host);
}
const SCHED = { down: 'Down', downup: 'Down and up', up: 'Up' };
const ORDER = { CSDH: 'Clubs, Spades, Diamonds, Hearts', SDCH: 'Spades, Diamonds, Clubs, Hearts' };
function renderSettings(v, host) {
  const s = v.settings;
  const n = Math.max(3, v.players.length);
  const top = E.maxCardsFor(n, s);
  if (!host) {
    $('#settings').innerHTML = `<ul class="set-read">
      <li>Rounds go ${SCHED[s.schedule].toLowerCase()}, biggest hand ${top} cards</li>
      <li>Trump order: ${ORDER[s.trumpOrder]}</li>
      <li>${s.hiddenBids ? 'Bids stay secret until everyone has bid' : 'Bids are shown as they are made'}</li>
      <li>${s.lastBidRule ? "Last bidder can't make the total equal the tricks" : 'No restriction on the last bid'}</li>
      <li>Exact bid scores ${s.base} + ${s.perTrick === 1 ? 'the bid' : s.perTrick + ' per trick bid'}${s.sweepBonus ? `, +${s.sweepBonus} for bidding and winning every trick` : ''}</li>
    </ul>`;
    return;
  }
  const seg = (key, opts) => `<div class="seg">${Object.entries(opts).map(([k, l]) => `<button type="button" data-set="${key}" data-val="${k}" class="${String(s[key]) === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const maxOpts = [];
  for (let c = 1; c <= 10; c++) maxOpts.push(`<option value="${c}" ${s.maxCards === c ? 'selected' : ''}>${c}</option>`);
  $('#settings').innerHTML = `<div class="set-grid">
    <div class="set-row"><label for="s-max">Biggest hand<small>${top < s.maxCards ? `Capped at ${top} for ${n} players` : 'Cards in the first round'}</small></label><select id="s-max" data-set="maxCards">${maxOpts.join('')}</select></div>
    <div class="set-row"><span class="lbl">Rounds<small>${s.schedule === 'downup' ? `${top} down to 1, back up to ${top}` : s.schedule === 'up' ? `1 up to ${top}` : `${top} down to 1`}</small></span>${seg('schedule', SCHED)}</div>
    <div class="set-row"><label for="s-order">Trump order<small>${ORDER[s.trumpOrder]}</small></label><select id="s-order" data-set="trumpOrder">${Object.keys(ORDER).map((k) => `<option value="${k}" ${s.trumpOrder === k ? 'selected' : ''}>${k === 'CSDH' ? 'Clubs first' : 'Spades first (Ka-Chu-Fu-L)'}</option>`).join('')}</select></div>
    <div class="set-row"><span class="lbl">Bids<small>${s.hiddenBids ? 'Secret until everyone has bid' : 'Shown as they are made'}</small></span>${seg('hiddenBids', { true: 'Secret', false: 'Open' })}</div>
    <div class="set-row"><span class="lbl">Last bidder rule<small>Total bids can't equal the tricks</small></span>${seg('lastBidRule', { true: 'On', false: 'Off' })}</div>
    <div class="set-row"><label for="s-base">Points for an exact bid<small>Plus the tricks you bid</small></label><input id="s-base" type="number" min="0" max="100" inputmode="numeric" data-set="base" value="${s.base}"></div>
    <div class="set-row"><label for="s-sweep">Sweep bonus<small>Bid every trick and win them all</small></label><input id="s-sweep" type="number" min="0" max="200" inputmode="numeric" data-set="sweepBonus" value="${s.sweepBonus}"></div>
  </div>`;
}
$('#settings').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-set]');
  if (!b) return;
  let val = b.dataset.val;
  if (val === 'true' || val === 'false') val = val === 'true';
  act({ type: 'settings', settings: { [b.dataset.set]: val } });
});
$('#settings').addEventListener('change', (e) => {
  const el = e.target.closest('[data-set]');
  if (!el) return;
  const k = el.dataset.set;
  const val = el.type === 'number' || k === 'maxCards' ? Number(el.value) : el.value;
  act({ type: 'settings', settings: { [k]: val } });
});
$('#lobby-players').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (b) act({ type: 'remove', uid: b.dataset.remove });
});
$('#add-bot').onclick = () => act({ type: 'addBot' });
$('#start').onclick = () => act({ type: 'start' });
$('#copy-link').onclick = copyInvite;
$('#lobby-leave').onclick = leaveTable;

// ---------- table ----------
function seatOrder(v) {
  const i = Math.max(0, v.players.findIndex((p) => p.uid === v.me));
  return v.players.slice(i).concat(v.players.slice(0, i));
}
function geometry(v) {
  const felt = $('#felt').getBoundingClientRect();
  const W = felt.width, H = felt.height;
  const wide = W >= 700;
  const order = seatOrder(v);
  const n = order.length;
  const pos = {};
  const crowded = n >= 6 && !wide;
  const tw = wide ? 70 : crowded ? 46 : 54;
  $('#felt').style.setProperty('--tw', tw + 'px');
  const cx = W / 2, cy = H * 0.5;
  order.forEach((p, k) => {
    const a = (Math.PI / 2) + (k * 2 * Math.PI) / n;
    const half = wide ? 62 : 48;
    const sx = Math.min(W - half, Math.max(half, cx + Math.cos(a) * W * (wide ? 0.42 : 0.38)));
    const sy = k === 0 ? H - 30 : Math.min(H - 56, Math.max(48, cy + Math.sin(a) * H * 0.4));
    // Each played card sits on the line from the middle toward its player, far enough in to clear their name.
    const dx = sx - cx, dy = sy - cy;
    const d = Math.hypot(dx, dy) || 1;
    const reserve = (wide ? 70 : 58) + tw * 0.85;
    const f = Math.min(0.62, Math.max(0.28, (d - reserve) / d));
    pos[p.uid] = { seat: { x: sx, y: sy }, card: { x: cx + dx * f, y: cy + dy * f } };
  });
  return pos;
}
function tallyHTML(v, p) {
  if (v.phase === 'bid') {
    if (p.hasBid) return `<span class="tally">${p.bid != null ? 'Bid ' + p.bid : 'Bid in'}</span>`;
    return `<span class="tally wait">${v.bidTurn === p.uid ? 'bidding' : 'to bid'}</span>`;
  }
  if (p.bid == null) return '';
  const cls = p.won === p.bid ? 'hit' : p.won > p.bid ? 'over' : '';
  return `<span class="tally ${cls}" title="Won ${p.won}, bid ${p.bid}">${p.won} of ${p.bid}</span>`;
}
function renderTable(v) {
  const r = v.round;
  $('#round-no').textContent = r ? `Round ${r.no}/${r.total}` : '';
  $('#round-sub').textContent = r ? `${r.cards} card${r.cards > 1 ? 's' : ''} each` : '';
  $('#trump').innerHTML = r ? `<span class="sym ${isRed(r.trump) ? 'red' : ''}">${SYM[r.trump]}</span><span class="tl"><small>Trump</small>${E.SUIT_NAME[r.trump]}</span>` : '';

  renderBidbox(v); // first, so the felt has its final size before seats are placed
  const pos = geometry(v);
  const order = seatOrder(v);
  const actor = v.phase === 'bid' ? v.bidTurn : v.phase === 'play' ? v.turn : null;
  $('#seats').innerHTML = order.slice(1).map((p) => {
    const g = pos[p.uid].seat;
    const away = !p.bot && !isOnline(p.uid);
    const flag = p.left ? 'left' : p.auto ? 'computer playing' : away ? 'away' : '';
    return `<div class="seat ${p.bot ? 'bot' : ''} ${actor === p.uid ? 'turn' : ''} ${away || p.left ? 'away' : ''}" style="left:${g.x}px;top:${g.y}px">
      <div class="avatar">${esc(p.name[0].toUpperCase())}${r && r.dealer === p.uid ? '<span class="dealer" title="Dealer">D</span>' : ''}${p.cards ? `<span class="mini-back" title="Cards left">${p.cards}</span>` : ''}</div>
      <div class="sname">${esc(p.name)}</div>
      <div class="stally">${tallyHTML(v, p)}<span class="sflag">${p.score} pts</span></div>
      ${flag ? `<div class="sflag">${flag}</div>` : ''}
    </div>`;
  }).join('');

  // trick in the middle
  const trickEl = $('#trick');
  const cards = ui.show && !v.trick.length ? ui.show.cards : v.trick;
  const winner = ui.show && !v.trick.length ? ui.show.winner : null;
  const html = cards.map((t) => {
    const g = pos[t.uid]; if (!g) return '';
    const key = `${r ? r.no : 0}-${t.card}`;
    const fresh = !ui.trickSeen.has(key);
    ui.trickSeen.add(key);
    return `<div class="tcard ${fresh ? 'enter' : ''} ${winner === t.uid ? 'win' : ''}" style="left:${g.card.x}px;top:${g.card.y}px;--fx:${g.seat.x - g.card.x}px;--fy:${g.seat.y - g.card.y}px">${cardHTML(t.card, r && r.trump)}</div>`;
  }).join('');
  let label = '';
  if (!cards.length && v.phase === 'play') {
    const lead = v.players.find((p) => p.uid === v.turn);
    label = lead ? (lead.uid === v.me ? 'Your lead' : `${esc(lead.name)} leads`) : '';
  } else if (!cards.length && v.phase === 'bid') {
    label = 'Bidding';
  }
  trickEl.innerHTML = html + (label ? `<div class="trick-label">${label}</div>` : '');
  if (ui.trickSeen.size > 200) ui.trickSeen = new Set([...ui.trickSeen].slice(-60));

  // status line
  const me = v.players.find((p) => p.uid === v.me);
  const st = $('#status');
  let msg = '', mine = false;
  if (ui.show && !v.trick.length) {
    const w = v.players.find((p) => p.uid === ui.show.winner);
    msg = w.uid === v.me ? 'You win the trick' : `${esc(w.name)} wins the trick`;
  } else if (v.phase === 'bid') {
    if (v.bidTurn === v.me) { msg = 'Your bid'; mine = true; }
    else { const b = v.players.find((p) => p.uid === v.bidTurn); msg = b.bot || b.auto ? `${esc(b.name)} is thinking` : `Waiting for ${esc(b.name)} to bid`; }
  } else if (v.phase === 'play') {
    if (v.turn === v.me) {
      mine = true;
      if (ui.sel) msg = 'Tap it again to play';
      else if (!v.trick.length) msg = 'Your lead. Play any card.';
      else { const led = v.trick[0].card[1]; msg = v.hand.some((c) => c[1] === led) ? `Your turn. Follow ${E.SUIT_NAME[led]}.` : `Your turn. No ${E.SUIT_NAME[led]}, play anything.`; }
    } else { const t = v.players.find((p) => p.uid === v.turn); msg = `${esc(t.name)} to play`; }
  } else if (v.phase === 'roundEnd') msg = 'Round over';
  else if (v.phase === 'over') msg = 'Game over';
  if (me && me.auto && !['roundEnd', 'over'].includes(v.phase)) msg = 'The computer is playing for you. Tap any legal move to take back over.';
  if (ui.busy && mine) msg = 'Sending...';
  st.innerHTML = msg;
  st.className = 'status' + (mine ? ' mine' : '');

  // me strip
  const dealerMe = r && r.dealer === v.me ? ' <span class="pill">Dealer</span>' : '';
  $('#me-strip').innerHTML = me ? `<strong>${esc(me.name)}</strong>${dealerMe}${tallyHTML(v, me)}<span>${me.score} pts</span>` : '';

  renderHand(v);
}
function renderBidbox(v) {
  const box = $('#bidbox');
  if (v.phase !== 'bid' || v.bidTurn !== v.me) { box.hidden = true; return; }
  box.hidden = false;
  const r = v.round;
  const all = [];
  for (let b = 0; b <= r.cards; b++) all.push(b);
  const blocked = all.filter((b) => !v.legalBids.includes(b));
  const others = v.players.filter((p) => p.uid !== v.me && p.hasBid && p.bid != null);
  let why = v.settings.hiddenBids ? 'Other bids stay secret until everyone has bid.' : (others.length ? `Bid so far: ${others.reduce((a, p) => a + p.bid, 0)} of ${r.cards}.` : 'You bid first.');
  if (blocked.length) why = `You bid last, so the total can't be ${r.cards}. ${blocked[0]} is off.`;
  const rows = Math.ceil(all.length / 6);
  box.innerHTML = `<h3>How many tricks will you take?</h3>
    <div class="bids" style="grid-template-columns:repeat(${Math.ceil(all.length / rows)},1fr)">${all.map((b) => `<button type="button" data-bid="${b}" ${blocked.includes(b) || ui.busy ? 'disabled' : ''}>${b}</button>`).join('')}</div>
    <p class="why">${why}</p>`;
}
$('#bidbox').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bid]');
  if (b && view) act({ type: 'bid', n: Number(b.dataset.bid), move: view.moveNo });
});
function renderHand(v) {
  const hand = $('#hand');
  const n = v.hand.length;
  const W = hand.getBoundingClientRect().width || window.innerWidth - 16;
  const wide = window.innerWidth >= 760;
  const cw = Math.round(Math.max(52, Math.min(wide ? 100 : 84, n <= 1 ? 84 : (W - 4) / (1 + (n - 1) * 0.5))));
  const showFrac = n <= 1 ? 1 : Math.min(wide ? 0.78 : 0.62, (W - 4 - cw) / ((n - 1) * cw));
  document.documentElement.style.setProperty('--cw', cw + 'px');
  hand.style.setProperty('--ov', `${-Math.round(cw * (1 - showFrac))}px`);
  const r = v.round;
  const myTurn = v.phase === 'play' && v.turn === v.me;
  const dealKey = `${v.id}-${r ? r.no : 0}`;
  const dealing = dealKey !== ui.dealKey;
  ui.dealKey = dealKey;
  hand.classList.toggle('myturn', myTurn);
  if (!n) { hand.innerHTML = v.phase === 'play' || v.phase === 'bid' ? '' : '<span class="hand-empty">No cards</span>'; return; }
  hand.innerHTML = v.hand.map((c, i) => {
    const legal = v.legalCards.includes(c);
    const cls = ['hc', myTurn ? (legal ? 'legal' : 'dim') : '', ui.sel === c ? 'sel' : '', dealing ? 'deal' : ''].join(' ');
    return `<button type="button" class="${cls}" data-card="${c}" style="--i:${i}" aria-label="${E.cardLabel(c)}${myTurn && !legal ? ' (cannot play)' : ''}">${cardHTML(c, r && r.trump)}</button>`;
  }).join('');
}
$('#hand').addEventListener('click', (e) => {
  const b = e.target.closest('[data-card]');
  if (!b || !view) return;
  const c = b.dataset.card;
  const v = view;
  if (v.phase === 'bid') { toast(v.bidTurn === v.me ? 'Pick your bid first.' : 'Wait for bidding to finish.'); return; }
  if (v.phase !== 'play') return;
  if (v.turn !== v.me) { toast('Not your turn yet.'); return; }
  if (!v.legalCards.includes(c)) {
    const led = v.trick[0].card[1];
    toast(`You have ${E.SUIT_NAME[led]}, so you must play ${E.SUIT_NAME[led]}.`);
    return;
  }
  if (ui.sel === c) { ui.sel = null; act({ type: 'play', card: c, move: v.moveNo }); }
  else { ui.sel = c; render(); }
});
document.addEventListener('click', (e) => {
  // composedPath is fixed when the tap happens, so it still knows the tap was in the hand after the hand re-renders.
  if (ui.sel && !e.composedPath().some((el) => el.id === 'hand')) { ui.sel = null; render(); }
});
window.addEventListener('resize', () => { if (view) render(); });

// ---------- sheets ----------
function openSheet(kind) { ui.sheet = kind; renderSheet(); }
function closeSheet() { ui.sheet = null; $('#sheet').hidden = true; $('#scrim').hidden = true; }
$('#scrim').onclick = () => { if (ui.sheet !== 'over') closeSheet(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.sheet && ui.sheet !== 'over') closeSheet(); });
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) openSheet(o.dataset.open);
  if (e.target.closest('[data-close]')) closeSheet();
});
function autoSheets(v) {
  if (v.phase === 'roundEnd' || v.phase === 'over') {
    const key = `${v.id}-${v.phase}-${v.history.length}`;
    if (ui.resultSeen !== key && !ui.show) {
      ui.resultSeen = key;
      ui.sheet = v.phase === 'over' ? 'over' : 'result';
    }
  } else if (ui.sheet === 'result' || ui.sheet === 'over') {
    closeSheet();
  }
}
const nameOf = (v, uid) => { const p = v.players.find((x) => x.uid === uid); return p ? p.name : '?'; };
function renderSheet() {
  const v = view;
  if (!v && ui.sheet !== 'rules' && ui.sheet !== 'seat') { closeSheet(); return; }
  $('#sheet').hidden = false;
  $('#scrim').hidden = false;
  const body = $('#sheet-body');
  const close = '<button class="btn slim ghost" data-close type="button">Close</button>';
  if (ui.sheet === 'rules') body.innerHTML = rulesHTML(close);
  else if (ui.sheet === 'seat') body.innerHTML = seatHTML(close);
  else if (ui.sheet === 'scores') body.innerHTML = `<div class="sheet-head"><h2>Scores</h2>${close}</div>${leaderHTML(v)}<h3>Round by round</h3>${gridHTML(v)}`;
  else if (ui.sheet === 'result') body.innerHTML = resultHTML(v);
  else if (ui.sheet === 'over') body.innerHTML = overHTML(v);
  else if (ui.sheet === 'menu') body.innerHTML = menuHTML(v, close);
}
function leaderHTML(v) {
  const rows = v.players.slice().sort((a, b) => b.score - a.score);
  const top = rows[0] ? rows[0].score : 0;
  return `<div class="podium">${rows.map((p, i) => `<div class="pl ${p.score === top && top > 0 ? 'first' : ''}"><span class="rank">${i + 1}</span><span class="nm">${esc(p.name)}${p.uid === v.me ? ' (you)' : ''}</span><span class="sc">${p.score}</span></div>`).join('')}</div>`;
}
function gridHTML(v) {
  if (!v.history.length) return '<p class="note">No rounds finished yet.</p>';
  const ps = v.players;
  const head = `<tr><th>Round</th>${ps.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr>`;
  const rows = v.history.map((h) => `<tr><td>${h.no} <span class="cell-sub">${h.cards} ${suitTag(h.trump)}</span></td>${ps.map((p) => {
    const c = h.rows[p.uid]; if (!c) return '<td></td>';
    return `<td class="${c.pts ? 'hit' : 'miss'}">${c.pts}<span class="cell-sub">${c.won} of ${c.bid}</span></td>`;
  }).join('')}</tr>`).join('');
  const tot = `<tr class="tot"><td>Total</td>${ps.map((p) => `<td>${p.score}</td>`).join('')}</tr>`;
  return `<div class="grid-wrap"><table class="grid"><thead>${head}</thead><tbody>${rows}${tot}</tbody></table></div>`;
}
function resultHTML(v) {
  const h = v.history[v.history.length - 1];
  const rows = v.players.map((p) => ({ p, c: h.rows[p.uid] })).sort((a, b) => b.p.score - a.p.score);
  const me = v.players.find((p) => p.uid === v.me);
  const waiting = v.players.filter((p) => !p.bot && !p.auto && !p.left && !v.ready.includes(p.uid));
  const imReady = v.ready.includes(v.me) || (me && me.auto);
  const next = v.round && v.round.no < v.round.total ? h.cards : null;
  return `<div class="sheet-head"><h2>Round ${h.no} done</h2><button class="btn slim ghost" data-open="scores" type="button">All rounds</button></div>
    <p class="sub">${h.cards} card${h.cards > 1 ? 's' : ''}, trump ${suitTag(h.trump)} ${E.SUIT_NAME[h.trump]}</p>
    <table class="res"><thead><tr><th>Player</th><th class="n">Bid</th><th class="n">Won</th><th class="n">Points</th><th class="n">Total</th></tr></thead>
    <tbody>${rows.map(({ p, c }) => `<tr class="${p.uid === v.me ? 'me' : ''}"><td>${esc(p.name)}</td><td class="n">${c.bid}</td><td class="n">${c.won}</td><td class="n pts ${c.pts ? 'hit' : 'miss'}">${c.pts ? '+' + c.pts : '0'}</td><td class="n">${p.score}</td></tr>`).join('')}</tbody></table>
    ${imReady ? `<p class="note">${waiting.length ? 'Waiting for ' + waiting.map((p) => esc(p.name)).join(', ') : 'Dealing'}</p>` : `<button class="btn primary big" id="ready" type="button" ${ui.busy ? 'disabled' : ''}>Next round${next ? '' : ''}</button>`}
    ${v.hostUid === v.me && waiting.length && imReady ? '<button class="btn" id="force" type="button">Deal now without waiting</button>' : ''}`;
}
function overHTML(v) {
  const rows = v.players.slice().sort((a, b) => b.score - a.score);
  const top = rows[0].score;
  const winners = rows.filter((p) => p.score === top);
  const title = winners.length > 1 ? `Tie: ${winners.map((p) => esc(p.name)).join(' and ')}` : `${winners[0].uid === v.me ? 'You win' : esc(winners[0].name) + ' wins'}`;
  const host = v.hostUid === v.me;
  return `<div class="sheet-head"><h2>${title}</h2></div><p class="sub">${top} points after ${v.history.length} rounds</p>
    ${leaderHTML(v)}<h3>Round by round</h3>${gridHTML(v)}
    <div class="row">${host ? '<button class="btn primary big" id="rematch" type="button">Rematch</button>' : '<p class="note">Waiting for the host to start a rematch.</p>'}<button class="btn" id="over-leave" type="button">Leave table</button></div>`;
}
function menuHTML(v, close) {
  const me = v.players.find((p) => p.uid === v.me);
  const host = v.hostUid === v.me;
  const cloud = server.mode === 'cloud';
  const items = [];
  items.push('<button class="btn" data-open="scores" type="button">Scores</button>');
  items.push('<button class="btn" data-open="rules" type="button">How to play</button>');
  if (cloud) items.push('<button class="btn" id="m-invite" type="button">Copy invite link</button>');
  if (me && !['over', 'lobby'].includes(v.phase)) {
    items.push(me.auto ? '<button class="btn" data-auto="0" type="button">I\'ll play myself again</button>' : '<button class="btn" data-auto="1" type="button">Let the computer play for me</button>');
  }
  if (cloud && host && v.phase !== 'over') {
    for (const p of v.players) {
      if (p.bot || p.uid === v.me || p.auto || isOnline(p.uid)) continue;
      items.push(`<button class="btn" data-auto-for="${esc(p.uid)}" type="button">${esc(p.name)} is away. Let the computer play for them</button>`);
    }
  }
  const hostP = v.players.find((p) => p.uid === v.hostUid);
  if (cloud && !host && (!hostP || hostP.left || !isOnline(v.hostUid))) items.push('<button class="btn" id="m-claim" type="button">Host is away. Become host</button>');
  items.push('<button class="btn" id="m-leave" type="button">Leave table</button>');
  return `<div class="sheet-head"><h2>Table ${cloud ? esc(v.id) : ''}</h2>${close}</div>
    <p class="sub">Host: ${esc(nameOf(v, v.hostUid))}</p>
    <div class="menu-list">${items.join('')}</div>`;
}
function seatHTML(close) {
  const seats = (seatPick && seatPick.seats) || [];
  const list = seats.length
    ? `<div class="menu-list">${seats.map((p) => `<button class="btn" data-claim="${esc(p.uid)}" type="button">I'm ${esc(p.name)}</button>`).join('')}</div>`
    : '<p class="note">Every seat is still connected. If one is yours on another phone or browser, close it there. Your seat shows up here within about 20 seconds.</p>';
  return `<div class="sheet-head"><h2>Game in progress</h2>${close}</div>
    <p class="sub">Table ${esc(seatPick ? seatPick.code : '')}. If you were playing and got kicked out, pick your seat. You keep your cards and score.</p>
    ${list}
    <button class="btn ghost" id="seat-refresh" type="button">Check again</button>
    <p class="note">New players can join when the host starts a rematch.</p>`;
}
function rulesHTML(close) {
  return `<div class="sheet-head"><h2>How to play</h2>${close}</div>
  <ol class="rules">
    <li>Everyone gets the same number of cards. The first round has the most, then it drops by one each round (your host can change this).</li>
    <li>Trump changes every round: Clubs, Spades, Diamonds, Hearts, then around again. It's always shown at the top.</li>
    <li>Look at your hand and bid how many tricks you'll win. Bids go round the table starting left of the dealer. By default nobody sees the bids until everyone has bid.</li>
    <li>The dealer bids last and can't make the bids add up to the number of cards. Somebody has to miss.</li>
    <li>Left of the dealer leads the first trick. Follow the suit that was led if you can. If you can't, play anything, including a trump.</li>
    <li>Highest trump wins the trick. No trump played: highest card of the suit led wins. Ace is high. The winner leads next.</li>
    <li>Win exactly what you bid and you score 10 plus your bid. Bid 0 and take nothing: 10. Miss by any amount: 0. Bid every trick and take them all: 30 extra.</li>
    <li>On the table, "1 of 2" means won 1, bid 2. Highest total after the last round wins.</li>
  </ol>`;
}
$('#sheet').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.claim) { claimSeat(t.dataset.claim); return; }
  if (t.id === 'seat-refresh') { refreshSeats(); return; }
  if (t.id === 'ready') act({ type: 'ready' });
  else if (t.id === 'force') act({ type: 'forceNext' });
  else if (t.id === 'rematch') { if (await act({ type: 'rematch' })) closeSheet(); }
  else if (t.id === 'over-leave' || t.id === 'm-leave') { closeSheet(); leaveTable(); }
  else if (t.id === 'm-invite') copyInvite();
  else if (t.id === 'm-claim') { if (await act({ type: 'claimHost' })) { toast("You're the host now."); closeSheet(); } }
  else if (t.dataset.auto) { if (await act({ type: 'autopilot', on: t.dataset.auto === '1' })) closeSheet(); }
  else if (t.dataset.autoFor) { if (await act({ type: 'autopilot', uid: t.dataset.autoFor, on: true })) closeSheet(); }
});
// Tapping a move while on autopilot takes your seat back (the server does the switch).

// ---------- start up ----------
render();
const savedTable = store.get('table', null);
const linkCode = params.get('t');
if (firebaseConfig && (linkCode || savedTable) && store.get('name', '')) {
  // Coming back after a refresh, or opening an invite link with a saved name: go straight in.
  joinCode(linkCode || savedTable, !linkCode || linkCode === savedTable);
}

// Everything the online server does, kept apart from Firebase setup so it can be tested without Firebase.
// Storage layout (collection jtables):
//   jtables/{code}                  public summary: phase, host, seat count. No cards.
//   jtables/{code}/secret/state     full game, deck and every hand. Nobody's browser can read this.
//   jtables/{code}/views/{uid}      what that one player is allowed to see. Only that player can read it.
//   jtables/{code}/presence/{uid}   "last seen" time for each player, stamped by the server when they check in.
import * as E from './engine.js';

export const COL = 'jtables';
export const EXPIRE_MS = 24 * 60 * 60 * 1000;
export const CLAIM_AWAY_MS = 22000; // a seat can move to a new device once its old one has been quiet this long

export function makeServer(db, { stamp = (now) => new Date(now ?? Date.now()) } = {}) {
  const tableRef = (id) => db.collection(COL).doc(id);
  const stateRef = (id) => tableRef(id).collection('secret').doc('state');
  const presRef = (id, uid) => tableRef(id).collection('presence').doc(uid);

  function writeState(tx, st) {
    const t = tableRef(st.id);
    tx.set(stateRef(st.id), { json: JSON.stringify(st) });
    tx.set(t, { id: st.id, phase: st.phase, hostUid: st.hostUid, seated: st.players.length, updatedAt: stamp() });
    for (const p of st.players) if (!p.bot) tx.set(t.collection('views').doc(p.uid), { json: JSON.stringify(E.viewFor(st, p.uid)) });
  }

  const toMs = (at) => (at && typeof at.toMillis === 'function' ? at.toMillis() : Number(at) || 0);
  async function readPresence(getter, id) {
    const snap = await getter(tableRef(id).collection('presence'));
    const out = {};
    for (const d of snap.docs) out[d.id] = toMs(d.data().at);
    return out;
  }
  // Server-side "still here" stamp. Uses the server's own clock so a phone with a wrong clock can't fake it.
  async function ping(id, uid, now) {
    try { await presRef(id, uid).set({ at: stamp(now) }); } catch (e) { /* presence is best effort */ }
  }

  const cleanId = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  function load(snap, now) {
    if (!snap.exists) throw new Error('No table with that code. Check it and try again.');
    const st = JSON.parse(snap.data().json);
    if (now - (st.lastActive || 0) > EXPIRE_MS) throw new Error('That table expired. Start a new one.');
    return st;
  }
  const out = (st, uid, now, extra = {}) => { st.now = now; return { ok: true, tableId: st.id, view: E.viewFor(st, uid), ...extra }; };

  // Seats a newcomer could take over mid-game: humans whose device has gone quiet, or who left.
  function openSeats(st, presence, now) {
    return st.players
      .filter((p) => !p.bot && (p.left || now - (presence[p.uid] || 0) > CLAIM_AWAY_MS))
      .map((p) => ({ uid: p.uid, name: p.name }));
  }

  async function handle(uid, d, now = Date.now()) {
    if (!uid) throw new Error('Sign in first.');
    d = d || {};

    if (d.op === 'create') {
      for (let k = 0; k < 8; k++) {
        const id = E.makeCode(5);
        const res = await db.runTransaction(async (tx) => {
          const snap = await tx.get(stateRef(id));
          if (snap.exists) return null;
          const st = E.createTable(id, uid, d.name);
          st.lastActive = now;
          writeState(tx, st);
          return out(st, uid, now);
        });
        if (res) { await ping(res.tableId, uid, now); return res; }
      }
      throw new Error('Could not make a table code. Try again.');
    }

    const id = cleanId(d.tableId);
    if (!id) throw new Error('Type the table code.');

    // Check-in: the fast path every open browser calls every few seconds.
    // A plain read, no lock, so it never slows down anyone's move. Only takes the lock when a computer seat is due to move.
    if (d.op === 'view' || d.op === 'tick') {
      const st = load(await stateRef(id).get(), now);
      if (!st.players.some((p) => p.uid === uid)) throw new Error('You are not at this table.');
      if (d.ping) await ping(id, uid, now);
      if (!E.botsDue(st, now)) return out(st, uid, now);
      return db.runTransaction(async (tx) => {
        const fresh = load(await tx.get(stateRef(id)), now);
        let changed = false;
        for (let i = 0; i < 3; i++) { if (E.runBots(fresh, now)) changed = true; else break; }
        if (changed) writeState(tx, fresh);
        return out(fresh, uid, now);
      });
    }

    const res = await db.runTransaction(async (tx) => {
      const st = load(await tx.get(stateRef(id)), now);
      const seated = st.players.some((p) => p.uid === uid);
      let changed = false;

      if (d.op === 'join') {
        if (!seated && st.phase !== 'lobby') {
          // Game already going and this device isn't seated. Offer the seats whose owners have gone quiet.
          const presence = await readPresence((r) => tx.get(r), id);
          return { ok: false, needSeat: true, tableId: id, seats: openSeats(st, presence, now), error: 'This game already started.' };
        }
        const before = st.seq;
        E.joinTable(st, uid, d.name);
        changed = st.seq !== before;
      } else if (d.op === 'claim') {
        if (seated) return out(st, uid, now);
        const target = st.players.find((p) => p.uid === d.seatUid);
        if (!target || target.bot) throw new Error('That seat is gone. Ask the host.');
        const presence = await readPresence((r) => tx.get(r), id);
        if (!target.left && now - (presence[target.uid] || 0) <= CLAIM_AWAY_MS) {
          throw new Error(`${target.name}'s seat is still connected on another device. Close it there, wait half a minute and try again.`);
        }
        E.renameSeat(st, target.uid, uid);
        changed = true;
      } else if (d.op === 'act') {
        if (!seated) throw new Error('You are not at this table.');
        const a = d.action || {};
        // Same request sent twice (double tap, retry after a slow network): do it once.
        if (a.rid && st.rids && st.rids[uid] === a.rid) return out(st, uid, now, { dup: true });
        // A move made from an old screen: refuse it and send the current table.
        if ((a.type === 'bid' || a.type === 'play') && a.move != null && a.move !== st.moveNo) {
          return out(st, uid, now, { ok: false, stale: true, error: 'The table moved on. Here is the latest, try again.' });
        }
        const presence = a.type === 'autopilot' || a.type === 'claimHost' ? await readPresence((r) => tx.get(r), id) : {};
        E.dispatch(st, uid, a, now, presence);
        st.rids = st.rids || {};
        if (a.rid) st.rids[uid] = String(a.rid).slice(0, 40);
        changed = true;
      } else {
        throw new Error('Unknown request.');
      }

      for (let i = 0; i < 3; i++) { if (E.runBots(st, now)) changed = true; else break; }
      if (changed) { st.lastActive = now; writeState(tx, st); }
      return out(st, uid, now);
    });
    if (res.ok && (d.op === 'join' || d.op === 'claim')) await ping(id, uid, now);
    return res;
  }

  return { handle };
}

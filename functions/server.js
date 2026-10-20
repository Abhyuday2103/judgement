// Everything the online server does, kept apart from Firebase setup so it can be tested without Firebase.
// Storage layout (collection jtables):
//   jtables/{code}                  public summary: phase, host, seat count. No cards.
//   jtables/{code}/secret/state     full game, deck and every hand. Nobody's browser can read this.
//   jtables/{code}/views/{uid}      what that one player is allowed to see. Only that player can read it.
//   jtables/{code}/presence/{uid}   "last seen" ping each browser writes about itself.
import * as E from './engine.js';

export const COL = 'jtables';
export const EXPIRE_MS = 24 * 60 * 60 * 1000;

export function makeServer(db, { stamp = () => new Date() } = {}) {
  const tableRef = (id) => db.collection(COL).doc(id);
  const stateRef = (id) => tableRef(id).collection('secret').doc('state');

  function writeState(tx, st) {
    const t = tableRef(st.id);
    tx.set(stateRef(st.id), { json: JSON.stringify(st) });
    tx.set(t, { id: st.id, phase: st.phase, hostUid: st.hostUid, seated: st.players.length, updatedAt: stamp() });
    for (const p of st.players) if (!p.bot) tx.set(t.collection('views').doc(p.uid), { json: JSON.stringify(E.viewFor(st, p.uid)) });
  }

  async function readPresence(tx, id) {
    const snap = await tx.get(tableRef(id).collection('presence'));
    const out = {};
    for (const d of snap.docs) {
      const at = d.data().at;
      out[d.id] = at && typeof at.toMillis === 'function' ? at.toMillis() : Number(at) || 0;
    }
    return out;
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
          st.now = now;
          writeState(tx, st);
          return { tableId: id, view: E.viewFor(st, uid) };
        });
        if (res) return { ok: true, ...res };
      }
      throw new Error('Could not make a table code. Try again.');
    }

    const id = String(d.tableId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!id) throw new Error('Type the table code.');

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef(id));
      if (!snap.exists) throw new Error('No table with that code. Check it and try again.');
      const st = JSON.parse(snap.data().json);
      if (now - (st.lastActive || 0) > EXPIRE_MS) throw new Error('That table expired. Start a new one.');
      const seated = st.players.some((p) => p.uid === uid);
      let changed = false;
      const reply = (extra = {}) => { st.now = now; return { ok: true, tableId: id, view: E.viewFor(st, uid), ...extra }; };

      if (d.op === 'join') {
        const before = st.seq;
        E.joinTable(st, uid, d.name);
        changed = st.seq !== before;
        if (changed) st.lastActive = now;
      } else if (d.op === 'act') {
        if (!seated) throw new Error('You are not at this table.');
        const a = d.action || {};
        // Same request sent twice (double tap, retry after a slow network): do it once.
        if (a.rid && st.rids && st.rids[uid] === a.rid) return reply({ dup: true });
        // A move made from an old screen: refuse it and send the current table.
        if ((a.type === 'bid' || a.type === 'play') && a.move != null && a.move !== st.moveNo) {
          return reply({ ok: false, stale: true, error: 'The table moved on. Here is the latest, try again.' });
        }
        const presence = a.type === 'autopilot' || a.type === 'claimHost' ? await readPresence(tx, id) : {};
        E.dispatch(st, uid, a, now, presence);
        st.rids = st.rids || {};
        if (a.rid) st.rids[uid] = String(a.rid).slice(0, 40);
        changed = true;
      } else if (d.op === 'view' || d.op === 'tick') {
        if (!seated) throw new Error('You are not at this table.');
      } else {
        throw new Error('Unknown request.');
      }

      // Computer players and autopilot seats: make whatever moves are due.
      for (let i = 0; i < 3; i++) { if (E.runBots(st, now)) changed = true; else break; }
      st.now = now;
      if (changed) writeState(tx, st);
      return reply();
    });
  }

  return { handle };
}

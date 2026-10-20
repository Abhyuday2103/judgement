// Online server tests against an in-memory stand-in for Firestore. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, COL } from '../functions/server.js';

// Tiny fake of the Firestore calls the server uses. Transactions run one at a time, like Firestore retries make them behave.
function fakeDb() {
  const data = new Map();
  let queue = Promise.resolve();
  const ref = (path) => ({
    path,
    collection: (c) => col(path + '/' + c),
  });
  const col = (path) => ({
    path, isCol: true,
    doc: (id) => ({ ...ref(path + '/' + id), id }),
  });
  const tx = {
    async get(r) {
      if (r.isCol) {
        const docs = [...data.entries()].filter(([k]) => k.startsWith(r.path + '/') && !k.slice(r.path.length + 1).includes('/'))
          .map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        return { docs };
      }
      const v = data.get(r.path);
      return { exists: v !== undefined, data: () => v };
    },
    set(r, v) { data.set(r.path, structuredClone(v)); },
  };
  return {
    data,
    collection: (c) => col(c),
    runTransaction(fn) {
      const run = queue.then(() => {
        const snapshot = new Map(data);
        return fn(tx).catch((e) => { data.clear(); for (const [k, v] of snapshot) data.set(k, v); throw e; });
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

async function setup(n = 3) {
  const db = fakeDb();
  const s = makeServer(db);
  const r = await s.handle('u0', { op: 'create', name: 'Host' });
  const id = r.tableId;
  for (let i = 1; i < n; i++) await s.handle('u' + i, { op: 'join', tableId: id, name: 'P' + i });
  return { db, s, id };
}
const views = (db, id) => [...db.data.entries()].filter(([k]) => k.startsWith(`${COL}/${id}/views/`));

test('create and join over the server, lowercase code works', async () => {
  const { s, id } = await setup(2);
  const r = await s.handle('u2', { op: 'join', tableId: id.toLowerCase(), name: 'Third' });
  assert.equal(r.view.players.length, 3);
  await assert.rejects(s.handle('u9', { op: 'join', tableId: 'NOPE1', name: 'X' }), /No table/);
  await assert.rejects(s.handle(null, { op: 'join', tableId: id, name: 'X' }), /Sign in/);
});

test('each stored view holds only its owner\'s cards; the full deal sits in secret', async () => {
  const { db, s, id } = await setup(4);
  await s.handle('u0', { op: 'act', tableId: id, action: { type: 'start' } });
  const st = JSON.parse(db.data.get(`${COL}/${id}/secret/state`).json);
  for (const [path, doc] of views(db, id)) {
    const owner = path.split('/').pop();
    const v = JSON.parse(doc.json);
    assert.equal(v.me, owner);
    for (const p of st.players) {
      if (p.uid === owner) continue;
      for (const c of st.hands[p.uid]) assert.ok(!doc.json.includes('"' + c + '"'), `${owner}'s view leaks ${p.uid}'s ${c}`);
    }
  }
  const pub = JSON.stringify(db.data.get(`${COL}/${id}`));
  assert.ok(!/"[2-9TJQKA][SHDC]"/.test(pub), 'public table doc has no cards');
});

test('outsiders cannot read or act at a table, even knowing the code', async () => {
  const { s, id } = await setup(3);
  await assert.rejects(s.handle('stranger', { op: 'view', tableId: id }), /not at this table/);
  await assert.rejects(s.handle('stranger', { op: 'act', tableId: id, action: { type: 'start' } }), /not at this table/);
});

test('you cannot act for someone else: the server uses your sign-in, not what you send', async () => {
  const { db, s, id } = await setup(3);
  await s.handle('u0', { op: 'act', tableId: id, action: { type: 'start' } });
  const st = JSON.parse(db.data.get(`${COL}/${id}/secret/state`).json);
  const bidder = st.players[st.bidTurn].uid;
  const other = st.players.find((p) => p.uid !== bidder).uid;
  await assert.rejects(s.handle(other, { op: 'act', tableId: id, action: { type: 'bid', n: 0, uid: bidder } }), /not your turn/);
});

test('duplicate taps count once; moves from an old screen are refused', async () => {
  const { db, s, id } = await setup(3);
  await s.handle('u0', { op: 'act', tableId: id, action: { type: 'start' } });
  let st = JSON.parse(db.data.get(`${COL}/${id}/secret/state`).json);
  const bidder = st.players[st.bidTurn].uid;
  const a = { type: 'bid', n: 0, rid: 'r1', move: st.moveNo };
  const [r1, r2] = await Promise.all([
    s.handle(bidder, { op: 'act', tableId: id, action: a }),
    s.handle(bidder, { op: 'act', tableId: id, action: a }),
  ]);
  assert.ok(r1.ok && r2.ok && r2.dup);
  st = JSON.parse(db.data.get(`${COL}/${id}/secret/state`).json);
  assert.equal(Object.keys(st.bids).length, 1);
  const next = st.players[st.bidTurn].uid;
  const r3 = await s.handle(next, { op: 'act', tableId: id, action: { type: 'bid', n: 0, rid: 'r2', move: st.moveNo - 1 } });
  assert.equal(r3.ok, false);
  assert.ok(r3.stale);
});

test('everyone taps at once from the same screen: exactly one move counts', async () => {
  const { db, s, id } = await setup(3);
  await s.handle('u0', { op: 'act', tableId: id, action: { type: 'start' } });
  const st = JSON.parse(db.data.get(`${COL}/${id}/secret/state`).json);
  const move = st.moveNo;
  const results = await Promise.allSettled(st.players.map((p) => s.handle(p.uid, { op: 'act', tableId: id, action: { type: 'bid', n: 0, rid: 'x' + p.uid, move } })));
  const after = JSON.parse(db.data.get(`${COL}/${id}/secret/state`).json);
  assert.equal(Object.keys(after.bids).length, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.ok).length, 1);
  for (const r of results) {
    if (r.status === 'rejected') assert.match(r.reason.message, /not your turn/);
    else if (!r.value.ok) assert.ok(r.value.stale);
  }
});

test('reconnect: a seated player rejoining gets their seat and hand back', async () => {
  const { s, id } = await setup(3);
  const started = await s.handle('u0', { op: 'act', tableId: id, action: { type: 'start' } });
  const again = await s.handle('u0', { op: 'join', tableId: id, name: 'Host' });
  assert.deepEqual(again.view.hand, started.view.hand);
  await assert.rejects(s.handle('late', { op: 'join', tableId: id, name: 'Late' }), /already started/);
});

test('a whole online game finishes when everyone is on autopilot', async () => {
  const { db, s, id } = await setup(3);
  await s.handle('u0', { op: 'act', tableId: id, action: { type: 'settings', settings: { maxCards: 3 } } });
  await s.handle('u0', { op: 'act', tableId: id, action: { type: 'start' } });
  for (const u of ['u0', 'u1', 'u2']) await s.handle(u, { op: 'act', tableId: id, action: { type: 'autopilot', on: true } });
  let t = Date.now(), v;
  for (let i = 0; i < 400; i++) {
    t += 2000;
    v = (await s.handle('u0', { op: 'tick', tableId: id }, t)).view;
    if (v.phase === 'over') break;
  }
  assert.equal(v.phase, 'over');
  assert.equal(v.history.length, 3);
  assert.ok(db.data.get(`${COL}/${id}`).phase === 'over');
});

test('old tables expire', async () => {
  const { s, id } = await setup(3);
  await assert.rejects(s.handle('u0', { op: 'view', tableId: id }, Date.now() + 25 * 3600 * 1000), /expired/);
});

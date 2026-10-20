// Rules tests. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../docs/engine.js';

const T0 = 1_000_000;
function table(n, settings = {}) {
  const st = E.createTable('TEST1', 'u0', 'Host');
  for (let i = 1; i < n; i++) E.joinTable(st, 'u' + i, 'P' + i);
  E.dispatch(st, 'u0', { type: 'settings', settings }, T0);
  return st;
}
// Put a known deal in place so tests don't depend on the shuffle.
function rig(st, hands, { trump = 'S', dealer = st.players.length - 1 } = {}) {
  const cards = Object.values(hands)[0].length;
  st.schedule = [{ cards, trump }, { cards, trump }];
  st.scores = {};
  for (const p of st.players) st.scores[p.uid] = 0;
  st.roundIdx = 0;
  st.dealer = dealer;
  st.hands = structuredClone(hands);
  st.bids = {};
  st.won = {};
  for (const p of st.players) st.won[p.uid] = 0;
  st.bidTurn = (dealer + 1) % st.players.length;
  st.phase = 'bid';
  st.trick = [];
  st.history = [];
}
const act = (st, uid, a) => E.dispatch(st, uid, a, T0);

test('deck has 52 unique cards and no jokers', () => {
  const d = E.newDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  for (const s of E.SUITS) assert.equal(d.filter((c) => c[1] === s).length, 13);
});

test('shuffle keeps every card and actually mixes', () => {
  const first = new Map();
  for (let i = 0; i < 4000; i++) {
    const d = E.shuffle(E.newDeck());
    assert.equal(new Set(d).size, 52);
    first.set(d[0], (first.get(d[0]) || 0) + 1);
  }
  // Every card should show up on top roughly 4000/52 = 77 times.
  assert.equal(first.size, 52);
  for (const v of first.values()) assert.ok(v > 30 && v < 140, 'top card counts look uneven: ' + v);
});

test('schedule caps at what the deck allows', () => {
  const s = E.DEFAULT_SETTINGS;
  assert.deepEqual(E.buildSchedule(3, s).map((r) => r.cards), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(E.buildSchedule(5, s)[0].cards, 10);
  assert.equal(E.buildSchedule(6, s)[0].cards, 8);
  assert.equal(E.buildSchedule(7, s)[0].cards, 7);
  assert.equal(E.buildSchedule(8, s)[0].cards, 6);
  assert.deepEqual(E.buildSchedule(8, { ...s, schedule: 'downup' }).map((r) => r.cards), [6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(E.buildSchedule(4, { ...s, maxCards: 3, schedule: 'up' }).map((r) => r.cards), [1, 2, 3]);
});

test('trump rotates clubs, spades, diamonds, hearts', () => {
  const t = E.buildSchedule(3, E.DEFAULT_SETTINGS).map((r) => r.trump).join('');
  assert.equal(t, 'CSDHCSDHCS');
  const k = E.buildSchedule(3, { ...E.DEFAULT_SETTINGS, trumpOrder: 'SDCH' }).map((r) => r.trump).join('');
  assert.equal(k, 'SDCHSDCHSD');
});

test('dealing gives everyone the right count, no card twice, for 3 to 8 players', () => {
  for (let n = 3; n <= 8; n++) {
    const st = table(n);
    act(st, 'u0', { type: 'start' });
    const cards = st.schedule[0].cards;
    const all = [];
    for (const p of st.players) { assert.equal(st.hands[p.uid].length, cards); all.push(...st.hands[p.uid]); }
    assert.equal(new Set(all).size, all.length);
  }
});

test('needs 3 players and only the host can start', () => {
  const st = table(2);
  assert.throws(() => act(st, 'u0', { type: 'start' }), /at least 3/);
  E.joinTable(st, 'u2', 'P2');
  assert.throws(() => act(st, 'u1', { type: 'start' }), /Only the host/);
  act(st, 'u0', { type: 'start' });
  assert.equal(st.phase, 'bid');
  assert.throws(() => E.joinTable(st, 'late', 'Late'), /already started/);
  E.joinTable(st, 'u1', 'P1'); // a seated player coming back is fine
});

test('bids: in turn, once, in range', () => {
  const st = table(3);
  rig(st, { u0: ['AS', 'KS'], u1: ['2H', '3H'], u2: ['4D', '5D'] }); // dealer u2, so u0 bids first
  assert.throws(() => act(st, 'u1', { type: 'bid', n: 1 }), /not your turn/);
  assert.throws(() => act(st, 'u0', { type: 'bid', n: 3 }), /0 to 2/);
  assert.throws(() => act(st, 'u0', { type: 'bid', n: 1.5 }), /0 to 2/);
  act(st, 'u0', { type: 'bid', n: 2 });
  assert.throws(() => act(st, 'u0', { type: 'bid', n: 1 }), /not your turn|already bid/);
  act(st, 'u1', { type: 'bid', n: 0 });
});

test('last bidder cannot make the total equal the tricks', () => {
  const st = table(3);
  rig(st, { u0: ['AS', 'KS', 'QS'], u1: ['2H', '3H', '4H'], u2: ['4D', '5D', '6D'] });
  act(st, 'u0', { type: 'bid', n: 2 });
  act(st, 'u1', { type: 'bid', n: 0 });
  assert.deepEqual(E.legalBids(st, 'u2'), [0, 2, 3]);
  assert.throws(() => act(st, 'u2', { type: 'bid', n: 1 }), /can't add up to 3/);
  act(st, 'u2', { type: 'bid', n: 0 });
  assert.equal(st.phase, 'play');
});

test('last-bid rule can be switched off', () => {
  const st = table(3, { lastBidRule: false });
  rig(st, { u0: ['AS'], u1: ['2H'], u2: ['4D'] });
  act(st, 'u0', { type: 'bid', n: 1 });
  act(st, 'u1', { type: 'bid', n: 0 });
  assert.deepEqual(E.legalBids(st, 'u2'), [0, 1]);
});

test('hidden bids stay hidden from other players until bidding ends', () => {
  const st = table(3);
  rig(st, { u0: ['AS'], u1: ['2H'], u2: ['4D'] });
  act(st, 'u0', { type: 'bid', n: 1 });
  const v1 = E.viewFor(st, 'u1');
  const p0 = v1.players.find((p) => p.uid === 'u0');
  assert.equal(p0.hasBid, true);
  assert.equal(p0.bid, null);
  assert.equal(E.viewFor(st, 'u0').players[0].bid, 1);
  act(st, 'u1', { type: 'bid', n: 1 });
  act(st, 'u2', { type: 'bid', n: 1 });
  assert.equal(E.viewFor(st, 'u1').players[0].bid, 1);
});

test('must follow suit when you can, anything when you cannot', () => {
  const st = table(3);
  rig(st, { u0: ['AH', '2C'], u1: ['3H', 'KS'], u2: ['4D', '5D'] }, { trump: 'S' });
  act(st, 'u0', { type: 'bid', n: 1 });
  act(st, 'u1', { type: 'bid', n: 0 });
  act(st, 'u2', { type: 'bid', n: 0 });
  act(st, 'u0', { type: 'play', card: 'AH' });
  assert.deepEqual(E.legalCards(st, 'u1'), ['3H']);
  assert.throws(() => act(st, 'u1', { type: 'play', card: 'KS' }), /must play Hearts/);
  act(st, 'u1', { type: 'play', card: '3H' });
  assert.deepEqual(E.legalCards(st, 'u2').sort(), ['4D', '5D']);
});

test('illegal and out-of-turn plays are refused', () => {
  const st = table(3);
  rig(st, { u0: ['AH', '2C'], u1: ['3H', 'KS'], u2: ['4D', '5D'] });
  act(st, 'u0', { type: 'bid', n: 1 });
  act(st, 'u1', { type: 'bid', n: 0 });
  act(st, 'u2', { type: 'bid', n: 0 });
  assert.throws(() => act(st, 'u1', { type: 'play', card: '3H' }), /not your turn/);
  assert.throws(() => act(st, 'u0', { type: 'play', card: 'KS' }), /isn't in your hand/);
  assert.throws(() => act(st, 'u0', { type: 'play', card: 'ZZ' }), /isn't in your hand/);
  assert.throws(() => act(st, 'nobody', { type: 'play', card: 'AH' }), /not at this table/);
});

test('trick winner: highest of led suit, unless trumped, highest trump wins', () => {
  const W = (cards, trump) => E.trickWinner(cards.map((c, i) => ({ uid: 'p' + i, card: c })), trump);
  assert.equal(W(['5H', 'KH', '2H'], 'S'), 'p1');
  assert.equal(W(['5H', 'AD', '2H'], 'S'), 'p0'); // off-suit ace does nothing
  assert.equal(W(['AH', '2S', 'KH'], 'S'), 'p1'); // small trump beats ace
  assert.equal(W(['AH', '2S', '3S'], 'S'), 'p2'); // higher trump wins
  assert.equal(W(['4S', 'AH', 'KS'], 'S'), 'p2'); // trump led
  assert.equal(W(['TH', 'JH', '9H'], 'C'), 'p1'); // 10 sits under jack
});

test('winner leads next, round ends, exact bids score 10 + bid, sweep bonus', () => {
  const st = table(3);
  rig(st, { u0: ['AS', 'KS'], u1: ['2H', '3H'], u2: ['4D', '5D'] }, { trump: 'S' });
  act(st, 'u0', { type: 'bid', n: 2 });
  act(st, 'u1', { type: 'bid', n: 1 });
  act(st, 'u2', { type: 'bid', n: 0 }); // total 3 vs 2 tricks is allowed
  act(st, 'u0', { type: 'play', card: 'AS' });
  act(st, 'u1', { type: 'play', card: '2H' });
  act(st, 'u2', { type: 'play', card: '4D' });
  assert.equal(st.won.u0, 1);
  assert.equal(st.players[st.turn].uid, 'u0');
  act(st, 'u0', { type: 'play', card: 'KS' });
  act(st, 'u1', { type: 'play', card: '3H' });
  act(st, 'u2', { type: 'play', card: '5D' });
  assert.equal(st.phase, 'roundEnd');
  const r = st.history[0].rows;
  assert.deepEqual(r.u0, { bid: 2, won: 2, pts: 10 + 2 + 30 }); // bid every trick and took them
  assert.deepEqual(r.u1, { bid: 1, won: 0, pts: 0 });
  assert.deepEqual(r.u2, { bid: 0, won: 0, pts: 10 });
});

test('scoring values are configurable', () => {
  const s = { ...E.DEFAULT_SETTINGS, base: 5, perTrick: 2, sweepBonus: 0 };
  assert.equal(E.roundPoints(s, 3, 3, 5), 11);
  assert.equal(E.roundPoints(s, 5, 5, 5), 15);
  assert.equal(E.roundPoints(s, 2, 3, 5), 0);
  assert.equal(E.roundPoints(E.DEFAULT_SETTINGS, 0, 0, 1), 10);
});

test('round moves on when every human is ready; host can force it', () => {
  const st = table(3);
  act(st, 'u0', { type: 'addBot' });
  act(st, 'u0', { type: 'settings', settings: { maxCards: 2 } });
  act(st, 'u0', { type: 'start' });
  finishRoundWithBots(st);
  assert.equal(st.phase, 'roundEnd');
  act(st, 'u0', { type: 'ready' });
  act(st, 'u1', { type: 'ready' });
  assert.equal(st.phase, 'roundEnd');
  act(st, 'u2', { type: 'ready' });
  assert.equal(st.phase, 'bid');
  assert.equal(st.roundIdx, 1);
});

function finishRoundWithBots(st) {
  // Everyone plays like a computer player until the round is over.
  for (const p of st.players) p.auto = !p.bot ? true : p.auto;
  let guard = 0;
  while (st.phase === 'bid' || st.phase === 'play') { st.botAt = 0; E.runBots(st, T0 + guard); assert.ok(guard++ < 500); }
  for (const p of st.players) if (!p.bot) p.auto = false;
}

test('full games with computer players: tricks add up, cards conserved, game ends', () => {
  for (let n = 3; n <= 8; n++) {
    for (const schedule of ['down', 'downup']) {
      const st = E.createTable('SIM', 'h', 'Host');
      st.players[0].auto = true;
      for (let i = 1; i < n; i++) E.dispatch(st, 'h', { type: 'addBot' }, T0);
      E.dispatch(st, 'h', { type: 'settings', settings: { schedule } }, T0);
      E.dispatch(st, 'h', { type: 'start' }, T0);
      let t = T0, guard = 0;
      while (st.phase !== 'over') {
        if (st.phase === 'play' && st.trick.length === 0) {
          const total = st.players.reduce((a, p) => a + st.hands[p.uid].length, 0);
          assert.equal(total % n, 0);
          const counts = new Set(st.players.map((p) => st.hands[p.uid].length));
          assert.equal(counts.size, 1, 'everyone holds the same number of cards between tricks');
        }
        t += 2000;
        E.runBots(st, t);
        assert.ok(guard++ < 5000, 'game stuck');
      }
      assert.equal(st.history.length, st.schedule.length);
      for (const h of st.history) {
        const won = Object.values(h.rows).reduce((a, r) => a + r.won, 0);
        assert.equal(won, h.cards, 'tricks won add up to cards dealt');
        if (st.settings.lastBidRule) {
          const bids = Object.values(h.rows).reduce((a, r) => a + r.bid, 0);
          assert.notEqual(bids, h.cards, 'bids never total the tricks');
        }
      }
      for (const p of st.players) {
        const sum = st.history.reduce((a, h) => a + h.rows[p.uid].pts, 0);
        assert.equal(st.scores[p.uid], sum);
      }
    }
  }
});

test('a player view never contains anyone else\'s cards', () => {
  const st = table(5);
  act(st, 'u0', { type: 'start' });
  for (const p of st.players) {
    const v = E.viewFor(st, p.uid);
    const text = JSON.stringify(v);
    assert.deepEqual(v.hand.slice().sort(), st.hands[p.uid].slice().sort());
    for (const o of st.players) {
      if (o.uid === p.uid) continue;
      for (const c of st.hands[o.uid]) assert.ok(!text.includes('"' + c + '"'), `${p.uid} can see ${o.uid}'s ${c}`);
    }
    assert.ok(!('hands' in v) && !('deck' in v));
  }
});

test('autopilot: host can hand a gone player to the computer, not a connected one', () => {
  const st = table(3);
  act(st, 'u0', { type: 'start' });
  const now = T0 + 200000;
  assert.throws(() => E.dispatch(st, 'u0', { type: 'autopilot', uid: 'u1', on: true }, now, { u1: now - 5000 }), /still connected/);
  assert.throws(() => E.dispatch(st, 'u2', { type: 'autopilot', uid: 'u1', on: true }, now, {}), /Only the host/);
  E.dispatch(st, 'u0', { type: 'autopilot', uid: 'u1', on: true }, now, { u1: now - 100000 });
  assert.equal(st.players[1].auto, true);
});

test('host hand-off: claim only when the host is gone; host leaving passes it on', () => {
  const st = table(3);
  const now = T0 + 200000;
  assert.throws(() => E.dispatch(st, 'u1', { type: 'claimHost' }, now, { u0: now - 1000 }), /still connected/);
  E.dispatch(st, 'u1', { type: 'claimHost' }, now, { u0: now - 100000 });
  assert.equal(st.hostUid, 'u1');
  act(st, 'u1', { type: 'leave' });
  assert.equal(st.players.length, 2);
  assert.notEqual(st.hostUid, 'u1');
});

test('leaving mid-game keeps the seat on autopilot; coming back takes it over', () => {
  const st = table(3);
  act(st, 'u0', { type: 'start' });
  act(st, 'u2', { type: 'leave' });
  const p = st.players.find((x) => x.uid === 'u2');
  assert.ok(p.left && p.auto);
  E.joinTable(st, 'u2', 'P2');
  assert.ok(!p.left && !p.auto);
});

test('rematch keeps the room and wipes the game', () => {
  const st = table(3);
  act(st, 'u0', { type: 'settings', settings: { maxCards: 1 } });
  act(st, 'u0', { type: 'start' });
  finishRoundWithBots(st);
  assert.equal(st.phase, 'over');
  assert.throws(() => act(st, 'u1', { type: 'rematch' }), /Only the host/);
  act(st, 'u0', { type: 'rematch' });
  assert.equal(st.phase, 'lobby');
  assert.equal(st.players.length, 3);
  assert.deepEqual(st.history, []);
  E.joinTable(st, 'new', 'Newbie');
  assert.equal(st.players.length, 4);
});

test('settings: host only, lobby only, bad values ignored', () => {
  const st = table(3);
  assert.throws(() => act(st, 'u1', { type: 'settings', settings: { maxCards: 3 } }), /Only the host/);
  act(st, 'u0', { type: 'settings', settings: { maxCards: 999, schedule: 'sideways', sweepBonus: 50 } });
  assert.equal(st.settings.maxCards, 10);
  assert.equal(st.settings.schedule, 'down');
  assert.equal(st.settings.sweepBonus, 50);
});

test('names are cleaned and required', () => {
  const st = E.createTable('X', 'a', '  <b>Abhi</b>  ');
  assert.equal(st.players[0].name, 'bAbhi/b');
  assert.throws(() => E.joinTable(st, 'b', '   '), /name/);
});

test('browser and server copies of the engine are identical', async () => {
  const fs = await import('node:fs');
  const a = fs.readFileSync(new URL('../docs/engine.js', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../functions/engine.js', import.meta.url), 'utf8');
  assert.equal(a, b, 'run: npm run sync');
});

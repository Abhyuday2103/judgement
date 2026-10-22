// Judgment (Kachuful) rules engine.
// The same file runs in two places:
//   functions/engine.js  the Firebase server, which runs every online table
//   docs/engine.js       the browser, only for practice games against computer players
// Keep the two copies identical.

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
export const TRUMP_ORDERS = {
  CSDH: ['C', 'S', 'D', 'H'], // Clubs, Spades, Diamonds, Hearts (default, from the brief)
  SDCH: ['S', 'D', 'C', 'H'], // Ka-Chu-Fu-L: Kali (spades), Chukat (diamonds), Fuli (clubs), Lal (hearts)
};
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;

// Every rule a host can change. Scoring lives here too.
export const DEFAULT_SETTINGS = {
  maxCards: 10,          // biggest hand. Capped automatically at 52 / players (8 players: 6 cards)
  schedule: 'down',      // 'down' max..1, 'downup' max..1..max, 'up' 1..max
  trumpOrder: 'CSDH',
  hiddenBids: true,      // bids stay secret until everyone has bid
  lastBidRule: true,     // last bidder cannot make total bids equal the tricks in the round
  base: 10,              // points for hitting your bid exactly
  perTrick: 1,           // plus this many points per trick bid
  sweepBonus: 30,        // extra points for bidding every trick and winning them all
};

const rankVal = (c) => RANKS.indexOf(c[0]);
const suitOf = (c) => c[1];
export const cardLabel = (c) => ({ T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' }[c[0]] || c[0]) + ' of ' + SUIT_NAME[c[1]];

// ---------- randomness ----------
// Uses the crypto generator (built into Node and every browser), with rejection sampling so every shuffle is equally likely.
function randInt(n) {
  const buf = new Uint32Array(1);
  const lim = Math.floor(0x100000000 / n) * n;
  let x;
  do { globalThis.crypto.getRandomValues(buf); x = buf[0]; } while (x >= lim);
  return x % n;
}
export function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
export function makeCode(len = 5) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += A[randInt(A.length)];
  return s;
}

// ---------- schedule ----------
export function maxCardsFor(n, settings) {
  return Math.max(1, Math.min(settings.maxCards, Math.floor(52 / n)));
}
export function buildSchedule(n, settings) {
  const top = maxCardsFor(n, settings);
  const down = [];
  for (let c = top; c >= 1; c--) down.push(c);
  let counts;
  if (settings.schedule === 'up') counts = down.slice().reverse();
  else if (settings.schedule === 'downup') counts = down.concat(down.slice(0, -1).reverse());
  else counts = down;
  const order = TRUMP_ORDERS[settings.trumpOrder] || TRUMP_ORDERS.CSDH;
  return counts.map((cards, i) => ({ cards, trump: order[i % 4] }));
}

// ---------- table setup ----------
function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  if (!n) throw new Error('Put your name in first.');
  return n;
}
export function createTable(id, uid, name) {
  return {
    id,
    hostUid: uid,
    phase: 'lobby',
    seq: 0,
    moveNo: 0,
    settings: { ...DEFAULT_SETTINGS },
    players: [{ uid, name: cleanName(name), bot: false, auto: false, left: false }],
    schedule: [],
    roundIdx: -1,
    dealer: 0,
    hands: {},
    bids: {},
    won: {},
    bidTurn: 0,
    turn: 0,
    trick: [],
    trickNo: 0,
    lastTrick: null,
    scores: {},
    history: [],
    ready: [],
    rids: {},
    botAt: 0,
    note: '',
    lastActive: 0,
  };
}

const idxOf = (st, uid) => st.players.findIndex((p) => p.uid === uid);
const playerOf = (st, uid) => st.players.find((p) => p.uid === uid);
const isHost = (st, uid) => st.hostUid === uid;
const controlledByComputer = (p) => p.bot || p.auto;
function need(cond, msg) { if (!cond) throw new Error(msg); }

export function joinTable(st, uid, name) {
  if (idxOf(st, uid) >= 0) {
    const p = playerOf(st, uid);
    if (p.left) { p.left = false; p.auto = false; st.seq++; }
    return;
  }
  need(st.phase === 'lobby', 'This game already started. You can join when the host starts a rematch.');
  need(st.players.length < MAX_PLAYERS, 'Table is full (8 players).');
  st.players.push({ uid, name: cleanName(name), bot: false, auto: false, left: false });
  st.seq++;
}

const BOT_NAMES = ['Raju', 'Pinky', 'Bunty', 'Chintu', 'Golu', 'Sweety', 'Monu', 'Tinku'];
function addBot(st) {
  need(st.players.length < MAX_PLAYERS, 'Table is full (8 players).');
  const used = new Set(st.players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot ' + (st.players.length + 1);
  let uid;
  do { uid = 'bot_' + makeCode(6); } while (idxOf(st, uid) >= 0);
  st.players.push({ uid, name, bot: true, auto: false, left: false });
}

function applySettings(st, s) {
  const cur = st.settings;
  const int = (v, lo, hi, d) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  if ('maxCards' in s) cur.maxCards = int(s.maxCards, 1, 17, cur.maxCards);
  if ('schedule' in s && ['down', 'downup', 'up'].includes(s.schedule)) cur.schedule = s.schedule;
  if ('trumpOrder' in s && TRUMP_ORDERS[s.trumpOrder]) cur.trumpOrder = s.trumpOrder;
  if ('hiddenBids' in s) cur.hiddenBids = !!s.hiddenBids;
  if ('lastBidRule' in s) cur.lastBidRule = !!s.lastBidRule;
  if ('base' in s) cur.base = int(s.base, 0, 100, cur.base);
  if ('perTrick' in s) cur.perTrick = int(s.perTrick, 0, 20, cur.perTrick);
  if ('sweepBonus' in s) cur.sweepBonus = int(s.sweepBonus, 0, 200, cur.sweepBonus);
}

function startGame(st) {
  const n = st.players.length;
  need(n >= MIN_PLAYERS, 'Need at least 3 players. Add a computer player or wait for friends.');
  st.schedule = buildSchedule(n, st.settings);
  st.scores = {};
  for (const p of st.players) st.scores[p.uid] = 0;
  st.history = [];
  st.roundIdx = -1;
  st.dealer = randInt(n);
  startRound(st);
}

function startRound(st) {
  const n = st.players.length;
  st.roundIdx++;
  if (st.roundIdx > 0) st.dealer = (st.dealer + 1) % n;
  const { cards } = st.schedule[st.roundIdx];
  const deck = shuffle(newDeck());
  st.hands = {};
  st.bids = {};
  st.won = {};
  // Deal one at a time, starting left of the dealer.
  for (const p of st.players) { st.hands[p.uid] = []; st.won[p.uid] = 0; }
  for (let c = 0; c < cards; c++) {
    for (let k = 1; k <= n; k++) {
      const p = st.players[(st.dealer + k) % n];
      st.hands[p.uid].push(deck.pop());
    }
  }
  st.bidTurn = (st.dealer + 1) % n;
  st.turn = st.bidTurn;
  st.trick = [];
  st.trickNo = 0;
  st.lastTrick = null;
  st.ready = [];
  st.phase = 'bid';
  st.note = '';
}

// ---------- bidding ----------
export function bidOrder(st) {
  const n = st.players.length;
  const order = [];
  for (let k = 1; k <= n; k++) order.push(st.players[(st.dealer + k) % n].uid);
  return order;
}
export function legalBids(st, uid) {
  if (st.phase !== 'bid' || st.players[st.bidTurn].uid !== uid) return [];
  const cards = st.schedule[st.roundIdx].cards;
  const all = [];
  for (let b = 0; b <= cards; b++) all.push(b);
  const order = bidOrder(st);
  const isLast = order[order.length - 1] === uid;
  if (!st.settings.lastBidRule || !isLast) return all;
  const sum = Object.values(st.bids).reduce((a, b) => a + b, 0);
  return all.filter((b) => sum + b !== cards);
}
function placeBid(st, uid, n) {
  need(st.phase === 'bid', 'Bidding is over for this round.');
  need(st.players[st.bidTurn].uid === uid, "It's not your turn to bid.");
  need(!(uid in st.bids), 'You already bid.');
  const cards = st.schedule[st.roundIdx].cards;
  need(Number.isInteger(n) && n >= 0 && n <= cards, `Bid a number from 0 to ${cards}.`);
  if (!legalBids(st, uid).includes(n)) {
    throw new Error(`You bid last, so the total can't add up to ${cards}. ${n} isn't allowed this round.`);
  }
  st.bids[uid] = n;
  st.moveNo++;
  if (Object.keys(st.bids).length === st.players.length) {
    st.phase = 'play';
    st.turn = (st.dealer + 1) % st.players.length; // left of dealer leads the first trick
  } else {
    st.bidTurn = (st.bidTurn + 1) % st.players.length;
  }
}

// ---------- tricks ----------
export function legalCards(st, uid) {
  if (st.phase !== 'play' || st.players[st.turn].uid !== uid) return [];
  const hand = st.hands[uid] || [];
  if (!st.trick.length) return hand.slice();
  const led = suitOf(st.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}
export function trickWinner(trick, trump) {
  const led = suitOf(trick[0].card);
  let best = trick[0];
  for (const t of trick.slice(1)) {
    const bt = suitOf(best.card) === trump, ct = suitOf(t.card) === trump;
    if (ct && !bt) best = t;
    else if (ct === bt && suitOf(t.card) === suitOf(best.card) && rankVal(t.card) > rankVal(best.card)) best = t;
    else if (!ct && !bt && suitOf(t.card) === led && suitOf(best.card) !== led) best = t;
  }
  return best.uid;
}
function playCard(st, uid, card, now) {
  need(st.phase === 'play', "It's not time to play a card.");
  need(st.players[st.turn].uid === uid, "It's not your turn.");
  const hand = st.hands[uid];
  need(typeof card === 'string' && hand.includes(card), "That card isn't in your hand.");
  if (st.trick.length) {
    const led = suitOf(st.trick[0].card);
    if (suitOf(card) !== led && hand.some((c) => suitOf(c) === led)) {
      throw new Error(`You have ${SUIT_NAME[led]}, so you must play ${SUIT_NAME[led]}.`);
    }
  }
  hand.splice(hand.indexOf(card), 1);
  st.trick.push({ uid, card });
  st.moveNo++;
  const n = st.players.length;
  if (st.trick.length < n) { st.turn = (st.turn + 1) % n; return; }
  const trump = st.schedule[st.roundIdx].trump;
  const w = trickWinner(st.trick, trump);
  st.won[w]++;
  st.lastTrick = { cards: st.trick, winner: w, no: st.trickNo, at: now };
  st.trick = [];
  st.trickNo++;
  st.turn = idxOf(st, w);
  st.botAt = Math.max(st.botAt, now + 1700); // let everyone see the finished trick
  if (st.hands[uid].length === 0) endRound(st);
}

export function roundPoints(settings, bid, won, cards) {
  if (bid !== won) return 0;
  let pts = settings.base + settings.perTrick * bid;
  if (bid === cards && cards > 0) pts += settings.sweepBonus;
  return pts;
}
function endRound(st) {
  const { cards, trump } = st.schedule[st.roundIdx];
  const rows = {};
  for (const p of st.players) {
    const bid = st.bids[p.uid], won = st.won[p.uid];
    const pts = roundPoints(st.settings, bid, won, cards);
    st.scores[p.uid] += pts;
    rows[p.uid] = { bid, won, pts };
  }
  st.history.push({ no: st.roundIdx + 1, cards, trump, rows });
  st.phase = st.roundIdx + 1 >= st.schedule.length ? 'over' : 'roundEnd';
  st.ready = [];
}
function nextRoundIfReady(st) {
  if (st.phase !== 'roundEnd') return;
  const waiting = st.players.filter((p) => !controlledByComputer(p) && !p.left && !st.ready.includes(p.uid));
  if (!waiting.length) startRound(st);
}

// ---------- the one entry point for every player action ----------
// presence: optional { uid: lastSeenMs } so the server can tell who has dropped off.
export const AWAY_MS = 70000;
export function dispatch(st, uid, a, now, presence = {}) {
  const me = playerOf(st, uid);
  need(me, 'You are not at this table.');
  const type = a && a.type;
  // Any real move from a player on autopilot means they're back.
  if (['bid', 'play', 'ready'].includes(type) && me.auto && !me.bot) me.auto = false;

  switch (type) {
    case 'addBot':
      need(isHost(st, uid), 'Only the host can add computer players.');
      need(st.phase === 'lobby', 'Add computer players before the game starts.');
      addBot(st);
      break;
    case 'remove': {
      need(isHost(st, uid), 'Only the host can remove players.');
      need(st.phase === 'lobby', 'Players can only be removed in the lobby.');
      need(a.uid !== uid, 'Use Leave to leave the table yourself.');
      const i = idxOf(st, a.uid);
      need(i >= 0, 'That player already left.');
      st.players.splice(i, 1);
      break;
    }
    case 'settings':
      need(isHost(st, uid), 'Only the host can change the rules.');
      need(st.phase === 'lobby', 'Rules are locked once the game starts.');
      applySettings(st, a.settings || {});
      break;
    case 'start':
      need(isHost(st, uid), 'Only the host can start.');
      need(st.phase === 'lobby', 'The game already started.');
      startGame(st);
      break;
    case 'bid':
      placeBid(st, uid, a.n);
      break;
    case 'play':
      playCard(st, uid, a.card, now);
      break;
    case 'ready':
      need(st.phase === 'roundEnd', 'Nothing to get ready for.');
      if (!st.ready.includes(uid)) st.ready.push(uid);
      nextRoundIfReady(st);
      break;
    case 'forceNext':
      need(isHost(st, uid), 'Only the host can deal the next round.');
      need(st.phase === 'roundEnd', 'The round is still going.');
      startRound(st);
      break;
    case 'autopilot': {
      // Yourself: any time. Someone else: host only, and only once they've been gone a while.
      const target = playerOf(st, a.uid || uid);
      need(target && !target.bot, 'No such player.');
      need(st.phase !== 'lobby', 'Autopilot is only for during a game.');
      if (target.uid !== uid) {
        need(isHost(st, uid), 'Only the host can do that for someone else.');
        const seen = presence[target.uid] || 0;
        need(!a.on || now - seen > AWAY_MS, `${target.name} is still connected. Give them a minute.`);
      }
      target.auto = !!a.on;
      if (!a.on) target.left = false;
      nextRoundIfReady(st);
      break;
    }
    case 'claimHost': {
      need(!isHost(st, uid), "You're already the host.");
      const host = playerOf(st, st.hostUid);
      const seen = presence[st.hostUid] || 0;
      need(!host || host.left || now - seen > AWAY_MS, 'The host is still connected.');
      st.hostUid = uid;
      break;
    }
    case 'leave':
      if (st.phase === 'lobby') {
        st.players.splice(idxOf(st, uid), 1);
      } else {
        me.left = true;
        me.auto = true;
        nextRoundIfReady(st);
      }
      if (isHost(st, uid)) {
        const next = st.players.find((p) => !p.bot && !p.left && p.uid !== uid);
        if (next) st.hostUid = next.uid;
      }
      break;
    case 'rematch':
      need(isHost(st, uid), 'Only the host can start a rematch.');
      need(st.phase === 'over', 'Finish this game first.');
      st.players = st.players.filter((p) => !p.left);
      for (const p of st.players) p.auto = false;
      Object.assign(st, { phase: 'lobby', schedule: [], roundIdx: -1, hands: {}, bids: {}, won: {}, trick: [], lastTrick: null, scores: {}, history: [], ready: [] });
      break;
    default:
      throw new Error('Unknown move.');
  }
  if (type === 'bid' || type === 'play') st.botAt = Math.max(st.botAt, now + 700);
  st.seq++;
  st.lastActive = now;
}

// ---------- giving a seat to a new device ----------
// Someone lost their sign-in (new browser, cleared data, in-app browser): hand their seat, cards and score to the new id.
export function renameSeat(st, oldUid, newUid) {
  const p = playerOf(st, oldUid);
  need(p && !p.bot, 'That seat is not available.');
  need(idxOf(st, newUid) < 0, "You're already at this table.");
  const move = (obj) => { if (obj && oldUid in obj) { obj[newUid] = obj[oldUid]; delete obj[oldUid]; } };
  p.uid = newUid;
  p.auto = false;
  p.left = false;
  if (st.hostUid === oldUid) st.hostUid = newUid;
  move(st.hands); move(st.bids); move(st.won); move(st.scores); move(st.rids);
  st.ready = st.ready.map((u) => (u === oldUid ? newUid : u));
  for (const t of st.trick) if (t.uid === oldUid) t.uid = newUid;
  if (st.lastTrick) {
    for (const t of st.lastTrick.cards) if (t.uid === oldUid) t.uid = newUid;
    if (st.lastTrick.winner === oldUid) st.lastTrick.winner = newUid;
  }
  for (const h of st.history) move(h.rows);
  st.seq++;
}
// True when a computer player or autopilot seat has a move waiting.
export function botsDue(st, now) {
  if (now < st.botAt) return false;
  if (st.phase === 'bid') return controlledByComputer(st.players[st.bidTurn]);
  if (st.phase === 'play') return controlledByComputer(st.players[st.turn]);
  if (st.phase === 'roundEnd') return !st.players.some((p) => !controlledByComputer(p) && !p.left && !st.ready.includes(p.uid));
  return false;
}

// ---------- computer players ----------
function estimateTricks(hand, trump, nPlayers) {
  let est = 0;
  const bySuit = {};
  for (const c of hand) (bySuit[suitOf(c)] = bySuit[suitOf(c)] || []).push(rankVal(c));
  const crowd = nPlayers >= 6 ? 0.75 : 1;
  for (const c of hand) {
    const r = rankVal(c), s = suitOf(c);
    if (s === trump) est += r >= 11 ? 0.95 : r >= 8 ? 0.65 : 0.4;
    else {
      const len = bySuit[s].length;
      if (r === 12) est += 0.85 * crowd;
      else if (r === 11 && len <= 4) est += 0.5 * crowd;
      else if (r === 10 && len <= 3) est += 0.2 * crowd;
    }
  }
  // Short side suits let trumps ruff.
  const trumps = (bySuit[trump] || []).length;
  if (trumps) for (const s of SUITS) if (s !== trump && !bySuit[s] && hand.length >= 4) est += 0.3;
  return est;
}
function botBid(st, uid) {
  const legal = legalBids(st, uid);
  const { cards, trump } = st.schedule[st.roundIdx];
  const want = Math.min(cards, Math.round(estimateTricks(st.hands[uid], trump, st.players.length)));
  return legal.slice().sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0];
}
function beats(card, best, led, trump) {
  return trickWinner([{ uid: 'b', card: best }, { uid: 'c', card }], trump) === 'c' && (suitOf(card) === led || suitOf(card) === trump);
}
function botCard(st, uid) {
  const legal = legalCards(st, uid);
  const { trump } = st.schedule[st.roundIdx];
  const needMore = st.bids[uid] - st.won[uid];
  const lowFirst = (a, b) => (suitOf(a) === trump) - (suitOf(b) === trump) || rankVal(a) - rankVal(b);
  const highFirst = (a, b) => rankVal(b) - rankVal(a) || (suitOf(b) === trump) - (suitOf(a) === trump);
  if (!st.trick.length) {
    // Leading: go for it with a strong card, or slip out with a small one.
    return needMore > 0 ? legal.slice().sort(highFirst)[0] : legal.slice().sort(lowFirst)[0];
  }
  const led = suitOf(st.trick[0].card);
  const curWin = st.trick.find((t) => t.uid === trickWinner(st.trick, trump)).card;
  const winners = legal.filter((c) => beats(c, curWin, led, trump));
  const losers = legal.filter((c) => !winners.includes(c));
  if (needMore > 0) {
    if (winners.length) return winners.sort(lowFirst)[0];
    return legal.slice().sort(lowFirst)[0];
  }
  if (losers.length) return losers.sort(highFirst)[0]; // dump the biggest card that still loses
  return legal.slice().sort(lowFirst)[0];
}
// Makes at most one computer move if one is due. Returns true if something changed.
export function runBots(st, now) {
  if (now < st.botAt) return false;
  let acted = false;
  if (st.phase === 'bid') {
    const p = st.players[st.bidTurn];
    if (controlledByComputer(p)) { placeBid(st, p.uid, botBid(st, p.uid)); acted = true; }
  } else if (st.phase === 'play') {
    const p = st.players[st.turn];
    if (controlledByComputer(p)) { playCard(st, p.uid, botCard(st, p.uid), now); acted = true; }
  } else if (st.phase === 'roundEnd') {
    const before = st.roundIdx;
    nextRoundIfReady(st);
    acted = st.roundIdx !== before;
  }
  if (acted) {
    st.seq++;
    st.lastActive = now;
    st.botAt = Math.max(st.botAt, now + 850);
  }
  return acted;
}

// ---------- what one player is allowed to see ----------
export function viewFor(st, uid) {
  const bidsPublic = st.phase !== 'bid' || !st.settings.hiddenBids;
  const round = st.roundIdx >= 0 && st.schedule[st.roundIdx] ? st.schedule[st.roundIdx] : null;
  const hand = (st.hands[uid] || []).slice().sort((a, b) => {
    const order = ['S', 'H', 'C', 'D'];
    return order.indexOf(suitOf(a)) - order.indexOf(suitOf(b)) || rankVal(b) - rankVal(a);
  });
  return {
    id: st.id,
    me: uid,
    seq: st.seq,
    moveNo: st.moveNo,
    phase: st.phase,
    hostUid: st.hostUid,
    settings: st.settings,
    serverNow: st.now || Date.now(),
    botAt: st.botAt,
    players: st.players.map((p) => ({
      uid: p.uid,
      name: p.name,
      bot: p.bot,
      auto: p.auto,
      left: p.left,
      cards: (st.hands[p.uid] || []).length,
      hasBid: p.uid in st.bids,
      bid: p.uid in st.bids && (bidsPublic || p.uid === uid) ? st.bids[p.uid] : null,
      won: st.won[p.uid] || 0,
      score: st.scores[p.uid] || 0,
    })),
    round: round && { no: st.roundIdx + 1, total: st.schedule.length, cards: round.cards, trump: round.trump, dealer: st.players[st.dealer] && st.players[st.dealer].uid },
    schedule: st.schedule,
    hand,
    bidTurn: st.phase === 'bid' ? st.players[st.bidTurn].uid : null,
    turn: st.phase === 'play' ? st.players[st.turn].uid : null,
    legalBids: legalBids(st, uid),
    legalCards: legalCards(st, uid),
    trick: st.trick,
    lastTrick: st.lastTrick,
    history: st.history,
    ready: st.ready,
  };
}

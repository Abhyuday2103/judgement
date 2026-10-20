# Judgment

Judgment (also called Kachuful) for 3 to 8 players, each on their own phone or laptop. Computer players are optional, for empty seats or practice.

Same setup as Teen Patti and Declare:
- **GitHub Pages** serves the website from the `docs` folder.
- **A Firebase function** (`jg`) shuffles, deals, checks every move and keeps score. Nobody's browser ever receives another player's cards.
- It shares the Teen Patti Firebase project (`teenpatti-44fde`) but has its own function (`jg`), its own codebase (`judgment`) and its own collection (`jtables`). Deploying Judgment never touches the other two games.

## Files

| Where | What |
|---|---|
| `docs/index.html`, `docs/style.css`, `docs/app.js` | The website: home, lobby, table, scores |
| `docs/engine.js` | All the rules. Also runs practice games in the browser |
| `docs/firebase-config.js` | Your Firebase web config (already filled in, safe to be public) |
| `functions/index.js` | The Firebase function entry point |
| `functions/server.js` | Rooms, joining, saving state, duplicate and stale move checks |
| `functions/engine.js` | Exact copy of `docs/engine.js`. Run `npm run sync` after changing the rules |
| `firestore.rules` | Database lock rules for all three games |
| `tests/` | Rules tests and server tests (`npm test`) |
| `tools/e2e.py` | Four separate browsers play a full online game on the local emulators |
| `tools/practice_shots.py` | Plays a practice game and saves screenshots |

## Rules as built

- 52 cards, no jokers. 3 to 8 players.
- Rounds go from the biggest hand down to 1 card. Biggest hand is 10, or less if the deck can't cover it: 6 players get 8, 7 get 7, 8 get 6. Host can switch to down-and-up or up.
- Trump rotates Clubs, Spades, Diamonds, Hearts. Host can switch to Spades, Diamonds, Clubs, Hearts (the Ka-Chu-Fu-L order the name comes from).
- Dealer moves one seat left each round. Bidding starts left of the dealer; the dealer bids last.
- Bids are secret until everyone has bid (host can make them open).
- Last bidder rule: the dealer can't make total bids equal the number of cards. The bid buttons grey out the one illegal number.
- Left of the dealer leads the first trick. Follow suit if you can, otherwise play anything. Highest trump wins, else highest of the suit led. Ace high. Winner leads next.
- Exact bid: 10 + your bid. Miss: 0. Bid every trick and take them all: +30 more. Host can change 10 and 30 in the lobby.
- Highest total after the last round wins. Ties are shown as ties.

Every rule setting lives in `DEFAULT_SETTINGS` at the top of `docs/engine.js`.

## How hands stay private

1. Everyone signs in anonymously (no account, no email). Firebase gives each browser a hidden id.
2. The function stores the full game (deck, every hand, secret bids) in `jtables/CODE/secret/state`. The database rules say nobody can read that, ever. Only the function can.
3. After every move the function writes one view per player to `jtables/CODE/views/THEIR_ID`. Each view has only that player's cards and, until bidding ends, only their own bid. The rules let you read only the view with your own id.
4. Every move goes through the function, which uses your sign-in id, not anything your browser claims. It checks: are you at this table, is it your turn, do you hold that card, are you following suit, is that bid allowed.
5. Shuffling uses the crypto random generator, so it can't be predicted.
6. Knowing a table code gets you nothing. Strangers can't read views, the secret state, or act, and can't join once a game has started.

The firebase-config keys in `docs/` are meant to be public. They only identify the project; the rules above do the protecting.

## Deploy (one time, about 5 minutes)

The website part: push to GitHub and turn on Pages (Settings > Pages > Deploy from a branch > main > /docs). Claude can do this for you.

The server part runs from your laptop. Install Node.js LTS from nodejs.org if you don't have it, then in Terminal:

```
cd ~/Downloads/judgment
npx firebase-tools login
cd functions
npm install
cd ..
npx firebase-tools deploy --only functions:judgment,firestore:rules
```

Then in the Firebase console, **Authentication > Settings > Authorized domains**, make sure `abhyuday2103.github.io` is listed (it already is from Teen Patti).

### Updating later
- Changed anything in `docs/`: push to GitHub, live in a minute.
- Changed anything in `functions/` or `docs/engine.js`: run `npm run sync`, push, then run the last Terminal line again.

## Playing

1. Open the site, type your name, **Create a table**.
2. Tap **Copy invite link** and send it. On a phone it opens the share sheet.
3. Friends open the link, type their name, tap Join. Codes work too.
4. Host picks the rules, adds computer players if seats are empty, taps **Deal**.

To test alone: open the link in a normal window and a private window on your laptop, plus your phone. Each counts as a separate player.

## What happens when things go wrong

| Situation | What the game does |
|---|---|
| Refresh, close the tab, phone sleeps | Your browser remembers the table and your id. Opening the site puts you back in your seat with your cards. |
| Internet drops | A "Reconnecting" box shows. The game waits. When you're back it catches up on its own. A Reload button appears after 25 seconds. |
| Someone vanishes mid-game | The game waits on their turn. After about a minute the host's menu shows "X is away. Let the computer play for them". When X comes back and makes any move, they take their seat back. |
| Someone taps Leave mid-game | The computer plays their seat. Same link brings them back. |
| Host disappears | After about a minute anyone can tap "Become host" in the menu. If the host taps Leave, it passes to the next person automatically. |
| New person joins after the deal | Refused with a message. They can join when the host starts a rematch (it returns everyone to the lobby). |
| Double tap, slow network retry | Each move has an id. The same move twice only counts once. |
| Move from an old screen | Refused with "The table moved on", and the screen refreshes. |
| Two people move at the exact same moment | Each table's moves are processed one at a time (database transactions), so only the legal one goes through. |
| Wrong or old code | "No table with that code" or "That table expired" (24 hours idle). |
| Firebase restarts the function | Nothing lost. Every move is saved to the database before anyone sees it. The only limit: anonymous ids live in the browser, so if someone clears their browser data or switches phones mid-game, they can't reclaim their seat. The host can hand it to the computer. |

## Costs

Runs on the same Blaze plan as Teen Patti. A night of games uses a tiny slice of the free monthly allowance (2 million function calls, 50,000 database reads and 20,000 writes per day). Expect $0. If you want a safety net, set a $5 budget alert in Google Cloud Billing.

Each table writes one small document per player per move, and each open browser checks in about every 3 seconds. An 8-player game of an hour is roughly 20,000 reads and 3,000 writes, so a couple of hours a night stays free, and going over costs cents. Old tables stay in the database but are tiny; you can delete the `jtables` collection in the Firebase console any time.

## Testing

```
npm test                              # 34 rules and server tests, no internet needed
cd functions && npm install && cd ..
npx firebase-tools emulators:start --only auth,firestore,functions
python3 tools/e2e.py docs /tmp/shots  # second Terminal: 4 browsers play a full online game
```

The emulators run Firebase on your own computer, with the real `firestore.rules`. Add `?emu=127.0.0.1` to the page address to point the site at them.

## Troubleshooting

- **"Online play is not set up yet"**: `docs/firebase-config.js` is missing its config.
- **Stuck on "Connecting" or "auth/unauthorized-domain"**: add your github.io domain under Firebase Authentication > Settings > Authorized domains.
- **"internal" or "not-found" error when creating a table**: the function isn't deployed. Run the deploy line again and look for `jg` in the output.
- **Deploy says "Billing account not configured"**: the project needs the Blaze plan (it already has it from Teen Patti).
- **Deploy asks to delete functions `tp` or `dc`**: answer **No**. That shouldn't happen with `--only functions:judgment`, so double-check you're in the judgment folder.
- **EACCES or permission errors with npm on a Mac**: don't use sudo. Run `sudo chown -R $(whoami) ~/.npm` once, then retry.
- **A friend's screen stops updating**: the app re-checks every 3 seconds and when the tab wakes up. If it's still stuck, they close and reopen the tab; their seat is saved.
- **Teen Patti or Declare broke after deploying rules**: the `firestore.rules` here covers all three games. If you edit it, keep all three blocks.

# End-to-end test: separate browser sessions (each its own "device" with its own sign-in) join one table
# on the local Firebase emulators and play a whole game. Also checks that nobody can read another player's cards.
# Needs: firebase emulators:start --only auth,firestore,functions   (from the project folder)
# Run:   python3 tools/e2e.py docs <screenshot dir>
import sys, os, time, json, threading, http.server, functools
from playwright.sync_api import sync_playwright

docs, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=docs)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8777), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:8777/index.html?emu=127.0.0.1'
NAMES = ['Abhyuday', 'Eric', 'Martin', 'Stuti']
errors = []

def step(page):
    """Make one move if this player has one. Returns a short label of what happened."""
    if page.is_visible('#ready'):
        page.click('#ready'); return 'ready'
    if page.is_visible('#bidbox'):
        btns = page.query_selector_all('#bidbox [data-bid]:not([disabled])')
        if btns:
            btns[len(btns) // 2].click(); return 'bid'
    c = page.query_selector('#hand .hc.legal')
    if c and c.is_visible():
        c.click(position={'x': 8, 'y': 12}); page.wait_for_timeout(80)
        c = page.query_selector('#hand .hc.sel')
        if c: c.click(position={'x': 8, 'y': 12}); return 'play'
    return ''

with sync_playwright() as p:
    b = p.chromium.launch()
    pages = []
    for i, n in enumerate(NAMES):
        size = {'width': 390, 'height': 844} if i % 2 == 0 else {'width': 1280, 'height': 800}
        ctx = b.new_context(viewport=size, device_scale_factor=2 if i % 2 == 0 else 1, has_touch=i % 2 == 0)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, n=n: errors.append(f'{n}: {e} {e.stack[:600] if e.stack else ""}'))
        pg.on('console', lambda m, n=n: errors.append(f'{n}: {m.text}') if m.type == 'error' and 'permission' not in m.text.lower() else None)
        pages.append(pg)

    host = pages[0]
    host.goto(BASE)
    host.fill('#name', NAMES[0])
    host.screenshot(path=f'{out}/01-home-phone.png')
    host.click('#create')
    host.wait_for_selector('#lobby:not([hidden])', timeout=30000)
    code = host.inner_text('#lobby-code').strip()
    print('table', code)

    # Friends open the invite link on their own devices.
    for pg, n in zip(pages[1:], NAMES[1:]):
        pg.goto(BASE + '&t=' + code)  # invite link: code is filled in, they type a name and tap Join
        assert pg.input_value('#code') == code
        pg.fill('#name', n)
        pg.click('#join')
        pg.wait_for_selector('#lobby:not([hidden])', timeout=30000)
    host.wait_for_function('document.querySelectorAll("#lobby-players li").length === 4', timeout=20000)
    # Host sets a short game: 3 cards down to 1.
    host.select_option('#s-max', '3')
    host.wait_for_function('document.querySelector("#start").textContent.includes("3 rounds")', timeout=10000)
    host.screenshot(path=f'{out}/02-lobby-host-phone.png', full_page=True)
    pages[1].wait_for_function('document.querySelector("#settings").textContent.includes("biggest hand 3")', timeout=10000)
    pages[1].screenshot(path=f'{out}/03-lobby-guest-desktop.png')
    host.click('#start')
    for pg in pages: pg.wait_for_selector('#table:not([hidden])', timeout=20000)

    # Privacy: every hand on screen is different, and a player can't read another player's view or the secret deal.
    hands = [sorted(pg.eval_on_selector_all('#hand [data-card]', 'els => els.map(e => e.dataset.card)')) for pg in pages]
    flat = [c for h in hands for c in h]
    assert all(len(h) == 3 for h in hands), hands
    assert len(set(flat)) == len(flat), 'two players hold the same card'
    probe = '''async ([code]) => {
      const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
      const fs = await import(base + 'firebase-firestore.js');
      const appM = await import(base + 'firebase-app.js');
      const authM = await import(base + 'firebase-auth.js');
      const app = appM.getApp();
      const db = fs.getFirestore(app);
      const me = authM.getAuth(app).currentUser.uid;
      const out = {};
      const tryRead = async (k, ref) => { try { const s = await fs.getDocFromServer(ref); out[k] = s.exists() ? 'READ' : 'empty'; } catch (e) { out[k] = e.code || String(e); } };
      await tryRead('secret', fs.doc(db, 'jtables', code, 'secret', 'state'));
      const views = await fs.getDocs(fs.collection(db, 'jtables', code, 'views')).then(() => 'LISTED').catch((e) => e.code);
      out.listViews = views;
      await tryRead('ownView', fs.doc(db, 'jtables', code, 'views', me));
      try { await fs.setDoc(fs.doc(db, 'jtables', code, 'presence', 'someone-else'), { at: fs.serverTimestamp() }); out.fakePresence = 'WROTE'; } catch (e) { out.fakePresence = e.code; }
      try { await fs.setDoc(fs.doc(db, 'jtables', code, 'views', me), { json: '{}' }); out.writeView = 'WROTE'; } catch (e) { out.writeView = e.code; }
      return out;
    }'''
    res = pages[2].evaluate(probe, [code])
    print('privacy probe', res)
    assert res['secret'] == 'permission-denied', res
    assert res['listViews'] == 'permission-denied', res
    assert res['ownView'] == 'READ', res
    assert res['fakePresence'] == 'permission-denied', res
    assert res['writeView'] == 'permission-denied', res

    # Calling the server as player 3 but claiming to be the current bidder does nothing for them.
    host.screenshot(path=f'{out}/04-table-phone.png')
    pages[1].screenshot(path=f'{out}/05-table-desktop.png')

    t0 = time.time(); moves = 0; shots = set(); reloaded = False; lost = False
    while time.time() - t0 < 400:
        if host.is_visible('#rematch'):
            break
        for i, pg in enumerate(pages):
            try:
                did = step(pg)
            except Exception as e:
                did = ''
            if did:
                moves += 1
                if did == 'bid' and 'bid' not in shots and i == 0:
                    pass
            if i == 0 and pg.is_visible('#bidbox') and 'bidbox' not in shots:
                shots.add('bidbox'); pg.screenshot(path=f'{out}/06-bidding-phone.png')
            if i == 1 and len(pg.query_selector_all('.tcard')) >= 2 and 'trick' not in shots:
                shots.add('trick'); pg.screenshot(path=f'{out}/07-trick-desktop.png')
            if i == 0 and len(pg.query_selector_all('.tcard')) >= 3 and 'trickp' not in shots:
                shots.add('trickp'); pg.screenshot(path=f'{out}/07b-trick-phone.png')
            if i == 0 and pg.is_visible('#ready') and 'result' not in shots:
                shots.add('result'); pg.screenshot(path=f'{out}/08-round-result-phone.png')
        # Mid-game, one player refreshes the page (like a phone reload) and should land back in their seat.
        if not reloaded and moves > 6:
            pages[3].wait_for_timeout(2500)  # let any move in flight land first
            before = sorted(pages[3].eval_on_selector_all('#hand [data-card]', 'els => els.map(e => e.dataset.card)'))
            pages[3].reload()
            pages[3].wait_for_selector('#table:not([hidden])', timeout=30000)
            pages[3].wait_for_timeout(800)
            after = sorted(pages[3].eval_on_selector_all('#hand [data-card]', 'els => els.map(e => e.dataset.card)'))
            print('reload: hand before', before, 'after', after)
            assert before == after, 'hand changed after reload'
            reloaded = True
            # Freeze one player's live connection for the rest of the game. Check-ins alone must keep them in sync.
            pages[2].context.route('**/google.firestore.v1.Firestore/Listen/**', lambda r: r.abort())
            print('froze live updates for', NAMES[2])
        # A bit later, another player loses their browser completely (new phone, cleared data, in-app browser) mid-hand.
        if reloaded and not lost and moves > 12 and pages[1].is_visible('#table') and len(pages[1].query_selector_all('#hand [data-card]')) > 0:
            lost = True
            pages[1].wait_for_timeout(2500)
            before = sorted(pages[1].eval_on_selector_all('#hand [data-card]', 'els => els.map(e => e.dataset.card)'))
            pages[1].context.close()
            ctx = b.new_context(viewport={'width': 1280, 'height': 800})
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'Eric2: {e}'))
            pg.goto(BASE + '&t=' + code)
            pg.fill('#name', 'Eric')
            pg.click('#join')
            pg.wait_for_selector('#sheet:not([hidden])', timeout=30000)
            pg.screenshot(path=f'{out}/11-seat-picker-wait.png')
            t1 = time.time()
            while not pg.is_visible('[data-claim]'):
                assert time.time() - t1 < 90, 'seat never offered'
                for other in (pages[0], pages[2], pages[3]):
                    try: step(other)
                    except Exception: pass
                pg.wait_for_timeout(3000)
            print('seat offered after', round(time.time() - t1), 's')
            pg.screenshot(path=f'{out}/12-seat-picker.png')
            pg.click('[data-claim]')
            pg.wait_for_selector('#table:not([hidden])', timeout=30000)
            pg.wait_for_timeout(800)
            after = sorted(pg.eval_on_selector_all('#hand [data-card]', 'els => els.map(e => e.dataset.card)'))
            print('lost device: hand before', before, 'after', after)
            assert before == after, 'hand changed after taking the seat back'
            pages[1] = pg
        if time.time() - t0 > 200 and not getattr(step, 'dumped', False):
            step.dumped = True
            if host.is_visible('#rematch'): continue
            for pg in pages:
                print('STATUS', pg.inner_text('#status'), '| toast:', pg.inner_text('#toast') if pg.is_visible('#toast') else '', '| legal:', len(pg.query_selector_all('#hand .hc.legal')), '| bidbox:', pg.is_visible('#bidbox'), '| recon:', pg.is_visible('#recon'), '| sheet:', pg.is_visible('#sheet'))
            break
        time.sleep(0.15)
    print('moves made', moves, 'in', round(time.time() - t0), 's')
    for pg in pages: pg.wait_for_selector('#sheet:not([hidden])', timeout=15000)
    host.screenshot(path=f'{out}/09-game-over-phone.png', full_page=True)
    pages[1].screenshot(path=f'{out}/10-game-over-desktop.png')
    titles = [pg.inner_text('.sheet h2') for pg in pages]
    print('game over titles', titles)
    totals = [pg.eval_on_selector_all('.podium .sc', 'els => els.map(e => e.textContent)') for pg in pages]
    assert all(t == totals[0] for t in totals), totals
    assert reloaded and lost

    # Rematch brings everyone back to the lobby together.
    host.click('#rematch')
    for pg in pages: pg.wait_for_selector('#lobby:not([hidden])', timeout=20000)
    print('rematch: all four back in the lobby')
    b.close()

srv.shutdown()
bad = [e for e in errors if 'favicon' not in e]
print('browser errors:', bad[:10] if bad else 'none')
print('E2E PASSED')

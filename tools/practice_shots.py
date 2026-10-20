# Plays a practice game (you plus computer players) in a real browser and saves screenshots.
# python3 tools/practice_shots.py docs <out dir> <computer players>
import sys, os, time, threading, http.server, functools
from playwright.sync_api import sync_playwright
docs, out, bots = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=docs); h.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8779), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
errs = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for tag, vp in [('phone', {'width': 390, 'height': 844}), ('desk', {'width': 1366, 'height': 820})]:
        pg = b.new_page(viewport=vp, device_scale_factor=2 if tag == 'phone' else 1)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://127.0.0.1:8779/index.html')
        pg.fill('#name', 'Abhyuday'); pg.select_option('#bots', bots); pg.click('#practice')
        pg.wait_for_selector('#lobby:not([hidden])')
        pg.screenshot(path=f'{out}/{tag}-lobby.png', full_page=True)
        pg.click('#start')
        shots = set(); t0 = time.time()
        while time.time() - t0 < 60 and len(shots) < 4:
            if pg.is_visible('#ready'):
                if 'result' not in shots: shots.add('result'); pg.wait_for_timeout(300); pg.screenshot(path=f'{out}/{tag}-result.png')
                pg.click('#ready'); continue
            if pg.is_visible('#bidbox'):
                if 'bid' not in shots: shots.add('bid'); pg.screenshot(path=f'{out}/{tag}-bid.png')
                btn = pg.query_selector('#bidbox [data-bid]:not([disabled])'); btn.click(); continue
            c = pg.query_selector('#hand .hc.legal')
            if c:
                if len(pg.query_selector_all('.tcard')) >= 3 and 'trick' not in shots: shots.add('trick'); pg.screenshot(path=f'{out}/{tag}-trick.png')
                c.click(); pg.wait_for_timeout(60)
                if 'sel' not in shots and tag == 'phone': shots.add('sel'); pg.screenshot(path=f'{out}/{tag}-selected.png')
                s = pg.query_selector('#hand .hc.sel')
                if s: s.click()
            pg.wait_for_timeout(120)
        pg.click('[data-open="scores"]'); pg.wait_for_timeout(400); pg.screenshot(path=f'{out}/{tag}-scores.png')
srv.shutdown()
print('errors', errs or 'none')

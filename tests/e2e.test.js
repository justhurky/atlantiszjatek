'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startServer, PNG_1PX, noisePng, TEST_ADMIN_KEY } = require('./helpers');

// Ha nincs Playwright-böngésző telepítve, a CHROME_PATH-ra mutathat (pl. a rendszer Chrome-ja)
const EXEC = process.env.CHROME_PATH || undefined;
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let srv, browser;
const contexts = [];

before(async () => {
  srv = await startServer({
    LETTERS_ANSWER: 'TITKOS',
    RATE_LIMIT_PER_MIN: '1000',
    ANSWER_RATE_PER_MIN: '100000',
  });
  browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
});
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  if (browser) await browser.close();
  if (srv) srv.stop();
});

// Új "telefon": külön böngésző-kontextus, saját sütikkel, hibagyűjtéssel
async function phone(opts = MOBILE) {
  const ctx = await browser.newContext(opts);
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/fonts\.g|googleapis|gstatic|ERR_FAILED|Failed to load resource/.test(t)) return;
    page.errors.push(t);
  });
  // Betűtípusok: offline-biztos (a teszt nem függ külső szolgáltatástól)
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(srv.base + '/');
  return page;
}

// Átugorja a nyitóképernyőt, és megvárja a kezdő űrlapot
async function skipIntro(page) {
  await page.waitForSelector('#intro, #createForm', { timeout: 5000 });
  if (await page.$('#intro')) await page.click('#intro');
  await page.waitForSelector('#createForm', { timeout: 6000 });
}

async function createTeam(page, name = 'Teszt csapat') {
  await skipIntro(page);
  await page.fill('#createForm input[name="name"]', name);
  await page.click('#createForm button');
  await page.waitForSelector('.teambar', { timeout: 5000 });
  return (await page.textContent('.teambar .teaminfo strong')).trim();
}

async function joinTeam(page, code) {
  await skipIntro(page);
  await page.fill('#joinForm input[name="code"]', code.toLowerCase());
  await page.click('#joinForm button');
  await page.waitForSelector('.teambar', { timeout: 5000 });
}

// Állapot-váltás a böngésző saját munkamenetével (a UI-n kívüli előkészítéshez)
async function api(page, url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return r.json();
    },
    { url, body }
  );
}

async function uploadStatue(page, buf = PNG_1PX, { consent = true } = {}) {
  await page.setInputFiles('input[type="file"]', { name: 'pose.png', mimeType: 'image/png', buffer: buf });
  await page.waitForSelector('#preview:not([hidden])', { timeout: 5000 });
  if (consent) await page.check('#consent');
  await page.click('form.upload button');
}

// A sorsolt zöld sáv közepéhez tartozó idő (ms)
const hitMs = (z) => ((z.greenStart + z.greenWidth / 2) / z.speed) * 1000;

// Előkészítés az API-n át: a csapat a cápa-állomásig jut
async function toShark(page) {
  await api(page, '/api/game/answer', { value: 'Poszeidón', expectKey: 'who-is-it' });
  await api(page, '/api/game/answer', { value: 'Hádész', expectKey: 'gods' });
  await api(page, '/api/game/answer', { value: 'Zeusz', expectKey: 'quiz-poseidon' });
  await api(page, '/api/game/answer', { value: 'Platón', expectKey: 'quiz-philosopher' });
}

async function waitStage(page, title, timeout = 6000) {
  await page.waitForFunction((t) => document.querySelector('h1') && document.querySelector('h1').textContent.includes(t), title, { timeout });
}

// Mindig megvan az állapot a szerveren: a böngésző oldala a szerver szerinti állomást mutatja
async function serverStage(page) {
  return page.evaluate(async () => (await (await fetch('/api/game')).json()).stage?.id);
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

// ============ tesztek ============

test('telefonon betölt, a nyitóképernyő után a kezdő űrlap látszik, vízszintes görgetés nélkül', async () => {
  const page = await phone();
  await skipIntro(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `vízszintes görgetés: ${overflow}px`);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('320 px-es kijelzőn is nincs vízszintes görgetés a kezdő és a játék-képernyőn', async () => {
  const page = await phone({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await createTeam(page, 'Keskeny');
  await page.waitForSelector('#task');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `320px: ${overflow}px túlcsordulás`);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('csapat létrehozása, és egy második telefon csatlakozik: mindkettő 2/5-öt lát', async () => {
  const a = await phone();
  const code = await createTeam(a, 'Delfinek');
  assert.match(code, /^[A-Z2-9]{5}$/);
  const b = await phone();
  await joinTeam(b, code);
  const ok = await until(async () => (await a.textContent('.teambar .teaminfo')).includes('2/5'), 10000);
  assert.ok(ok, 'az első telefon is látja a második tagot');
  assert.deepEqual(a.errors.concat(b.errors), []);
  await a.close();
  await b.close();
});

test('a csatlakozás hibás kóddal érthető hibaüzenetet ad', async () => {
  const page = await phone();
  await skipIntro(page);
  await page.fill('#joinForm input[name="code"]', 'ZZZZZ');
  await page.click('#joinForm button');
  const msg = await until(async () => {
    const t = await page.textContent('#feedback');
    return /Nincs ilyen csapatkód/.test(t) ? t : null;
  });
  assert.ok(msg, 'hibaüzenet megjelent');
  await page.close();
});

test('a 6. telefon nem csatlakozhat: „betelt" üzenet', async () => {
  const host = await phone();
  const code = await createTeam(host, 'Tele');
  const mates = [];
  for (let i = 0; i < 4; i++) {
    const p = await phone();
    await joinTeam(p, code);
    mates.push(p);
  }
  const extra = await phone();
  await skipIntro(extra);
  await extra.fill('#joinForm input[name="code"]', code);
  await extra.click('#joinForm button');
  const msg = await until(async () => {
    const t = await extra.textContent('#feedback');
    return /betelt/.test(t) ? t : null;
  });
  assert.ok(msg, 'a 6. tag „betelt" üzenetet kapott');
  for (const p of [host, ...mates, extra]) await p.close();
});

test('a régi feladat kétszer koppintva is csak egyszer küld választ', async () => {
  const page = await phone();
  await createTeam(page, 'Dupla');
  await uploadStatue(page);
  await waitStage(page, 'Ki látható a képen');
  let answers = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/game/answer')) answers += 1;
  });
  const btn = page.locator('.option', { hasText: 'Poszeidón' });
  await btn.dispatchEvent('click');
  await btn.dispatchEvent('click');
  await btn.dispatchEvent('click');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(answers, 1, 'egy kattintás = egy kérés');
  await page.close();
});

test('a fotó tömörítődik feltöltés előtt (nagy kép kis méretben megy el)', async () => {
  const page = await phone();
  await createTeam(page, 'Fotós');
  // zajos kép: a PNG-méret így valóban nagy, nem egyszínű
  const big = noisePng(2400, 1600);
  assert.ok(big.length > 200 * 1024, `az eredeti kép nagy: ${big.length}`);
  let sent = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/game/upload')) sent = (r.postDataBuffer() || Buffer.alloc(0)).length;
  });
  await uploadStatue(page, big);
  await until(async () => sent > 0, 6000);
  assert.ok(sent > 0 && sent < big.length * 0.5, `tömörített ${sent} B az eredeti ${big.length} B-ből`);
  await page.close();
});

test('a cápa-kör valódi időzítéssel: 2.9 mp körüli ütés zöld, és továbblép', async () => {
  const page = await phone();
  await createTeam(page, 'Cápa');
  await uploadStatue(page);
  await waitStage(page, 'Ki látható a képen');
  await toShark(page);
  await page.reload();
  await waitStage(page, 'A cápa köre');
  // a sávot a szerver sorsolja: a válaszból számoljuk ki, mikor kell ütni
  const [startRes] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/game/shark/start')),
    page.click('#startShark'),
  ]);
  const zone = (await startRes.json()).shark;
  const ticksVisible = await until(async () => (await page.getAttribute('#greenTicks', 'visibility')) === 'visible');
  assert.ok(ticksVisible, 'a csíkozott cél-sáv látszik (színtévesztőknek is)');
  await new Promise((r) => setTimeout(r, hitMs(zone)));
  await page.click('#pressShark');
  await waitStage(page, 'A szfinx kérdései', 6000).catch(() => {});
  const t = await until(async () => (await serverStage(page)) === 'sphinx', 4000);
  assert.ok(t, 'a szerver is a szfinx állomáson van a zöld ütés után');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('két tag ugyanazt a rejtvényt egyszerre oldja meg: a második „frissítjük" üzenetet kap', async () => {
  const a = await phone();
  const code = await createTeam(a, 'Egyidejű');
  const b = await phone();
  await joinTeam(b, code);
  await uploadStatue(a);
  await waitStage(a, 'Ki látható a képen');
  await toShark(a);
  const zone = (await api(a, '/api/game/shark/start')).shark;
  await api(a, '/api/game/shark/press', { elapsedMs: hitMs(zone), expectKey: 'shark' });
  await a.reload();
  await waitStage(a, 'A szfinx kérdései');
  // B még a régi (első) rejtvényt látja: a böngésző állapota ezért a szerveréhez képest elavult
  await b.reload();
  await waitStage(b, 'A szfinx kérdései');
  await b.evaluate(() => {});
  await a.fill('form.answer input', 'ember');
  await a.click('form.answer button');
  await until(async () => (await serverStage(a)) === 'sphinx');
  // B elavult nézetből válaszol: a szerver „stale"-t ad, B újra-rendereli, és nem léptet
  await b.fill('form.answer input', 'ember');
  await b.click('form.answer button');
  const msg = await until(async () => {
    const t = await b.textContent('#feedback');
    return /megoldódott/.test(t) ? t : null;
  });
  assert.ok(msg, 'B „frissítjük" üzenetet kapott');
  const counter = await until(async () => (await b.textContent('.counter')).includes('2 / 3'));
  assert.ok(counter, 'B már a második rejtvényt látja');
  for (const p of [a, b]) assert.deepEqual(p.errors, []);
  await a.close();
  await b.close();
});

test('hálózati hiba után a gombok újra használhatók, és a játék nem ragad be', async () => {
  const page = await phone();
  await createTeam(page, 'Hálózat');
  await uploadStatue(page);
  await waitStage(page, 'Ki látható a képen');
  await page.route('**/api/game/answer', (r) => r.abort());
  await page.click('.option:has-text("Poszeidón")');
  const msg = await until(async () => {
    const t = await page.textContent('#feedback');
    return /Nincs kapcsolat|nem válaszolt/.test(t) ? t : null;
  });
  assert.ok(msg, 'hálózati hibaüzenet jelent meg');
  await page.unroute('**/api/game/answer');
  const enabled = await until(async () => page.isEnabled('.option:has-text("Poszeidón")'));
  assert.ok(enabled, 'a gomb újra kattintható');
  await page.click('.option:has-text("Poszeidón")');
  await waitStage(page, 'Istenek felismerése', 6000);
  await page.close();
});

test('szerver-hiba (500) nem omlasztja a felületet', async () => {
  const page = await phone();
  await createTeam(page, 'Hiba');
  await uploadStatue(page);
  await waitStage(page, 'Ki látható a képen');
  await page.route('**/api/game/answer', (r) =>
    r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Váratlan szerverhiba. Próbáld újra!"}' })
  );
  await page.click('.option:has-text("Poszeidón")');
  const msg = await until(async () => {
    const t = await page.textContent('#feedback');
    return /szerverhiba/.test(t) ? t : null;
  });
  assert.ok(msg);
  assert.ok(await page.isVisible('#task'), 'a feladat-kártya látszik maradt');
  await page.close();
});

test('offline újratöltés: a játék felülete a gyorsítótárból betölt, és jelzi a hiányzó kapcsolatot', async () => {
  const page = await phone();
  await createTeam(page, 'Offline');
  // megvárjuk, míg a service worker átveszi az oldalt
  await until(async () =>
    page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.ready;
      return !!navigator.serviceWorker.controller || true;
    })
  );
  await new Promise((r) => setTimeout(r, 800));
  await page.context().setOffline(true);
  await page.reload();
  const shell = await until(async () => (await page.textContent('body')).includes('Atlantisz elveszett városa'), 6000);
  assert.ok(shell, 'az app-váz a gyorsítótárból betöltött');
  await page.context().setOffline(false);
  await page.close();
});

test('csökkentett mozgás beállítás: a könnyű mód bekapcsol', async () => {
  const page = await phone({ ...MOBILE, reducedMotion: 'reduce' });
  await skipIntro(page);
  const lite = await page.evaluate(() => document.documentElement.classList.contains('lite'));
  assert.equal(lite, true);
  await page.close();
});

test('a csapatból való kilépés visszavisz a kezdő képernyőre', async () => {
  const page = await phone();
  await createTeam(page, 'Kilépő');
  page.once('dialog', (d) => d.accept());
  await page.click('#leave');
  await page.waitForSelector('#createForm', { timeout: 5000 });
  const state = await page.evaluate(async () => (await fetch('/api/game')).json());
  assert.equal(state.started, false);
  await page.close();
});

test('admin felület: belépés, élő csapatlista, átléptetés, és a játékos telefonja követi', async () => {
  const player = await phone();
  await createTeam(player, 'Admin-figyelt');
  const adminPage = await phone({ viewport: { width: 1280, height: 900 } });
  // a játékos telefonján az admin cím nem létezik
  const resp = await player.goto(srv.base + '/admin');
  assert.equal(resp.status(), 404);
  assert.match(await player.textContent('h1'), /Nincs ilyen oldal/);
  await player.goto(srv.base + '/');
  await player.waitForSelector('.station-head', { timeout: 6000 });
  // a szervezői link beléptet, és a címsorból eltűnik a kulcs
  await adminPage.goto(srv.base + '/admin/' + TEST_ADMIN_KEY);
  assert.equal(new URL(adminPage.url()).pathname, '/admin');
  await adminPage.waitForSelector('.team', { timeout: 6000 });
  const card = adminPage.locator('.team', { hasText: 'Admin-figyelt' });
  assert.equal(await card.count(), 1, 'a csapat megjelent az admin listában');
  assert.match(await card.textContent(), /Az élő szobor/);
  adminPage.once('dialog', (d) => d.accept());
  await card.locator('button[data-action="advance"]').click();
  const moved = await until(async () => /Ki látható a képen/.test(await adminPage.locator('.team', { hasText: 'Admin-figyelt' }).textContent()), 6000);
  assert.ok(moved, 'az admin listában átkerült');
  await waitStage(player, 'Ki látható a képen', 10000);
  assert.deepEqual(adminPage.errors, [], 'nincs konzolhiba (CSP-sértés sem)');
  assert.deepEqual(player.errors, []);
  await adminPage.close();
  await player.close();
});

test('admin felület mobilon: nincs vízszintes görgetés', async () => {
  const adminPage = await phone();
  await adminPage.goto(srv.base + '/admin/' + TEST_ADMIN_KEY);
  await adminPage.waitForSelector('.tiles', { timeout: 6000 });
  const overflow = await adminPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `vízszintes görgetés: ${overflow}px`);
  assert.deepEqual(adminPage.errors, []);
  await adminPage.close();
});

test('fotó: beleegyezés nélkül a felület nem küldi el, és figyelmeztet', async () => {
  const page = await phone();
  await createTeam(page, 'Beleegyezés');
  let sent = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/game/upload')) sent += 1;
  });
  await uploadStatue(page, PNG_1PX, { consent: false });
  const msg = await until(async () => /hozzájárultak/.test(await page.textContent('#feedback')));
  assert.ok(msg, 'figyelmeztető üzenet');
  assert.equal(sent, 0, 'nem ment kérés a szerverre');
  assert.ok(await page.isVisible('a[href="/adatvedelem"]'), 'a tájékoztató linkje elérhető');
  await page.close();
});

test('merülés-animáció: állomásváltáskor megjelenik a mélység-számláló, és utána eltűnik', async () => {
  const page = await phone();
  await createTeam(page, 'Búvárok');
  await uploadStatue(page);
  const dive = await page.waitForSelector('.dive', { timeout: 6000 });
  assert.ok(dive, 'a merülés-réteg megjelent');
  const gone = await until(async () => (await page.$('.dive')) === null, 6000);
  assert.ok(gone, 'a réteg eltűnt, nem marad a képernyőn');
  await waitStage(page, 'Ki látható a képen');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('segítség gomb: visszaszámlál, 2 rossz válasz után kérhető, és megjeleníti a tippet', async () => {
  const page = await phone();
  await createTeam(page, 'Segítséget');
  await uploadStatue(page);
  await waitStage(page, 'Ki látható a képen');
  await page.click('.option:has-text("Széchenyi István")'); // itt mindkét válasz helyes
  await waitStage(page, 'Istenek felismerése', 6000);
  assert.match(await page.textContent('#hintbox'), /múlva/);
  await page.click('.option:has-text("Zeusz")');
  await until(async () => /Nem ez/.test(await page.textContent('#feedback')));
  await until(async () => page.isEnabled('.option:has-text("Héphaisztosz")'));
  await page.click('.option:has-text("Héphaisztosz")');
  await page.waitForSelector('#hintBtn', { timeout: 6000 });
  page.once('dialog', (d) => d.accept());
  await page.click('#hintBtn');
  const shown = await until(async () => /háromfejű kutya/.test((await page.textContent('#hintbox')) || ''));
  assert.ok(shown, 'a tipp megjelent');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('záróképernyő: menetidő, helyezés és a csapat saját fotója', async () => {
  const page = await phone();
  await createTeam(page, 'Célba érők');
  await uploadStatue(page);
  await waitStage(page, 'Ki látható a képen');
  await toShark(page);
  const zone = (await api(page, '/api/game/shark/start')).shark;
  await api(page, '/api/game/shark/press', { elapsedMs: hitMs(zone), expectKey: 'shark' });
  for (const [value, key] of [['ember', 'sphinx#0'], ['sötétség', 'sphinx#1'], ['térkép', 'sphinx#2'], ['TITKOS', 'old-message'], ['ATLANTISZ', 'atlantis-gate']]) {
    await api(page, '/api/game/answer', { value, expectKey: key });
  }
  await page.reload();
  await page.waitForSelector('.finale', { timeout: 6000 });
  assert.match(await page.textContent('.result'), /1\./);
  const img = await page.waitForSelector('.finale .photo-grid img', { timeout: 6000 });
  const loaded = await until(async () => img.evaluate((el) => el.complete && el.naturalWidth > 0));
  assert.ok(loaded, 'a saját fotó betöltött');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('kivetíthető ranglista: betölt, mutatja a csapatokat, nincs konzolhiba', async () => {
  const player = await phone();
  await createTeam(player, 'Kivetített');
  const board = await phone({ viewport: { width: 1920, height: 1080 } });
  await board.goto(srv.base + '/ranglista');
  await board.waitForSelector('.row', { timeout: 8000 });
  const data = await board.evaluate(async () => (await fetch('/api/leaderboard')).json());
  assert.ok(data.teams.some((t) => t.name === 'Kivetített'), 'a csapat szerepel a ranglistán');
  const rows = await board.$$eval('.row .name', (els) => els.map((e) => e.textContent));
  assert.equal(rows.length, Math.min(12, data.teams.length), 'legfeljebb 12 sor a kivetítőn');
  assert.equal(rows[0], data.teams[0].name, 'a sorrend a szerver szerinti');
  if (data.teams.length > 12) assert.match(await board.textContent('#more'), /még \d+ csapat/);
  assert.equal((await board.textContent('body')).includes(await player.textContent('.teambar .teaminfo strong')), false, 'a csapatkód nem látszik');
  assert.deepEqual(board.errors, []);
  await board.close();
  await player.close();
});

test('adatkezelési tájékoztató: elérhető a láblécből, telefonon is olvasható', async () => {
  const page = await phone();
  await skipIntro(page);
  await page.click('.site-footer a[href="/adatvedelem"]');
  await page.waitForSelector('h1', { timeout: 5000 });
  assert.match(await page.textContent('h1'), /Adatkezelési tájékoztató/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `vízszintes görgetés: ${overflow}px`);
  assert.deepEqual(page.errors, []);
  await page.close();
});


test('admin: minden egy felületen – fülek, ranglista, napló, fotók, ellenőrzőlista és QR-kód', async () => {
  const player = await phone();
  await createTeam(player, 'Fülező');
  await uploadStatue(player);
  const adminPage = await phone({ viewport: { width: 1280, height: 900 } });
  await adminPage.goto(srv.base + '/admin/' + TEST_ADMIN_KEY);
  await adminPage.waitForSelector('.tabs', { timeout: 6000 });

  // a hiányzó beállításokra figyelmeztető sáv a Beállítások fülre visz
  assert.ok(await adminPage.isVisible('button.banner'), 'figyelmeztető sáv látszik');

  await adminPage.click('[data-tab="ranglista"]');
  assert.match(await adminPage.textContent('.tab-body'), /Fülező/);
  assert.ok(await adminPage.isVisible('a[href="/ranglista"]'), 'a kivetítő nézet innen nyitható');

  await adminPage.click('[data-tab="naplo"]');
  const log = await adminPage.textContent('.events');
  assert.match(log, /Csapat létrehozva/);
  assert.match(log, /Fotót töltött fel/);

  await adminPage.click('[data-tab="fotok"]');
  const photo = await adminPage.waitForSelector('.gallery-team img', { timeout: 6000 });
  assert.ok(await until(async () => photo.evaluate((el) => el.complete && el.naturalWidth > 0)), 'a fotó betöltött');

  await adminPage.click('button.banner');
  await adminPage.waitForSelector('.checks', { timeout: 6000 });
  assert.match(await adminPage.textContent('.checks'), /A feladatok képei megvannak/);
  const qr = await adminPage.waitForSelector('.qr img');
  assert.ok(await until(async () => qr.evaluate((el) => el.complete && el.naturalWidth > 0)), 'a QR-kód betöltött');
  assert.ok(await adminPage.isVisible('a[href="/api/admin/qr.png?download=1"]'), 'letölthető');

  // szervezői hozzáférés: a QR csak kérésre jelenik meg, a link másolható
  assert.equal(await adminPage.locator('.access img').count(), 0, 'a szervezői QR alapból rejtve');
  await adminPage.click('[data-action="show-access"]');
  const accessQr = await adminPage.waitForSelector('.access img');
  assert.ok(await until(async () => accessQr.evaluate((el) => el.complete && el.naturalWidth > 0)), 'a szervezői QR betöltött');
  assert.ok((await adminPage.inputValue('#accessLink')).endsWith('/admin/' + TEST_ADMIN_KEY));

  // a választott fül újratöltés után is megmarad
  await adminPage.reload();
  await adminPage.waitForSelector('.checks', { timeout: 6000 });
  assert.equal(await adminPage.getAttribute('.tabs [data-tab="beallitasok"]', 'aria-selected'), 'true');

  assert.deepEqual(adminPage.errors, [], 'nincs konzolhiba (CSP-sértés sem)');
  await adminPage.close();
  await player.close();
});

test('célba ért csapat: élő ranglista a telefonon, saját csapat kiemelve, és frissül', async () => {
  const finishViaApi = async (page) => {
    await toShark(page);
    const zone = (await api(page, '/api/game/shark/start')).shark;
    await api(page, '/api/game/shark/press', { elapsedMs: hitMs(zone), expectKey: 'shark' });
    for (const [value, key] of [['ember', 'sphinx#0'], ['sötétség', 'sphinx#1'], ['térkép', 'sphinx#2'], ['TITKOS', 'old-message'], ['ATLANTISZ', 'atlantis-gate']]) {
      await api(page, '/api/game/answer', { value, expectKey: key });
    }
  };
  const winner = await phone();
  await createTeam(winner, 'Élő-figyelők');
  await uploadStatue(winner);
  await waitStage(winner, 'Ki látható a képen');
  await finishViaApi(winner);
  await winner.reload();
  await winner.waitForSelector('.finale', { timeout: 6000 });
  const me = await winner.waitForSelector('#liveBoard li.me', { timeout: 8000 });
  assert.match(await me.textContent(), /Élő-figyelők/);
  assert.match(await me.textContent(), /\(ti\)/);

  // egy másik csapat is célba ér: a nyertes telefonján élőben megjelenik
  const other = await phone();
  await createTeam(other, 'Későn-érkezők');
  await uploadStatue(other);
  await waitStage(other, 'Ki látható a képen');
  await finishViaApi(other);
  const updated = await until(async () => (await winner.textContent('#liveBoard')).includes('Későn-érkezők'), 15000);
  assert.ok(updated, 'a másik csapat megjelent a ranglistán, újratöltés nélkül');
  const overflow = await winner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `vízszintes görgetés: ${overflow}px`);
  assert.deepEqual(winner.errors, []);
  await winner.close();
  await other.close();
});

test('élő háttér (WebGL): elindul, nincs konzolhiba; csökkentett mozgásnál és WebGL nélkül a CSS-háttér marad', async () => {
  const gpu = await chromium.launch({
    executablePath: EXEC,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    const open = async (opts) => {
      const ctx = await gpu.newContext({ ...MOBILE, ...opts });
      await ctx.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }));
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
      await page.goto(srv.base + '/');
      return page;
    };
    const page = await open({ reducedMotion: 'no-preference' });
    assert.ok(await until(async () => page.evaluate(() => document.documentElement.classList.contains('gl')), 8000), 'a WebGL-háttér elindult');
    const info = await page.evaluate(() => {
      const c = document.querySelector('canvas.ocean');
      return { w: c.width, h: c.height, cssW: c.clientWidth, rays: getComputedStyle(document.querySelector('.rays')).display };
    });
    assert.ok(info.w >= info.cssW, 'legalább CSS-pixel felbontású (élesség)');
    assert.equal(info.rays, 'none', 'a CSS-fénysugarak helyét átveszi');
    // a nyitóképernyő alatt a tartalom nem dereng át
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.site-footer')).visibility), 'hidden');
    await page.click('#intro');
    await page.waitForSelector('#createForm', { timeout: 6000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.site-footer')).visibility), 'visible');
    assert.deepEqual(page.errors, []);
    await page.context().close();

    const still = await open({ reducedMotion: 'reduce' });
    await still.waitForTimeout(600);
    assert.equal(await still.locator('canvas.ocean').count(), 0, 'csökkentett mozgás: könnyű mód, nincs WebGL');
    assert.deepEqual(await still.evaluate(() => [...document.documentElement.classList]), ['lite']);
    await still.context().close();

    // WebGL nélkül (pl. régi eszköz): nincs hiba, a CSS-háttér látszik
    const ctx = await gpu.newContext({ ...MOBILE, reducedMotion: 'no-preference' });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/.test(type) ? null : orig.call(this, type, ...rest);
      };
    });
    const nogl = await ctx.newPage();
    const errs = [];
    nogl.on('pageerror', (e) => errs.push(String(e)));
    await nogl.goto(srv.base + '/');
    await nogl.click('#intro');
    await nogl.waitForSelector('#createForm', { timeout: 6000 });
    assert.equal(await nogl.evaluate(() => document.documentElement.classList.contains('gl')), false);
    assert.deepEqual(errs, []);
    await ctx.close();

    // a kivetítő ranglistán is
    const board = await (await gpu.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const boardErrs = [];
    board.on('pageerror', (e) => boardErrs.push(String(e)));
    board.on('console', (m) => m.type() === 'error' && boardErrs.push(m.text()));
    await board.goto(srv.base + '/ranglista');
    assert.ok(await until(async () => board.evaluate(() => document.documentElement.classList.contains('gl')), 8000));
    assert.deepEqual(boardErrs, []);
    await board.context().close();
  } finally {
    await gpu.close();
  }
});

test('a játékidő lejárta után: a kezdőképernyő jelzi, új csapat nem indítható, nincs konzolhiba', async () => {
  const ended = await startServer({ GAME_END_AT: '2020-01-01 22:00', RESULTS_NOTE: 'Eredményhirdetés 23:00 után!' });
  try {
    const ctx = await browser.newContext(MOBILE);
    contexts.push(ctx);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
    await page.goto(ended.base + '/');
    await page.click('#intro');
    await page.waitForSelector('text=A játék véget ért', { timeout: 6000 });
    assert.match(await page.textContent('#app'), /Eredményhirdetés 23:00 után!/);
    assert.equal(await page.locator('#createForm').count(), 0);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally {
    ended.stop();
  }
});

test('válasz-visszajelzés: középen felugró ablak; rossznál bezárható, helyesnél a következő feladatnál eltűnik', async () => {
  const page = await phone();
  await createTeam(page, 'Ablakosok');
  await uploadStatue(page);
  await waitStage(page, 'Ki látható a képen');
  await page.click('.option:has-text("Poszeidón")');
  await page.waitForSelector('#verdict.is-ok', { timeout: 5000 });
  assert.match(await page.textContent('#verdict'), /Helyes!/);
  const box = await page.locator('.verdict-card').boundingBox();
  const vp = page.viewportSize();
  assert.ok(Math.abs(box.y + box.height / 2 - vp.height / 2) < vp.height * 0.15, 'függőlegesen középen van');
  await waitStage(page, 'Istenek felismerése', 8000);
  assert.equal(await page.locator('#verdict').count(), 0, 'a következő feladatnál eltűnt');
  await page.click('.option:has-text("Zeusz")');
  await page.waitForSelector('#verdict.is-bad', { timeout: 5000 });
  assert.match(await page.textContent('#verdict'), /Nem ez a megoldás/);
  await page.click('#verdictClose');
  assert.equal(await page.locator('#verdict').count(), 0, 'bezárható');
  assert.ok(await page.isVisible('.option:has-text("Hádész")'), 'a feladat újra használható');
  assert.deepEqual(page.errors, []);
  await page.close();
});

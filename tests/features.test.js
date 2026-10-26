'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, Client, photoForm, TEST_ADMIN_KEY } = require('./helpers');

const hitMs = (z) => ((z.greenStart + z.greenWidth / 2) / z.speed) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(env, fn) {
  const srv = await startServer({ RATE_LIMIT_PER_MIN: '1000', ANSWER_RATE_PER_MIN: '100000', ...env });
  try {
    await fn(srv);
  } finally {
    srv.stop();
  }
}

// Egy csapat végigvitele a megadott állomásig (a valódi API-n át)
async function playTo(c, stageId) {
  const steps = {
    statue: () => c.req('POST', '/api/game/upload', photoForm()),
    'who-is-it': () => c.post('/api/game/answer', { value: 'Poszeidón' }),
    gods: () => c.post('/api/game/answer', { value: 'Hádész' }),
    'quiz-poseidon': () => c.post('/api/game/answer', { value: 'Zeusz' }),
    'quiz-philosopher': () => c.post('/api/game/answer', { value: 'Platón' }),
    shark: async () => {
      const z = (await c.post('/api/game/shark/start')).json.shark;
      return c.post('/api/game/shark/press', { elapsedMs: hitMs(z) });
    },
    sphinx: async () => {
      await c.post('/api/game/answer', { value: 'ember' });
      await c.post('/api/game/answer', { value: 'sötétség' });
      return c.post('/api/game/answer', { value: 'térkép' });
    },
    'old-message': () => c.post('/api/game/answer', { value: 'TITKOS' }),
  };
  let s = (await c.get('/api/game')).json;
  while (s.started && !s.finished && s.stage.id !== stageId) {
    const r = await steps[s.stage.id]();
    assert.ok(r.json && r.json.correct, `lépés hibás: ${s.stage.id} ${r.text}`);
    s = (await c.get('/api/game')).json;
  }
  return s;
}

// ---------- tartalom ----------

test('quiz: Platón szerint Zeusz büntette meg Atlantiszt (Poszeidón a védőistene volt)', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Quiz' });
    await playTo(c, 'quiz-poseidon');
    assert.equal((await c.post('/api/game/answer', { value: 'Poszeidón' })).json.correct, false);
    const ok = await c.post('/api/game/answer', { value: 'Zeusz' });
    assert.equal(ok.json.correct, true);
    assert.match(ok.json.message, /Zeusz/);
  });
});

// ---------- mentés ----------

test('mentés: újraindítás után a csapat és a telefon munkamenete is megmarad', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantisz-mentes-'));
  const env = { DATA_FILE: path.join(dir, 'state.json'), SAVE_INTERVAL_MS: '100', SESSION_SECRET: 'ugyanaz-a-titok-ujrainditas-utan' };
  try {
    const first = await startServer(env);
    const c = new Client(first.base);
    const created = await c.post('/api/team/create', { name: 'Túlélők' });
    await c.req('POST', '/api/game/upload', photoForm());
    await c.post('/api/game/answer', { value: 'Poszeidón' });
    await sleep(400);
    await first.stop();

    const second = await startServer(env);
    try {
      assert.match(second.log(), /Mentés visszatöltve: 1 csapat/);
      c.base = second.base; // ugyanaz a telefon (süti), új szerverfolyamat
      const s = (await c.get('/api/game')).json;
      assert.equal(s.started, true, 'a telefon munkamenete megmaradt');
      assert.equal(s.team.code, created.json.team.code);
      assert.equal(s.stage.id, 'gods', 'a haladás megmaradt');
    } finally {
      await second.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mentés: sérült mentésfájl esetén a szerver elindul, és a fájlt félreteszi', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantisz-serult-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ ez nem érvényes json');
  try {
    await withServer({ DATA_FILE: file }, async (srv) => {
      assert.match(srv.log(), /nem olvasható/);
      assert.equal((await new Client(srv.base).get('/api/game')).status, 200);
      assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')), 'a sérült fájl félretéve');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mentés: a fájl nem tartalmazza a megoldásokat', async () => {
  await withServer({ SAVE_INTERVAL_MS: '100', GATE_CODE: 'KAPUTITOK' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Mentett' });
    await sleep(400);
    const text = fs.readFileSync(srv.dataFile, 'utf8');
    assert.match(text, /Mentett/);
    for (const secret of ['KAPUTITOK', 'Hádész', 'sötétség']) assert.equal(text.includes(secret), false, secret);
  });
});

// ---------- segítség ----------

test('segítség: kezdetben nem kérhető, 2 rossz válasz után igen; a szöveg csak kérés után jön', async () => {
  await withServer({ LETTERS_ANSWER: 'TITKOS' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Tippelő' });
    await playTo(c, 'quiz-philosopher');
    let s = (await c.get('/api/game')).json;
    assert.equal(s.stage.hint.available, false);
    assert.equal(s.stage.hint.text, null, 'a tipp szövege nem szivároghat ki előre');
    assert.equal(JSON.stringify(s).includes('Akadémiát'), false);
    assert.equal((await c.post('/api/game/hint', {})).status, 400);

    await c.post('/api/game/answer', { value: 'Thalész' });
    const second = await c.post('/api/game/answer', { value: 'Püthagorasz' });
    assert.equal(second.json.state.stage.hint.available, true);

    const h = await c.post('/api/game/hint', { expectKey: 'quiz-philosopher' });
    assert.equal(h.status, 200);
    assert.match(h.json.hint, /Akadémiát/);
    assert.equal(h.json.state.stage.hint.used, true);

    // ismételt lekérés: nincs újabb büntetés
    await c.post('/api/game/hint', {});
    await c.post('/api/game/answer', { value: 'Platón' });
    const end = await playTo(c, 'atlantis-gate');
    assert.equal(end.stage.id, 'atlantis-gate');
  });
});

test('segítség: idő alapján is elérhetővé válik, és a büntetés bekerül a menetidőbe', async () => {
  await withServer({ HINT_AFTER_MS: '200', HINT_PENALTY_MS: '120000', LETTERS_ANSWER: 'TITKOS' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Türelmes' });
    await sleep(300);
    const s = (await c.get('/api/game')).json;
    assert.equal(s.stage.hint.available, true, 'az idő letelt');
    await c.post('/api/game/hint', {});
    await c.post('/api/game/hint', {});
    await playTo(c, 'atlantis-gate');
    await c.post('/api/game/answer', { value: 'ATLANTISZ' });
    const end = (await c.get('/api/game')).json;
    assert.equal(end.finished, true);
    assert.equal(end.result.penaltyMs, 120000, 'egyszer számít a büntetés');
    assert.equal(end.result.hintsUsed, 1);
    assert.ok(end.result.totalMs >= 120000);
  });
});

test('segítség: a szfinx minden rejtvényéhez külön tipp tartozik', async () => {
  await withServer({ HINT_AFTER_MS: '0' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Szfinx' });
    await playTo(c, 'sphinx');
    const first = await c.post('/api/game/hint', {});
    assert.match(first.json.hint, /bot/);
    await c.post('/api/game/answer', { value: 'ember' });
    const second = (await c.get('/api/game')).json;
    assert.equal(second.stage.hint.used, false, 'a második rejtvény tippje még nincs felhasználva');
    const h2 = await c.post('/api/game/hint', {});
    assert.match(h2.json.hint, /napfény/);
  });
});

// ---------- cápa ----------

test('cápa: a zöld sáv minden indításkor sorsolódik, a megengedett tartományban', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Cápa' });
    await playTo(c, 'shark');
    const starts = new Set();
    for (let i = 0; i < 25; i++) {
      const z = (await c.post('/api/game/shark/start')).json.shark;
      assert.ok(z.greenStart >= 100 && z.greenStart <= 280, `${z.greenStart}`);
      starts.add(z.greenStart);
    }
    assert.ok(starts.size > 5, `változatos sávok: ${[...starts].join(',')}`);
  });
});

test('cápa: a state nem árulja el a sávot indítás előtt, és a régi sáv nem érvényes új indítás után', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Cápa2' });
    const s = await playTo(c, 'shark');
    assert.equal(s.stage.shark.greenStart, undefined);
    let a;
    let b;
    do {
      a = (await c.post('/api/game/shark/start')).json.shark;
      b = (await c.post('/api/game/shark/start')).json.shark;
    } while (Math.abs(a.greenStart - b.greenStart) <= b.greenWidth + 2);
    const r = await c.post('/api/game/shark/press', { elapsedMs: hitMs(a) });
    assert.equal(r.json.correct, false, 'a korábbi sáv közepe már nem talál');
  });
});

// ---------- QR-kapu ----------

test('QR-kapu: a játék böngészőjével szkennelve magától kinyílik, kód nélkül', async () => {
  await withServer({ GATE_QR_SECRET: 'qr-titok', GATE_CODE: 'KAPUKOD', LETTERS_ANSWER: 'TITKOS' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Szkennelők' });
    await playTo(c, 'atlantis-gate');
    const page = await c.get('/kapu/qr-titok');
    assert.match(page.text, /A kapu kinyílt/);
    assert.equal(page.text.includes('KAPUKOD'), false, 'kódot nem kell mutatni');
    assert.equal((await c.get('/api/game')).json.finished, true);
    const again = await c.get('/kapu/qr-titok');
    assert.match(again.text, /Már Atlantiszban vagytok/);
  });
});

test('QR-kapu: idő előtti szkennelés nem nyit, és a kódot sem árulja el', async () => {
  await withServer({ GATE_QR_SECRET: 'qr-titok', GATE_CODE: 'KAPUKOD' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Siető' });
    const page = await c.get('/kapu/qr-titok');
    assert.match(page.text, /még zárva/);
    assert.equal(page.text.includes('KAPUKOD'), false);
    assert.equal((await c.get('/api/game')).json.stage.id, 'statue');
  });
});

test('QR-kapu: más böngészőből (munkamenet nélkül) egyszer használható kódot mutat, a tartalék kódot nem; hibás titokra zárva', async () => {
  await withServer({ GATE_QR_SECRET: 'qr-titok', GATE_CODE: 'KAPUKOD' }, async (srv) => {
    const shown = (await new Client(srv.base).get('/kapu/qr-titok')).text;
    assert.match(shown, /<p class="code">[A-Z0-9]{6}<\/p>/);
    assert.equal(shown.includes('KAPUKOD'), false, 'a közös tartalék kódot sosem mutatja');
    const wrong = await new Client(srv.base).get('/kapu/rossz');
    assert.match(wrong.text, /Zárt kapu/);
    assert.equal(wrong.text.includes('KAPUKOD'), false);
  });
});

test('QR-kapu: a csapatnév escape-elve jelenik meg (XSS ellen)', async () => {
  await withServer({ GATE_QR_SECRET: 'qr-titok' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: '<img src=x onerror=alert(1)>' });
    const page = await c.get('/kapu/qr-titok');
    assert.equal(page.text.includes('<img src=x'), false);
    assert.match(page.text, /&lt;img/);
  });
});

// ---------- záróképernyő és saját fotók ----------

test('záróképernyő: helyezés, menetidő, és a csapat a saját fotóját látja, más nem', async () => {
  await withServer({ LETTERS_ANSWER: 'TITKOS' }, async (srv) => {
    const a = new Client(srv.base);
    await a.post('/api/team/create', { name: 'Első' });
    await playTo(a, 'atlantis-gate');
    await a.post('/api/game/answer', { value: 'ATLANTISZ' });
    const end = (await a.get('/api/game')).json;
    assert.equal(end.result.rank, 1);
    assert.equal(end.result.finishedTeams, 1);
    assert.equal(end.result.photos.length, 1);
    const file = end.result.photos[0];
    assert.equal((await a.get(`/api/game/photos/${file}`)).status, 200);

    const other = new Client(srv.base);
    await other.post('/api/team/create', { name: 'Kíváncsi' });
    assert.equal((await other.get(`/api/game/photos/${file}`)).status, 404, 'más csapat nem látja');
    assert.equal((await new Client(srv.base).get(`/api/game/photos/${file}`)).status, 401);
  });
});

// ---------- ranglista ----------

test('ranglista: nyilvános, sorrendben, és nem árul el csapatkódot', async () => {
  await withServer({ LETTERS_ANSWER: 'TITKOS' }, async (srv) => {
    const fast = new Client(srv.base);
    const slow = new Client(srv.base);
    const f = await fast.post('/api/team/create', { name: 'Gyorsak' });
    const s = await slow.post('/api/team/create', { name: 'Lassúk' });
    await playTo(fast, 'atlantis-gate');
    await fast.post('/api/game/answer', { value: 'ATLANTISZ' });
    await playTo(slow, 'gods');
    const board = await new Client(srv.base).get('/api/leaderboard');
    assert.equal(board.status, 200);
    assert.equal(board.json.teams[0].name, 'Gyorsak');
    assert.equal(board.json.teams[0].rank, 1);
    assert.ok(board.json.teams[0].totalMs >= 0);
    assert.equal(board.json.teams[1].name, 'Lassúk');
    assert.equal(board.json.teams[1].depth, 40);
    for (const code of [f.json.team.code, s.json.team.code]) assert.equal(board.text.includes(code), false);
    assert.equal((await new Client(srv.base).get('/ranglista')).status, 200);
  });
});

test('ranglista: PUBLIC_BOARD=0 esetén kikapcsolva', async () => {
  await withServer({ PUBLIC_BOARD: '0' }, async (srv) => {
    assert.equal((await new Client(srv.base).get('/api/leaderboard')).status, 404);
  });
});

// ---------- GDPR ----------

test('GDPR: hozzájárulás nélkül nem fogad el fotót, és nem is menti el', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Hozzájárulás' });
    const r = await c.req('POST', '/api/game/upload', photoForm(undefined, undefined, undefined, { consent: false }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /hozzájárultak/);
    assert.deepEqual(fs.readdirSync(srv.uploadDir).filter((f) => f !== 'uploads.log'), []);
    assert.equal((await c.get('/api/game')).json.stage.id, 'statue');
  });
});

test('GDPR: a közzétételi hozzájárulás önkéntes, és az admin látja', async () => {
  await withServer({}, async (srv) => {
    const yes = new Client(srv.base);
    const no = new Client(srv.base);
    const y = await yes.post('/api/team/create', { name: 'Igen' });
    const n = await no.post('/api/team/create', { name: 'Nem' });
    await yes.req('POST', '/api/game/upload', photoForm(undefined, undefined, undefined, { publish: true }));
    await no.req('POST', '/api/game/upload', photoForm());
    const admin = new Client(srv.base);
    await admin.get('/admin/' + TEST_ADMIN_KEY);
    const teams = (await admin.get('/api/admin/overview')).json.teams;
    assert.equal(teams.find((t) => t.code === y.json.team.code).photos[0].publish, true);
    assert.equal(teams.find((t) => t.code === n.json.team.code).photos[0].publish, false);
    const log = fs.readFileSync(path.join(srv.uploadDir, 'uploads.log'), 'utf8');
    assert.match(log, /"consent":true/);
  });
});

test('GDPR: a fotók a megőrzési idő után automatikusan törlődnek (lemez, napló, csapat)', async () => {
  // 0,000006 nap ≈ 0,5 másodperc
  await withServer({ PHOTO_RETENTION_DAYS: '0.000006', CLEANUP_INTERVAL_MS: '100' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Múlandó' });
    await c.req('POST', '/api/game/upload', photoForm());
    await sleep(100);
    assert.ok(fs.readdirSync(srv.uploadDir).some((f) => f.endsWith('.png')), 'előbb megvan');
    await sleep(1200);
    assert.equal(fs.readdirSync(srv.uploadDir).some((f) => f.endsWith('.png')), false, 'a fotó törlődött');
    const log = fs.existsSync(path.join(srv.uploadDir, 'uploads.log')) ? fs.readFileSync(path.join(srv.uploadDir, 'uploads.log'), 'utf8') : '';
    assert.equal(log.includes('Múlandó'), false, 'a naplóból is kikerült');
  });
});

test('GDPR: az admin törölheti egy csapat fotóit (törlési kérelem), a napló is tisztul', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    const t = await c.post('/api/team/create', { name: 'Töröljétek' });
    await c.req('POST', '/api/game/upload', photoForm());
    await sleep(100);
    const admin = new Client(srv.base);
    await admin.get('/admin/' + TEST_ADMIN_KEY);
    const r = await admin.post(`/api/admin/teams/${t.json.team.code}/photos/delete`);
    assert.equal(r.json.removed, 1);
    assert.deepEqual(fs.readdirSync(srv.uploadDir).filter((f) => f.endsWith('.png')), []);
    assert.equal(fs.readFileSync(path.join(srv.uploadDir, 'uploads.log'), 'utf8').includes('Töröljétek'), false);
    const team = (await admin.get('/api/admin/overview')).json.teams.find((x) => x.code === t.json.team.code);
    assert.deepEqual(team.photos, []);
  });
});

test('GDPR: a csapat törlésekor a fotói is törlődnek', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    const t = await c.post('/api/team/create', { name: 'Eltűnők' });
    await c.req('POST', '/api/game/upload', photoForm());
    const admin = new Client(srv.base);
    await admin.get('/admin/' + TEST_ADMIN_KEY);
    await admin.post(`/api/admin/teams/${t.json.team.code}/delete`);
    assert.deepEqual(fs.readdirSync(srv.uploadDir).filter((f) => f.endsWith('.png')), []);
  });
});

test('GDPR: a tájékoztató kitöltendő mezőket jelöl, a megadott adatokat escape-elve mutatja', async () => {
  await withServer({ PRIVACY_CONTROLLER: '', PRIVACY_CONTACT: '' }, async (srv) => {
    const r = await new Client(srv.base).get('/adatvedelem');
    assert.equal(r.status, 200);
    assert.match(r.text, /kitöltendő: a szervező szervezet neve/);
    assert.match(r.text, /Falk Miksa utca 9–11/);
    assert.match(r.text, /ugyfelszolgalat@naih\.hu/);
    assert.match(srv.log(), /hiányzik az adatkezelő/);
  });
  await withServer(
    {
      PRIVACY_CONTROLLER: 'Teszt HÖK <script>x</script>',
      PRIVACY_CONTACT: 'adat@pelda.hu',
      PRIVACY_HOSTING: 'Saját laptop',
      PRIVACY_UPDATED: '2026. október 13.',
      PHOTO_RETENTION_DAYS: '14',
    },
    async (srv) => {
      const r = await new Client(srv.base).get('/adatvedelem');
      assert.match(r.text, /Teszt HÖK &lt;script&gt;/);
      assert.equal(r.text.includes('<script>x'), false);
      assert.match(r.text, /adat@pelda\.hu/);
      assert.match(r.text, /14 nap/);
      assert.equal(r.text.includes('kitöltendő'), false);
      assert.doesNotMatch(srv.log(), /hiányzik az adatkezelő/);
    }
  );
});

test('GDPR: egyetlen oldal sem tölt be külső erőforrást (pl. Google Fonts)', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    await c.get('/admin/' + TEST_ADMIN_KEY);
    for (const url of ['/', '/admin', '/ranglista', '/adatvedelem', '/kapu/x', '/css/style.css', '/fonts/fonts.css']) {
      const r = await c.get(url);
      assert.equal(r.status, 200, url);
      assert.doesNotMatch(r.text, /(src|href)=["']?https?:\/\/(?!www\.naih\.hu)/, `${url}: külső erőforrás`);
      assert.doesNotMatch(r.text, /url\(["']?https?:/, `${url}: külső CSS-erőforrás`);
      assert.equal(r.text.includes('googleapis'), false, url);
    }
    const csp = (await c.get('/')).headers.get('content-security-policy');
    assert.match(csp, /font-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /googleapis|gstatic/);
  });
});

test('állapot-ellenőrzés: /healthz válaszol, és nem árul el semmit', async () => {
  await withServer({}, async (srv) => {
    const r = await new Client(srv.base).get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  });
});

// ---------- újraindítás hosszabb leállás után ----------

// Elkészít egy mentést, majd úgy „öregíti", mintha a szerver `hoursAgo` órával ezelőtt állt volna le
async function agedSave(hoursAgo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantisz-leallas-'));
  const env = { DATA_FILE: path.join(dir, 'state.json'), SAVE_INTERVAL_MS: '100', SESSION_SECRET: 'ugyanaz-a-titok-leallas-utan' };
  const first = await startServer(env);
  const c = new Client(first.base);
  await c.post('/api/team/create', { name: 'Szünetelők' });
  await c.req('POST', '/api/game/upload', photoForm());
  await sleep(400);
  await first.stop();
  const shift = hoursAgo * 3600 * 1000;
  const data = JSON.parse(fs.readFileSync(env.DATA_FILE, 'utf8'));
  data.savedAt -= shift;
  for (const t of data.teams) {
    t.lastActive -= shift;
    t.members = t.members.map(([sid, seen]) => [sid, seen - shift]);
  }
  data.sessions = data.sessions.map(([sid, e]) => [sid, { ...e, expires: e.expires - shift }]);
  fs.writeFileSync(env.DATA_FILE, JSON.stringify(data));
  return { dir, env, c };
}

test('újraindítás 4 órás leállás után: a játékosok nem esnek ki, ott folytatják, ahol abbahagyták', async () => {
  const { dir, env, c } = await agedSave(4);
  const srv = await startServer(env);
  try {
    assert.match(srv.log(), /leállást jóváírtam/);
    c.base = srv.base;
    const s = (await c.get('/api/game')).json;
    assert.equal(s.started, true, 'a telefon még a csapat tagja');
    assert.equal(s.stage.id, 'who-is-it', 'a haladás megmaradt');
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('újraindítás több mint 12 órás leállás után: a régi játék nem éled újra', async () => {
  const { dir, env, c } = await agedSave(13);
  const srv = await startServer(env);
  try {
    assert.doesNotMatch(srv.log(), /leállást jóváírtam/);
    c.base = srv.base;
    assert.equal((await c.get('/api/game')).json.started, false);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- a játék vége (GAME_END_AT) ----------

test('játékidő: a vége után nincs új csapat, csatlakozás és válasz; a kapu zárva; a ranglista jelzi', async () => {
  // először fut a játék, létrejön egy csapat; aztán „lejár" (újraindítás múltbeli időponttal, ugyanazzal a mentéssel)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantisz-vege-'));
  const env = { DATA_FILE: path.join(dir, 'state.json'), SAVE_INTERVAL_MS: '100', SESSION_SECRET: 'vege-teszt-titok', RESULTS_NOTE: 'Eredményhirdetés 23:00 után!' };
  const first = await startServer({ ...env, GAME_END_AT: '2099-10-27 22:00' });
  const c = new Client(first.base);
  let code;
  try {
    const r = await c.post('/api/team/create', { name: 'Késők' });
    code = r.json.team.code;
    assert.equal(r.json.game.ended, false);
    assert.equal(r.json.game.endClock, '22:00');
    await new Promise((res) => setTimeout(res, 400));
  } finally {
    await first.stop();
  }
  await new Promise((res) => setTimeout(res, 200));
  const srv = await startServer({ ...env, GAME_END_AT: '2020-01-01 22:00' });
  try {
    c.base = srv.base;
    const s = (await c.get('/api/game')).json;
    assert.equal(s.started, true, 'a csapat megmaradt');
    assert.equal(s.game.ended, true);
    assert.equal(s.game.note, 'Eredményhirdetés 23:00 után!');
    for (const [url, body] of [['/api/game/answer', { value: 'x' }], ['/api/game/hint', {}], ['/api/game/shark/start', {}]]) {
      const r = await c.post(url, body);
      assert.equal(r.status, 403, url);
      assert.equal(r.json.ended, true);
      assert.match(r.json.error, /22:00-kor véget ért.*23:00/);
      assert.equal(r.json.state.started, true);
    }
    const up = await c.req('POST', '/api/game/upload', photoForm());
    assert.equal(up.status, 403);
    const other = new Client(srv.base);
    assert.equal((await other.post('/api/team/create', { name: 'Új' })).status, 403);
    assert.equal((await other.post('/api/team/join', { code })).status, 403);
    assert.match((await c.get('/kapu/qr-kapu-2026')).text, /A kapu bezárult/);
    const board = (await other.get('/api/leaderboard')).json;
    assert.equal(board.game.ended, true);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hibás GAME_END_AT esetén a szerver nem indul el, érthető hibával', async () => {
  await assert.rejects(startServer({ GAME_END_AT: 'holnap este' }), /GAME_END_AT/);
});

test('QR-kapu: minden beolvasás új kódot ad, egy kód csak egyszer nyit; közös kapukód alapból nincs', async () => {
  await withServer({ GATE_QR_SECRET: 'qr-titok', GATE_CODE: '', LETTERS_ANSWER: 'TITKOS' }, async (srv) => {
    const codeOf = async () => /<p class="code">([A-Z0-9]{6})<\/p>/.exec((await new Client(srv.base).get('/kapu/qr-titok')).text)[1];
    const a = new Client(srv.base);
    const b = new Client(srv.base);
    await a.post('/api/team/create', { name: 'Megtalálók' });
    await b.post('/api/team/create', { name: 'Hallgatózók' });
    await playTo(a, 'atlantis-gate');
    await playTo(b, 'atlantis-gate');
    const c1 = await codeOf();
    const c2 = await codeOf();
    assert.notEqual(c1, c2, 'minden beolvasás új kódot ad');
    assert.equal((await b.post('/api/game/answer', { value: 'ATLANTISZ' })).json.correct, false, 'nincs közös kód');
    const ok = await a.post('/api/game/answer', { value: c1.toLowerCase() });
    assert.equal(ok.json.correct, true);
    assert.equal(ok.json.state.finished, true);
    assert.equal((await b.post('/api/game/answer', { value: c1 })).json.correct, false, 'a bemondott, már felhasznált kód nem nyit');
    assert.equal((await b.post('/api/game/answer', { value: c2 })).json.correct, true);
  });
});

test('QR-kapu: a lejárt egyszer használható kód nem nyit', async () => {
  await withServer({ GATE_QR_SECRET: 'qr-titok', GATE_CODE: '', GATE_CODE_TTL_MIN: '0.003', LETTERS_ANSWER: 'TITKOS' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Lassúk' });
    await playTo(c, 'atlantis-gate');
    const code = /<p class="code">([A-Z0-9]{6})<\/p>/.exec((await new Client(srv.base).get('/kapu/qr-titok')).text)[1];
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await c.post('/api/game/answer', { value: code })).json.correct, false);
  });
});

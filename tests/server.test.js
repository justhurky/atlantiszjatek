'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, Client, photoForm, PNG_1PX, allKeys } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const LETTERS = 'TITKOS';
const GATE = 'ATLANTISZ';

let srv;
before(async () => {
  srv = await startServer({
    LETTERS_ANSWER: LETTERS,
    GATE_CODE: GATE,
    GATE_QR_SECRET: 'teszt-kapu',
    RATE_LIMIT_PER_MIN: '1000',
    ANSWER_RATE_PER_MIN: '100000',
  });
});
after(() => srv && srv.stop());

const newClient = () => new Client(srv.base);

// A sorsolt zöld sáv közepéhez tartozó idő (ms): ott biztosan talál az ütés
const hitMs = (z) => ((z.greenStart + z.greenWidth / 2) / z.speed) * 1000;
const angleMs = (z, deg) => (deg / z.speed) * 1000;

// Egy csapat, egy tagja (a kliens) létrehozza
async function newTeam(name = 'Teszt') {
  const c = newClient();
  const r = await c.post('/api/team/create', { name });
  assert.equal(r.status, 200, 'csapat-létrehozás');
  return { client: c, code: r.json.team.code, state: r.json };
}

// Végigviszi a csapatot a választós/rejtvényes állomásokon a megadott állomásig
async function playTo(c, stageId) {
  let s = (await c.get('/api/game')).json;
  const steps = {
    statue: () => c.req('POST', '/api/game/upload', photoForm()),
    'who-is-it': () => c.post('/api/game/answer', { value: 'Poszeidón' }),
    gods: () => c.post('/api/game/answer', { value: 'Hádész' }),
    'quiz-poseidon': () => c.post('/api/game/answer', { value: 'Zeusz' }),
    'quiz-philosopher': () => c.post('/api/game/answer', { value: 'Platón' }),
    shark: async () => {
      const start = await c.post('/api/game/shark/start');
      return c.post('/api/game/shark/press', { elapsedMs: hitMs(start.json.shark) });
    },
    'old-message': () => c.post('/api/game/answer', { value: LETTERS }),
    sphinx: async () => {
      await c.post('/api/game/answer', { value: 'ember' });
      await c.post('/api/game/answer', { value: 'sötétség' });
      return c.post('/api/game/answer', { value: 'térkép' });
    },
  };
  while (s.started && !s.finished && s.stage.id !== stageId) {
    assert.ok(steps[s.stage.id], `nincs lépés ehhez: ${s.stage.id}`);
    const r = await steps[s.stage.id]();
    assert.ok(r.json && r.json.correct, `lépés hibás: ${s.stage.id} ${r.text}`);
    s = (await c.get('/api/game')).json;
  }
  return s;
}

describe('állapot és csapat-létrehozás', () => {
  test('új munkamenet: nincs csapat', async () => {
    const r = await newClient().get('/api/game');
    assert.equal(r.json.started, false);
    assert.deepEqual(r.json.game, { endsAt: null, endClock: '', ended: false, note: '' });
  });

  test('csapat-létrehozás: kód a megengedett karakterekből, 5 hosszú', async () => {
    for (let i = 0; i < 20; i++) {
      const { code } = await newTeam();
      assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  test('név: levágódik 40 karakterre, üres név helyett alapértelmezett', async () => {
    const long = await newTeam('x'.repeat(100));
    assert.equal(long.state.team.name.length, 40);
    const empty = newClient();
    const r = await empty.post('/api/team/create', { name: '   ' });
    assert.equal(r.json.team.name, 'Kalandor csapat');
  });

  test('hiányzó név is működik (nincs body)', async () => {
    const r = await newClient().req('POST', '/api/team/create');
    assert.equal(r.status, 200);
    assert.equal(r.json.team.name, 'Kalandor csapat');
  });

  test('új csapat létrehozásakor a régi csapatból kilép', async () => {
    const a = await newTeam('A');
    const b = newClient();
    await b.post('/api/team/join', { code: a.code });
    assert.equal((await a.client.get('/api/game')).json.team.members, 2);
    await b.post('/api/team/create', { name: 'B' });
    assert.equal((await a.client.get('/api/game')).json.team.members, 1);
  });
});

describe('csatlakozás és 5 fős korlát', () => {
  test('kisbetűs és szóközös kód is elfogadott', async () => {
    const host = await newTeam();
    const messy = ' ' + host.code.toLowerCase().split('').join(' ') + ' ';
    const r = await newClient().post('/api/team/join', { code: messy });
    assert.equal(r.status, 200);
    assert.equal(r.json.team.code, host.code);
  });

  test('ismeretlen és üres kód: 404', async () => {
    const c = newClient();
    assert.equal((await c.post('/api/team/join', { code: 'ZZZZZ' })).status, 404);
    assert.equal((await c.post('/api/team/join', { code: '' })).status, 404);
    assert.equal((await c.post('/api/team/join', {})).status, 404);
  });

  test('pontosan 5 tag fér el, a 6. 409-et kap', async () => {
    const host = await newTeam();
    const others = [];
    for (let i = 0; i < 4; i++) {
      const c = newClient();
      const r = await c.post('/api/team/join', { code: host.code });
      assert.equal(r.status, 200);
      others.push(c);
    }
    assert.equal((await host.client.get('/api/game')).json.team.members, 5);
    const sixth = newClient();
    const r = await sixth.post('/api/team/join', { code: host.code });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /betelt/);
  });

  test('párhuzamos csatlakozás: 20 kérésből pontosan 4 fér be a tulajdonos mellé', async () => {
    const host = await newTeam();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => newClient().post('/api/team/join', { code: host.code }))
    );
    const ok = results.filter((r) => r.status === 200).length;
    const full = results.filter((r) => r.status === 409).length;
    assert.equal(ok, 4);
    assert.equal(full, 16);
    assert.equal((await host.client.get('/api/game')).json.team.members, 5);
  });

  test('már tag újra csatlakozhat a betelt csapatba (nem foglal második helyet)', async () => {
    const host = await newTeam();
    for (let i = 0; i < 4; i++) await newClient().post('/api/team/join', { code: host.code });
    const r = await host.client.post('/api/team/join', { code: host.code });
    assert.equal(r.status, 200);
    assert.equal(r.json.team.members, 5);
  });

  test('egy tag másik csapatba lépésekor az előzőből kikerül', async () => {
    const a = await newTeam('A');
    const b = await newTeam('B');
    const c = newClient();
    await c.post('/api/team/join', { code: a.code });
    await c.post('/api/team/join', { code: b.code });
    assert.equal((await a.client.get('/api/game')).json.team.members, 1);
    assert.equal((await b.client.get('/api/game')).json.team.members, 2);
  });

  test('a betelt csapatba nem lehet belépni, még akkor sem, ha az egyik tag közben kilépett és egy új jön', async () => {
    const host = await newTeam();
    const mates = [];
    for (let i = 0; i < 4; i++) {
      const c = newClient();
      await c.post('/api/team/join', { code: host.code });
      mates.push(c);
    }
    await mates[0].post('/api/team/leave');
    const newcomer = await newClient().post('/api/team/join', { code: host.code });
    assert.equal(newcomer.status, 200, 'egy hely felszabadult');
    const extra = await newClient().post('/api/team/join', { code: host.code });
    assert.equal(extra.status, 409, 'de újra megtelt');
  });
});

describe('kilépés és közös állapot', () => {
  test('az utolsó tag kilépésekor a csapat megszűnik', async () => {
    const t = await newTeam();
    await t.client.post('/api/team/leave');
    assert.equal((await newClient().post('/api/team/join', { code: t.code })).status, 404);
  });

  test('kilépés után a tag nem végezhet műveletet (401)', async () => {
    const t = await newTeam();
    await t.client.post('/api/team/leave');
    const r = await t.client.post('/api/game/answer', { value: 'x' });
    assert.equal(r.status, 401);
    assert.ok(r.json.error);
  });

  test('csapattagok ugyanazt a haladást látják, és a válasz mindenkinek előrevisz', async () => {
    const host = await newTeam();
    const friend = newClient();
    await friend.post('/api/team/join', { code: host.code });
    await host.client.req('POST', '/api/game/upload', photoForm());
    const f = (await friend.get('/api/game')).json;
    assert.equal(f.stage.id, 'who-is-it');
    assert.equal(f.progress.done, 1);
  });
});

describe('válaszok', () => {
  test('rossz válasz nem léptet tovább', async () => {
    const t = await newTeam();
    await playTo(t.client, 'who-is-it');
    const r = await t.client.post('/api/game/answer', { value: 'Zeusz' });
    assert.equal(r.json.correct, false);
    assert.equal(r.json.state.stage.id, 'who-is-it');
  });

  test('üres és túl hosszú válasz kezelése', async () => {
    const t = await newTeam();
    await playTo(t.client, 'who-is-it');
    assert.equal((await t.client.post('/api/game/answer', { value: '' })).json.correct, false);
    const long = await t.client.post('/api/game/answer', { value: 'a'.repeat(5000) });
    assert.equal(long.status, 200);
    assert.equal(long.json.correct, false);
  });

  test('hiányzó value mező nem dob szervert', async () => {
    const t = await newTeam();
    await playTo(t.client, 'who-is-it');
    const r = await t.client.post('/api/game/answer', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.correct, false);
  });

  test('szöveges válasz ékezet nélkül is elfogadott', async () => {
    const t = await newTeam();
    await playTo(t.client, 'quiz-philosopher');
    const r = await t.client.post('/api/game/answer', { value: 'platon' });
    assert.equal(r.json.correct, true);
  });

  test('választós állomáson fotó-feltöltés helyett szöveges válasz: 400', async () => {
    const t = await newTeam();
    await playTo(t.client, 'who-is-it');
    const r = await t.client.post('/api/game/answer', { value: 'Poszeidón' });
    assert.equal(r.json.correct, true);
    const wrong = await t.client.req('POST', '/api/game/upload', photoForm());
    assert.equal(wrong.status, 400);
  });

  test('a szfinx 3 rejtvénye sorrendben, rossz válasz nem ugrik', async () => {
    const t = await newTeam();
    await playTo(t.client, 'sphinx');
    let s = (await t.client.get('/api/game')).json;
    assert.equal(s.stage.riddleNo, 1);
    assert.match(s.stage.riddle, /négy lábon/, 'az első a klasszikus szfinx-rejtvény');
    assert.equal((await t.client.post('/api/game/answer', { value: 'sötétség' })).json.correct, false);
    assert.equal((await t.client.post('/api/game/answer', { value: 'Az ember' })).json.correct, true);
    s = (await t.client.get('/api/game')).json;
    assert.equal(s.stage.riddleNo, 2);
    await t.client.post('/api/game/answer', { value: 'sötétség' });
    s = (await t.client.get('/api/game')).json;
    assert.equal(s.stage.riddleNo, 3);
    const last = await t.client.post('/api/game/answer', { value: 'térkép' });
    assert.equal(last.json.correct, true);
    assert.equal(last.json.state.stage.id, 'old-message');
  });

  test('a régi üzenet állomás a LETTERS_ANSWER-rel működik', async () => {
    const t = await newTeam();
    await playTo(t.client, 'old-message');
    const r = await t.client.post('/api/game/answer', { value: LETTERS });
    assert.equal(r.json.correct, true);
  });

  test('a kapu állomás a GATE_CODE-dal nyit, és a kód nem szivárog a state-ben', async () => {
    const t = await newTeam();
    const s = await playTo(t.client, 'atlantis-gate');
    const text = JSON.stringify(s);
    assert.equal(text.includes(GATE), false, 'a kapukód nem lehet a válaszban');
    const r = await t.client.post('/api/game/answer', { value: GATE });
    assert.equal(r.json.correct, true);
  });
});

describe('állapot végén és biztonság', () => {
  test('a teljes játék végigvihető: a végén „finished" és további válasz 400', async () => {
    const t = await newTeam();
    const s = await playTo(t.client, 'atlantis-gate');
    assert.equal(s.stage.id, 'atlantis-gate');
    await t.client.post('/api/game/answer', { value: GATE });
    const end = (await t.client.get('/api/game')).json;
    assert.equal(end.finished, true);
    assert.equal(end.depth, 200);
    assert.equal(end.progress.done, end.progress.total);
    const after = await t.client.post('/api/game/answer', { value: GATE });
    assert.equal(after.status, 400);
  });

  test('a state egyetlen válaszmezőt sem tartalmaz (answer / a / riddles kulcs nincs)', async () => {
    const t = await newTeam();
    const seen = new Set();
    for (const id of ['statue', 'who-is-it', 'quiz-philosopher', 'shark', 'sphinx', 'old-message', 'atlantis-gate']) {
      const s = await playTo(t.client, id);
      allKeys(s).forEach((k) => seen.add(k));
    }
    for (const forbidden of ['answer', 'a', 'riddles', 'successText']) {
      assert.equal(seen.has(forbidden), false, `kulcs szivárgott: ${forbidden}`);
    }
  });

  test('a szobor-referenciák és a kiemelt betűk nem hiányoznak a feladatból', async () => {
    const t = await newTeam();
    const s = (await t.client.get('/api/game')).json;
    assert.equal(s.stage.references.length, 3);
  });

  test('a szerver a valódi válaszokat nem küldi el: kulcs-egyezés nélkül nincs találat', async () => {
    const t = await newTeam();
    const s = (await t.client.get('/api/game')).json;
    assert.equal(JSON.stringify(s).includes('Hádész'), false, 'az istenszobor válasza nem ülhet a válaszban');
  });
});

describe('cápa-kör', () => {
  test('indítás és ütés csak a cápa-állomáson', async () => {
    const t = await newTeam();
    assert.equal((await t.client.post('/api/game/shark/start')).status, 400);
    assert.equal((await t.client.post('/api/game/shark/press', { elapsedMs: 1 })).status, 400);
  });

  test('ütés indítás nélkül: 400', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    const r = await t.client.post('/api/game/shark/press', { elapsedMs: 3000 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Előbb indítsd/);
  });

  test('érvénytelen idő: hiányzó, negatív vagy szöveges elapsedMs 400', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    for (const bad of [{}, { elapsedMs: -5 }, { elapsedMs: 'sok' }, { elapsedMs: null }]) {
      await t.client.post('/api/game/shark/start');
      const r = await t.client.post('/api/game/shark/press', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  test('a piros szakasz (pl. 1 mp) elvéti, és az ütés után újra kell indítani', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    await t.client.post('/api/game/shark/start');
    const miss = await t.client.post('/api/game/shark/press', { elapsedMs: 1000 });
    assert.equal(miss.json.correct, false, '1 mp = 80°, a sáv legkorábban 100°-nál kezdődik');
    const again = await t.client.post('/api/game/shark/press', { elapsedMs: 3000 });
    assert.equal(again.status, 400, 'az ütés után a kör lezárult');
  });

  test('határ-értékek a sorsolt sávhoz: a sáv két széle zöld, közvetlenül előtte és utána piros', async () => {
    const cases = [
      [(z) => angleMs(z, z.greenStart - 1), false],
      [(z) => angleMs(z, z.greenStart), true],
      [(z) => angleMs(z, z.greenStart + z.greenWidth), true],
      [(z) => angleMs(z, z.greenStart + z.greenWidth + 1), false],
    ];
    for (const [msOf, hit] of cases) {
      const t = await newTeam();
      await playTo(t.client, 'shark');
      const z = (await t.client.post('/api/game/shark/start')).json.shark;
      const ms = msOf(z);
      const r = await t.client.post('/api/game/shark/press', { elapsedMs: ms });
      assert.equal(r.json.correct, hit, `${ms} ms (sáv: ${z.greenStart}°–${z.greenStart + z.greenWidth}°)`);
    }
  });

  test('a kör 360°-os ismétlődése: 4.5 mp (0°) nem zöld', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    await t.client.post('/api/game/shark/start');
    const r = await t.client.post('/api/game/shark/press', { elapsedMs: 4500 });
    assert.equal(r.json.correct, false);
  });

  test('túl késői ütés (20 mp felett) elutasítva', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    await t.client.post('/api/game/shark/start');
    const r = await t.client.post('/api/game/shark/press', { elapsedMs: 25000 });
    assert.equal(r.json.correct, false);
    assert.match(r.json.message, /Túl későn/);
  });

  test('zöld ütés léptet, és a következő állomás a szfinx', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    const z = (await t.client.post('/api/game/shark/start')).json.shark;
    const r = await t.client.post('/api/game/shark/press', { elapsedMs: hitMs(z) });
    assert.equal(r.json.correct, true);
    assert.equal(r.json.state.stage.id, 'sphinx');
  });
});

describe('fotó-feltöltés', () => {
  test('feltöltés csapat nélkül: 401', async () => {
    const r = await newClient().req('POST', '/api/game/upload', photoForm());
    assert.equal(r.status, 401);
  });

  test('feltöltés nem fotó-állomáson: 400', async () => {
    const t = await newTeam();
    const r = await t.client.req('POST', '/api/game/upload', photoForm());
    assert.equal(r.status, 200, 'az első állomás a fotó, ez sikeres');
    const again = await t.client.req('POST', '/api/game/upload', photoForm());
    assert.equal(again.status, 400);
  });

  test('szöveges fájl (nem kép) elutasítva, nem menti el', async () => {
    const t = await newTeam();
    const before = fs.readdirSync(srv.uploadDir).length;
    const r = await t.client.req('POST', '/api/game/upload', photoForm(Buffer.from('hello'), 'text/plain', 'x.txt'));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /támogatott kép/);
    assert.equal(fs.readdirSync(srv.uploadDir).length, before, 'nem maradt fájl');
  });

  test('rossz mezőnév: nem „túl nagy" hibaüzenet', async () => {
    const t = await newTeam();
    const fd = new FormData();
    fd.append('wrong', new Blob([PNG_1PX], { type: 'image/png' }), 'a.png');
    const r = await t.client.req('POST', '/api/game/upload', fd);
    assert.equal(r.status, 400);
    assert.doesNotMatch(r.json.error, /túl nagy/);
  });

  test('túl nagy fájl (9 MB) elutasítva, és szó szerint „túl nagy" üzenettel', async () => {
    const t = await newTeam();
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    const r = await t.client.req('POST', '/api/game/upload', photoForm(big, 'image/png', 'big.png'));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /túl nagy/);
  });

  test('érvényes PNG: továbbléptet és naplóba kerül a csapatnév', async () => {
    const t = await newTeam('Naplózott');
    const r = await t.client.req('POST', '/api/game/upload', photoForm());
    assert.equal(r.json.correct, true);
    await new Promise((res) => setTimeout(res, 200));
    const log = fs.readFileSync(path.join(srv.uploadDir, 'uploads.log'), 'utf8');
    assert.match(log, /"team":"Naplózott"/);
    assert.match(log, new RegExp(`"code":"${t.code}"`));
  });
});

describe('QR-kapu oldal', () => {
  test('helyes titok: megmutatja a kódot, no-store fejléccel', async () => {
    const r = await newClient().get('/kapu/teszt-kapu');
    assert.equal(r.status, 200);
    assert.match(r.text, new RegExp(GATE));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('hibás titok: nem mutat kódot', async () => {
    const r = await newClient().get('/kapu/rossz');
    assert.match(r.text, /Zárt kapu/);
    assert.equal(r.text.includes(GATE), false);
  });

  test('a titok nem tükröződik vissza az oldalon (XSS-védelem)', async () => {
    const payload = encodeURIComponent('<script>alert(1)</script>');
    const r = await newClient().get(`/kapu/${payload}`);
    assert.equal(r.text.includes('<script>alert'), false);
  });
});

describe('hibakezelés és hálózati esetek', () => {
  test('hibás JSON törzs: JSON-válasz 400-zal, nem HTML', async () => {
    const t = await newTeam();
    const r = await t.client.req('POST', '/api/game/answer', '{hibás json');
    assert.equal(r.status, 400);
    assert.ok(r.json && r.json.error, 'JSON hibaüzenet kell');
  });

  test('túl nagy JSON törzs: 413 JSON-ben', async () => {
    const r = await newClient().req('POST', '/api/team/create', JSON.stringify({ name: 'x'.repeat(20000) }));
    assert.equal(r.status, 413);
    assert.ok(r.json && r.json.error);
  });

  test('ismeretlen API-útvonal: 404 JSON-ben', async () => {
    const r = await newClient().get('/api/nincs-ilyen');
    assert.equal(r.status, 404);
    assert.ok(r.json && r.json.error);
  });

  test('a public mappán kívüli fájl nem érhető el (path traversal)', async () => {
    const r = await newClient().get('/..%2fpackage.json');
    assert.notEqual(r.status, 200);
    const r2 = await newClient().get('/%2e%2e/package.json');
    assert.notEqual(r2.status, 200);
  });

  test('a feltöltött képek nem érhetők el közvetlenül a webről', async () => {
    const r = await newClient().get('/uploads/uploads.log');
    assert.notEqual(r.status, 200);
  });

  test('sw.js és index.html nem gyorsítótárazódik hosszan (no-cache)', async () => {
    assert.equal((await newClient().get('/sw.js')).headers.get('cache-control'), 'no-cache');
    assert.equal((await newClient().get('/index.html')).headers.get('cache-control'), 'no-cache');
    // a javítások azonnal jussanak el a telefonokra (nem 1 óra tárolás után)
    assert.equal((await newClient().get('/js/app.js')).headers.get('cache-control'), 'no-cache');
    assert.equal((await newClient().get('/css/style.css')).headers.get('cache-control'), 'no-cache');
  });

  test('a szöveges válaszok gzip-pel mennek (lassú hálózat)', async () => {
    const r = await fetch(srv.base + '/js/app.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
  });

  test('munkamenetek elkülönülnek: két játékos nem látja egymás csapatát', async () => {
    const a = await newTeam('Első');
    const stranger = newClient();
    assert.equal((await stranger.get('/api/game')).json.started, false);
    assert.equal((await a.client.get('/api/game')).json.team.name, 'Első');
  });
});

describe('párhuzamos és késve érkező válaszok (több telefon egy csapatban)', () => {
  test('két tag egyszerre válaszol: az egyik előrelép, a másik „stale" választ kap és nem léptet', async () => {
    const host = await newTeam();
    const friend = newClient();
    await friend.post('/api/team/join', { code: host.code });
    await playTo(host.client, 'who-is-it');
    const [a, b] = await Promise.all([
      host.client.post('/api/game/answer', { value: 'Poszeidón', expectKey: 'who-is-it' }),
      friend.post('/api/game/answer', { value: 'Poszeidón', expectKey: 'who-is-it' }),
    ]);
    const results = [a, b];
    assert.equal(results.filter((r) => r.json.correct).length, 1, 'pontosan egy lépés történhet');
    const stale = results.find((r) => r.json.stale);
    assert.ok(stale, 'a második válasz stale-ként jelöli a helyzetet');
    assert.equal(stale.json.state.stage.id, 'gods');
    const final = (await host.client.get('/api/game')).json;
    assert.equal(final.stage.id, 'gods');
    assert.equal(final.progress.done, 2);
  });

  test('régi feladatra küldött válasz nem léptet a következőre', async () => {
    const t = await newTeam();
    await playTo(t.client, 'who-is-it');
    await t.client.post('/api/game/answer', { value: 'Poszeidón', expectKey: 'who-is-it' });
    const late = await t.client.post('/api/game/answer', { value: 'Hádész', expectKey: 'who-is-it' });
    assert.equal(late.json.stale, true);
    assert.equal(late.json.correct, false);
    assert.equal(late.json.state.stage.id, 'gods');
    assert.equal((await t.client.get('/api/game')).json.progress.done, 2, 'nem ugrott tovább');
  });

  test('rejtvény: a régi rejtvény-sorszámra érkező válasz stale', async () => {
    const t = await newTeam();
    await playTo(t.client, 'sphinx');
    await t.client.post('/api/game/answer', { value: 'ember', expectKey: 'sphinx#0' });
    const late = await t.client.post('/api/game/answer', { value: 'ember', expectKey: 'sphinx#0' });
    assert.equal(late.json.stale, true);
    assert.equal(late.json.state.stage.riddleNo, 2);
  });

  test('cápa: késve érkező ütés (régi kulcs) nem számít', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    const z = (await t.client.post('/api/game/shark/start')).json.shark;
    await t.client.post('/api/game/shark/press', { elapsedMs: hitMs(z), expectKey: 'shark' });
    const late = await t.client.post('/api/game/shark/start', {});
    assert.equal(late.status, 400, 'már a szfinxnél jár, a cápa-indítás nem érvényes');
    const press = await t.client.post('/api/game/shark/press', { elapsedMs: 3000, expectKey: 'shark' });
    assert.equal(press.json.stale, true);
  });
});

describe('önkéntelen hibák a kliensen', () => {
  test('a null elapsedMs nem egyezik a 0 ms-es ütéssel', async () => {
    const t = await newTeam();
    await playTo(t.client, 'shark');
    await t.client.post('/api/game/shark/start');
    const r = await t.client.post('/api/game/shark/press', { elapsedMs: null });
    assert.equal(r.status, 400);
  });
});

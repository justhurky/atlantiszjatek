'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, photoForm, TEST_ADMIN_KEY, adminClient } = require('./helpers');

const KEY = TEST_ADMIN_KEY;
let srv;

before(async () => {
  srv = await startServer({ RATE_LIMIT_PER_MIN: '1000', ANSWER_RATE_PER_MIN: '100000' });
});
after(() => srv && srv.stop());

const admin = () => adminClient(srv.base);

async function team(name = 'Csapat') {
  const c = new Client(srv.base);
  const r = await c.post('/api/team/create', { name });
  return { c, code: r.json.team.code };
}

test('belépés nélkül az admin oldal, a fájljai, az áttekintés és a műveletek 404-et adnak', async () => {
  const { code } = await team();
  const c = new Client(srv.base);
  for (const url of ['/admin', '/admin.html', '/js/admin.js', '/css/admin.css', '/api/admin/overview', '/api/admin/access-qr.png']) {
    assert.equal((await c.get(url)).status, 404, url);
  }
  assert.match((await c.get('/admin')).text, /Szervezői felület/);
  assert.doesNotMatch((await c.get('/admin')).text, /admin-key|\/admin\/[A-Za-z0-9_-]{16}/);
  assert.equal((await c.post(`/api/admin/teams/${code}/advance`)).status, 404);
  assert.equal((await c.post(`/api/admin/teams/${code}/delete`)).status, 404);
  assert.equal((await c.post('/api/admin/key/rotate')).status, 404);
});

test('hibás kulcs: 404; a szervezői link beléptet és a kulcs nélküli címre irányít', async () => {
  const c = new Client(srv.base);
  assert.equal((await c.get('/admin/rossz-kulcs-0123456789abcdef')).status, 404);
  assert.equal((await c.get('/admin/x')).status, 404);
  assert.equal((await c.get('/api/admin/overview')).status, 404);
  const r = await c.get(`/admin/${KEY}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/admin');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await c.get('/admin')).status, 200);
  assert.equal((await c.get('/js/admin.js')).status, 200);
  assert.equal((await c.get('/admin.html')).status, 404, 'a közvetlen .html cím soha');
  const o = await c.get('/api/admin/overview');
  assert.equal(o.status, 200);
  assert.ok(o.json.access.link.endsWith(`/admin/${KEY}`));
  assert.equal(o.json.access.local, false);
});

test('a szervezői belépés új munkamenet-azonosítót ad (session fixation ellen), és 24 óráig él', async () => {
  const c = new Client(srv.base);
  await c.post('/api/team/create', { name: 'Előtte' });
  const before = c.cookie;
  const r = await c.get(`/admin/${KEY}`);
  assert.notEqual(c.cookie, before);
  const exp = new Date(/Expires=([^;]+)/i.exec(r.headers.get('set-cookie'))[1]).getTime();
  assert.ok(exp - Date.now() > 23 * 3600 * 1000, 'a szervezői süti kb. 24 óráig él');
});

test('kulcs-találgatás: 10 próbálkozás után 429, a helyes kulccsal is', async () => {
  const s = await startServer({});
  try {
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await new Client(s.base).get(`/admin/talalgatas-${i}-0123456789`)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
    assert.deepEqual(statuses.slice(10), [429, 429]);
    assert.equal((await new Client(s.base).get(`/admin/${KEY}`)).status, 429);
  } finally {
    s.stop();
  }
});

test('ADMIN_KEY nélkül a szerver kulcsot generál, elmenti, és újraindítás után is az él', async () => {
  const s = await startServer({ ADMIN_KEY: '' });
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(path.dirname(s.dataFile), 'admin-key.txt');
  let key;
  try {
    key = fs.readFileSync(file, 'utf8').trim();
    assert.match(key, /^[A-Za-z0-9_-]{32}$/);
    assert.match(s.log(), new RegExp(`/admin/${key}`), 'az indításkor kiírja a szervezői linket');
    assert.equal((await new Client(s.base).get(`/admin/${key}`)).status, 303);
  } finally {
    s.stop();
  }
});

test('új szervezői link: a régi kulccsal belépett telefon kiesik, a cserélő bent marad', async () => {
  const s = await startServer({ ADMIN_KEY: '' });
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const key = fs.readFileSync(path.join(path.dirname(s.dataFile), 'admin-key.txt'), 'utf8').trim();
    const a = await adminClient(s.base, key);
    const b = await adminClient(s.base, key);
    const r = await a.post('/api/admin/key/rotate', {});
    assert.equal(r.status, 200);
    const fresh = r.json.link.split('/admin/')[1];
    assert.notEqual(fresh, key);
    assert.equal((await a.get('/api/admin/overview')).status, 200, 'aki cserélt, bent marad');
    assert.equal((await b.get('/api/admin/overview')).status, 404, 'a másik telefon kiesett');
    assert.equal((await new Client(s.base).get(`/admin/${key}`)).status, 404, 'a régi link már nem nyit');
    assert.equal((await new Client(s.base).get(`/admin/${fresh}`)).status, 303);
    assert.match((await a.get('/api/admin/overview')).json.events.map((e) => e.text).join('|'), /Új szervezői link/);
  } finally {
    s.stop();
  }
});

test('ADMIN_KEY környezeti változóval a link nem cserélhető a felületről (409)', async () => {
  const c = await admin();
  assert.equal((await c.post('/api/admin/key/rotate', {})).status, 409);
  assert.equal((await c.get('/api/admin/overview')).json.access.fromEnv, true);
});

test('túl rövid ADMIN_KEY esetén a szerver nem indul el', async () => {
  await assert.rejects(startServer({ ADMIN_KEY: 'rovid' }), /ADMIN_KEY/);
});

test('a szerver gépéről (localhost) belépés nélkül megnyílik, de proxy-fejléccel vagy idegen Host-tal nem', async () => {
  const s = await startServer({ ADMIN_LOCAL: '1' });
  try {
    const port = new URL(s.base).port;
    const local = new Client(`http://localhost:${port}`);
    assert.equal((await local.get('/admin')).status, 200);
    const o = await local.get('/api/admin/overview');
    assert.equal(o.status, 200);
    assert.equal(o.json.access.local, true);
    assert.equal((await new Client(s.base).get('/admin')).status, 200, '127.0.0.1 is helyi');
    // alagút / helyi proxy: a kérés a loopbackről jön, de továbbított
    assert.equal((await local.req('GET', '/api/admin/overview', undefined, { 'x-forwarded-for': '203.0.113.7' })).status, 404);
    assert.equal((await local.req('GET', '/api/admin/overview', undefined, { forwarded: 'for=203.0.113.7' })).status, 404);
    // DNS-rebinding: idegen név mutat a 127.0.0.1-re
    // (a fetch nem engedi a Host felülírását, ezért nyers http-kérés)
    const rawStatus = (host) =>
      new Promise((resolve, reject) => {
        require('node:http')
          .get({ host: '127.0.0.1', port, path: '/api/admin/overview', headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode);
          })
          .on('error', reject);
      });
    assert.equal(await rawStatus(`gonosz.example:${port}`), 404);
    assert.equal(await rawStatus(`localhost:${port}`), 200);
  } finally {
    s.stop();
  }
});

test('ADMIN_LOCAL=0 esetén a szerver gépén is kell a szervezői link', async () => {
  const port = new URL(srv.base).port;
  assert.equal((await new Client(`http://localhost:${port}`).get('/admin')).status, 404);
});

test('kijelentkezés után nincs hozzáférés', async () => {
  const c = await admin();
  const r = await c.post('/api/admin/logout');
  assert.equal(r.json.stillLocal, false);
  assert.equal((await c.get('/api/admin/overview')).status, 404);
});

test('módosító admin-kérés csak JSON-ként fogadható el (CSRF ellen)', async () => {
  const { code } = await team();
  const c = await admin();
  const r = await c.req('POST', `/api/admin/teams/${code}/delete`, undefined, { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
  const still = (await c.get('/api/admin/overview')).json.teams.some((t) => t.code === code);
  assert.ok(still, 'a csapat megmaradt');
});

test('áttekintés: csapatok, létszám, állomás és összesítő; megoldásokat nem tartalmaz', async () => {
  const { c: player, code } = await team('Látható');
  const mate = new Client(srv.base);
  await mate.post('/api/team/join', { code });
  await player.req('POST', '/api/game/upload', photoForm());
  const a = await admin();
  const o = (await a.get('/api/admin/overview')).json;
  const t = o.teams.find((x) => x.code === code);
  assert.equal(t.name, 'Látható');
  assert.equal(t.members, 2);
  assert.equal(t.stageId, 'who-is-it');
  assert.equal(t.photos.length, 1);
  assert.ok(o.totals.teams >= 1 && o.totals.players >= 2);
  const text = JSON.stringify(o);
  for (const secret of ['Hádész', 'sötétség', 'ATLANTISZ', 'answer']) {
    assert.equal(text.includes(secret), false, `szivárgás: ${secret}`);
  }
});

test('átléptetés: a csapat a következő állomásra kerül, és a játékos is ezt látja', async () => {
  const { c: player, code } = await team('Elakadt');
  const a = await admin();
  const r = await a.post(`/api/admin/teams/${code}/advance`);
  assert.equal(r.status, 200);
  assert.equal(r.json.team.stageId, 'who-is-it');
  assert.equal((await player.get('/api/game')).json.stage.id, 'who-is-it');
});

test('átléptetés a végéig: célba ér, rögzített célidővel, és utána nem léptethető', async () => {
  const { code } = await team('Végig');
  const a = await admin();
  for (let i = 0; i < 9; i++) await a.post(`/api/admin/teams/${code}/advance`);
  const t = (await a.get('/api/admin/overview')).json.teams.find((x) => x.code === code);
  assert.equal(t.finished, true);
  assert.ok(t.finishedAt >= t.createdAt);
  assert.equal((await a.post(`/api/admin/teams/${code}/advance`)).status, 400);
});

test('visszaállítás: az első állomásra kerül, a tagok maradnak', async () => {
  const { c: player, code } = await team('Újra');
  const a = await admin();
  await a.post(`/api/admin/teams/${code}/advance`);
  await a.post(`/api/admin/teams/${code}/advance`);
  const r = await a.post(`/api/admin/teams/${code}/reset`);
  assert.equal(r.json.team.stageIndex, 0);
  assert.equal(r.json.team.members, 1);
  assert.equal((await player.get('/api/game')).json.stage.id, 'statue');
});

test('törlés: a csapat eltűnik, a játékos a kezdő képernyőt kapja', async () => {
  const { c: player, code } = await team('Törölt');
  const a = await admin();
  assert.equal((await a.post(`/api/admin/teams/${code}/delete`)).status, 200);
  assert.equal((await player.get('/api/game')).json.started, false);
  assert.equal((await a.post(`/api/admin/teams/${code}/delete`)).status, 404);
});

test('fotó: csak adminnak érhető el, és a fájlnév-trükkök (path traversal) elutasítva', async () => {
  const { c: player, code } = await team('Fotós');
  await player.req('POST', '/api/game/upload', photoForm());
  const a = await admin();
  const file = (await a.get('/api/admin/overview')).json.teams.find((t) => t.code === code).photos[0].file;
  assert.match(file, /\.png$/);
  assert.equal((await new Client(srv.base).get(`/api/admin/photos/${file}`)).status, 404, 'játékos nem látja');
  const ok = await a.get(`/api/admin/photos/${file}`);
  assert.equal(ok.status, 200);
  for (const evil of ['..%2F..%2Fpackage.json', 'uploads.log', '..%2Fsrc%2Fconfig.js', '1-abc.png']) {
    const r = await a.get(`/api/admin/photos/${evil}`);
    assert.notEqual(r.status, 200, evil);
  }
});

test('az admin oldal (HTML) betölt, a CSP-fejléccel', async () => {
  const r = await (await admin()).get('/admin');
  assert.equal(r.status, 200);
  assert.match(r.text, /Irányítóterem/);
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('belépő QR-kód és nyomtatható plakát: csak szervezőnek, a játék címére mutat', async () => {
  const s = await startServer({ BASE_URL: 'https://atlantisz.pelda.hu' });
  try {
    const guest = new Client(s.base);
    for (const url of ['/api/admin/join-qr.svg', '/admin/plakat', '/admin/plakat?mi=kapu']) {
      assert.equal((await guest.get(url)).status, 404, url);
    }
    // a plakát címe nem számít hibás kulcs-próbálkozásnak
    for (let i = 0; i < 12; i++) await guest.get('/admin/plakat');
    const c = await adminClient(s.base);
    const svg = await c.get('/api/admin/join-qr.svg?download=1');
    assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(svg.headers.get('content-disposition'), /atlantisz-qr-jatek\.svg/);
    assert.match(svg.text, /^<svg/);
    assert.match(svg.text, /<image href="data:image\/png;base64,/, 'középen az ESK–IVK embléma');
    assert.doesNotMatch((await c.get('/api/admin/join-qr.svg?logo=0')).text, /<image/);
    const poster = await c.get('/admin/plakat');
    assert.equal(poster.status, 200);
    assert.match(poster.text, /<svg/);
    assert.match(poster.text, /https:\/\/atlantisz\.pelda\.hu</);
    assert.match(poster.text, /assets\/logo\/esk\.png/);
    assert.match(poster.text, /assets\/logo\/ivk\.png/);
    assert.doesNotMatch(poster.text, /localhost/);
    const gate = await c.get('/admin/plakat?mi=kapu&tema=sotet');
    assert.match(gate.text, /Atlantisz kapuja/);
    assert.match(gate.text, /class="sheet dark"/);
    assert.doesNotMatch(gate.text, /kapu\/qr-kapu/, 'a kapu titkos címe szövegként nem kerül a plakátra');
    const o = (await c.get('/api/admin/overview')).json;
    assert.equal(o.joinUrl, 'https://atlantisz.pelda.hu/');
    assert.equal(o.baseIsLocal, false);
  } finally {
    s.stop();
  }
});

test('localhost BASE_URL esetén a plakát figyelmeztet nyomtatás előtt', async () => {
  const c = await admin();
  assert.match((await c.get('/admin/plakat')).text, /telefonról nem fog működni/);
  assert.equal((await c.get('/api/admin/overview')).json.baseIsLocal, true);
});

test('tesztfázis vége: a „TÖRLÉS" szóval minden csapat és fotó törlődik, a játékosok a kezdőképernyőre kerülnek', async () => {
  const s = await startServer({});
  try {
    const p = new Client(s.base);
    await p.post('/api/team/create', { name: 'Próbacsapat' });
    assert.equal((await p.req('POST', '/api/game/upload', photoForm())).status, 200);
    const c = await adminClient(s.base);
    assert.equal((await c.post('/api/admin/reset-all', { confirm: 'igen' })).status, 400);
    assert.equal((await new Client(s.base).post('/api/admin/reset-all', { confirm: 'TÖRLÉS' })).status, 404, 'játékos nem törölhet');
    const r = await c.post('/api/admin/reset-all', { confirm: 'törlés' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.teams, r.json.photos], [1, 1]);
    const o = (await c.get('/api/admin/overview')).json;
    assert.equal(o.totals.teams, 0);
    assert.equal(o.totals.photos, 0);
    assert.equal((await p.get('/api/game')).json.started, false);
    const fs = require('node:fs');
    assert.deepEqual(fs.readdirSync(s.uploadDir).filter((f) => /\.(png|jpg|webp)$/.test(f)), []);
  } finally {
    s.stop();
  }
});

test('jelszavas belépés a /admin címen: rossz jelszó 401, jó jelszó beléptet, 10 hiba után 429', async () => {
  const s = await startServer({ ADMIN_PASSWORD: 'Tengeri-Csillag-77' });
  const form = (pw) => new URLSearchParams({ jelszo: pw }).toString();
  const login = (c, pw) => c.req('POST', '/admin/belepes', form(pw), { 'content-type': 'application/x-www-form-urlencoded' });
  try {
    const c = new Client(s.base);
    const page = await c.get('/admin');
    assert.equal(page.status, 404);
    assert.match(page.text, /name="jelszo"/);
    const bad = await login(c, 'rossz-jelszo');
    assert.equal(bad.status, 401);
    assert.match(bad.text, /Hibás jelszó/);
    assert.equal((await c.get('/api/admin/overview')).status, 404);
    const ok = await login(c, 'Tengeri-Csillag-77');
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/admin');
    assert.equal((await c.get('/admin')).status, 200);
    assert.equal((await c.get('/api/admin/overview')).status, 200);
    const d = new Client(s.base);
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await login(d, `tipp-${i}`)).status);
    assert.equal(st[10], 429);
    assert.equal((await login(d, 'Tengeri-Csillag-77')).status, 429, 'zárolás alatt a jó jelszó sem megy');
  } finally {
    s.stop();
  }
});

test('ADMIN_PASSWORD nélkül nincs jelszavas belépés', async () => {
  const c = new Client(srv.base);
  assert.doesNotMatch((await c.get('/admin')).text, /name="jelszo"/);
  const r = await c.req('POST', '/admin/belepes', 'jelszo=barmi', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 404);
});

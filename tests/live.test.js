'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, photoForm, adminClient } = require('./helpers');

const hitMs = (z) => ((z.greenStart + z.greenWidth / 2) / z.speed) * 1000;

async function withServer(env, fn) {
  const srv = await startServer({
    RATE_LIMIT_PER_MIN: '1000',
    ANSWER_RATE_PER_MIN: '100000',
    LETTERS_ANSWER: 'TITKOS',
    ...env,
  });
  try {
    await fn(srv);
  } finally {
    srv.stop();
  }
}

async function admin(srv) {
  return adminClient(srv.base);
}

// Egy csapat végigvitele a célig a valódi API-n át
async function finish(c) {
  await c.req('POST', '/api/game/upload', photoForm());
  for (const v of ['Poszeidón', 'Hádész', 'Zeusz', 'Platón']) await c.post('/api/game/answer', { value: v });
  const z = (await c.post('/api/game/shark/start')).json.shark;
  await c.post('/api/game/shark/press', { elapsedMs: hitMs(z) });
  for (const v of ['ember', 'sötétség', 'térkép', 'TITKOS', 'ATLANTISZ']) await c.post('/api/game/answer', { value: v });
  const s = (await c.get('/api/game')).json;
  assert.equal(s.finished, true);
  return s;
}

// ---------- élő ranglista a célba ért csapatnak ----------

test('élő ranglista a telefonon: csak csapattagnak, és csak a cél elérése után', async () => {
  await withServer({}, async (srv) => {
    assert.equal((await new Client(srv.base).get('/api/game/leaderboard')).status, 401);
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Türelmetlen' });
    const early = await c.get('/api/game/leaderboard');
    assert.equal(early.status, 403);
    assert.match(early.json.error, /cél elérése után/);
    await finish(c);
    assert.equal((await c.get('/api/game/leaderboard')).status, 200);
  });
});

test('élő ranglista: a saját csapat ki van emelve, másé nem, és csapatkód nincs benne', async () => {
  await withServer({}, async (srv) => {
    const a = new Client(srv.base);
    const b = new Client(srv.base);
    const mate = new Client(srv.base);
    const ta = await a.post('/api/team/create', { name: 'Elsők' });
    const tb = await b.post('/api/team/create', { name: 'Másodikok' });
    await mate.post('/api/team/join', { code: ta.json.team.code });
    await finish(a);
    const board = await mate.get('/api/game/leaderboard');
    const mine = board.json.teams.filter((t) => t.isMe);
    assert.equal(mine.length, 1, 'pontosan egy saját sor');
    assert.equal(mine[0].name, 'Elsők', 'a csapattárs is a saját csapatát látja kiemelve');
    assert.equal(board.json.teams.find((t) => t.name === 'Másodikok').isMe, false);
    for (const code of [ta.json.team.code, tb.json.team.code]) assert.equal(board.text.includes(code), false);
  });
});

test('élő ranglista: a helyezés élőben változik, ahogy más csapatok célba érnek', async () => {
  await withServer({ HINT_AFTER_MS: '0', HINT_PENALTY_MS: '3600000' }, async (srv) => {
    const slow = new Client(srv.base);
    const fast = new Client(srv.base);
    await slow.post('/api/team/create', { name: 'Büntetett' });
    await fast.post('/api/team/create', { name: 'Tiszta' });
    await slow.post('/api/game/hint', {}); // +1 óra büntetés
    await finish(slow);
    let board = (await slow.get('/api/game/leaderboard')).json;
    assert.equal(board.teams[0].name, 'Büntetett');
    await finish(fast);
    board = (await slow.get('/api/game/leaderboard')).json;
    assert.equal(board.teams[0].name, 'Tiszta', 'a büntetés nélküli csapat előrébb került');
    assert.equal(board.teams.find((t) => t.isMe).rank, 2);
  });
});

test('élő ranglista a telefonon akkor is működik, ha a kivetítő ki van kapcsolva', async () => {
  await withServer({ PUBLIC_BOARD: '0' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Zárt' });
    await finish(c);
    assert.equal((await new Client(srv.base).get('/api/leaderboard')).status, 404);
    assert.equal((await c.get('/api/game/leaderboard')).status, 200);
  });
});

test('a nyilvános kivetítő nem jelöl saját csapatot', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Valaki' });
    const board = await c.get('/api/leaderboard');
    assert.equal(board.json.teams.some((t) => 'isMe' in t), false);
  });
});

// ---------- egyetlen admin felület ----------

test('admin: egy áttekintésben minden – csapatok, ranglista, fotók száma, napló, ellenőrzőlista, QR-cím', async () => {
  await withServer({ GATE_QR_SECRET: 'kapu titok/1', BASE_URL: 'http://192.168.1.20:3000' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Mindenes' });
    await c.req('POST', '/api/game/upload', photoForm());
    const o = (await (await admin(srv)).get('/api/admin/overview')).json;
    for (const key of ['teams', 'leaderboard', 'events', 'status', 'gateUrl', 'totals', 'stages']) {
      assert.ok(key in o, `hiányzik: ${key}`);
    }
    assert.equal(o.totals.photos, 1);
    assert.equal(o.leaderboard[0].name, 'Mindenes');
    assert.equal(o.gateUrl, 'http://192.168.1.20:3000/kapu/kapu%20titok%2F1');
  });
});

test('admin napló: létrehozás, csatlakozás, megoldás, segítség, fotó, célba érés, admin-műveletek', async () => {
  await withServer({ HINT_AFTER_MS: '0' }, async (srv) => {
    const c = new Client(srv.base);
    const t = await c.post('/api/team/create', { name: 'Naplózott' });
    await new Client(srv.base).post('/api/team/join', { code: t.json.team.code });
    await c.post('/api/game/hint', {});
    await finish(c);
    const other = new Client(srv.base);
    const o = await other.post('/api/team/create', { name: 'Másik' });
    const a = await admin(srv);
    await a.post(`/api/admin/teams/${o.json.team.code}/advance`);
    await a.post(`/api/admin/teams/${o.json.team.code}/reset`);
    const events = (await a.get('/api/admin/overview')).json.events;
    const texts = events.filter((e) => e.team === 'Naplózott').map((e) => e.text).join(' | ');
    for (const expected of ['Csapat létrehozva', 'Új tag csatlakozott', 'Segítséget kért', 'Fotót töltött fel', 'Megoldva: Ki látható a képen?', 'Célba ért']) {
      assert.ok(texts.includes(expected), `hiányzik a naplóból: ${expected}\n${texts}`);
    }
    const otherTexts = events.filter((e) => e.team === 'Másik').map((e) => e.text).join(' | ');
    assert.match(otherTexts, /Átléptetve \(admin\)/);
    assert.match(otherTexts, /Visszaállítva/);
    assert.ok(events[0].at >= events[events.length - 1].at, 'a legfrissebb elöl');
    assert.equal(JSON.stringify(events).includes(t.json.team.code), true, 'az admin látja a kódot');
  });
});

test('admin napló: a QR-kapu szkennelése is megjelenik', async () => {
  await withServer({ GATE_QR_SECRET: 'qr' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Korai' });
    await c.get('/kapu/qr');
    const events = (await (await admin(srv)).get('/api/admin/overview')).json.events;
    assert.ok(events.some((e) => /Túl korán szkennelte/.test(e.text)));
  });
});

test('admin ellenőrzőlista: jelzi a hiányzó beállításokat', async () => {
  await withServer(
    { LETTERS_ANSWER: '', SESSION_SECRET: '', GATE_QR_SECRET: '', GATE_CODE: '', PRIVACY_CONTROLLER: '', PRIVACY_CONTACT: '', BASE_URL: 'http://localhost:3000' },
    async (srv) => {
      const checks = (await (await admin(srv)).get('/api/admin/overview')).json.status.checks;
      const failing = checks.filter((c) => !c.ok).map((c) => c.label);
      for (const label of ['A QR-kód a telefonokról elérhető címre mutat', 'Adatkezelési tájékoztató kitöltve']) {
        assert.ok(failing.includes(label), `nem jelezte: ${label}`);
      }
      // a régi üzenet megoldása és a képek már a játékban vannak
      assert.equal(failing.includes('Minden állomás be van állítva'), false);
      assert.equal(failing.includes('A feladatok képei megvannak'), false);
    }
  );
});

test('admin ellenőrzőlista: minden beállítva → nincs hiányzó pont', async () => {
  await withServer(
    {
      SESSION_SECRET: 'a'.repeat(40),
      GATE_QR_SECRET: 'b'.repeat(20),
      GATE_CODE: 'SAJAT',
      PRIVACY_CONTROLLER: 'Szervező',
      PRIVACY_CONTACT: 'adat@pelda.hu',
      BASE_URL: 'http://192.168.1.20:3000',
      SAVE_INTERVAL_MS: '100',
    },
    async (srv) => {
      const c = new Client(srv.base);
      await c.post('/api/team/create', { name: 'Mentésre' });
      await new Promise((r) => setTimeout(r, 400));
      const checks = (await (await admin(srv)).get('/api/admin/overview')).json.status.checks;
      const failing = checks.filter((x) => !x.ok).map((x) => x.label);
      assert.deepEqual(failing, []);
      assert.match(checks.find((x) => x.label === 'A játék állása mentődik').detail, /Utolsó mentés/);
    }
  );
});

test('admin QR-kód: csak adminnak, valódi PNG, letöltéskor fájlnévvel', async () => {
  await withServer({}, async (srv) => {
    assert.equal((await new Client(srv.base).get('/api/admin/qr.png')).status, 404);
    const a = await admin(srv);
    const res = await fetch(srv.base + '/api/admin/qr.png', { headers: { cookie: a.cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    const dl = await fetch(srv.base + '/api/admin/qr.png?download=1', { headers: { cookie: a.cookie } });
    assert.match(dl.headers.get('content-disposition') || '', /attachment; filename="atlantisz-qr-kapu.png"/);
  });
});

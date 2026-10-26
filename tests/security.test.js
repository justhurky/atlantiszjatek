'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, Client, photoForm, PNG_1PX } = require('./helpers');

async function withServer(env, fn) {
  const srv = await startServer(env);
  try {
    await fn(srv);
  } finally {
    srv.stop();
  }
}

test('biztonsági fejlécek: CSP, clickjacking- és MIME-védelem minden válaszon', async () => {
  await withServer({}, async (srv) => {
    for (const url of ['/', '/api/game', '/kapu/x']) {
      const r = await new Client(srv.base).get(url);
      const csp = r.headers.get('content-security-policy') || '';
      assert.match(csp, /default-src 'self'/, url);
      assert.match(csp, /script-src 'self'/, url);
      assert.match(csp, /frame-ancestors 'none'/, url);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', url);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', url);
      assert.equal(r.headers.get('x-powered-by'), null, url);
    }
  });
});

test('titkok nélkül a szerver sajátot generál; újraindítás után ugyanaz marad (nincs nyilvános alapérték)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantisz-titok-'));
  const env = { SESSION_SECRET: '', GATE_QR_SECRET: '', GATE_CODE: '', DATA_FILE: path.join(dir, 'state.json') };
  try {
    const read = () => fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    const first = await startServer(env);
    const saved1 = read();
    await first.stop();
    const second = await startServer(env);
    assert.equal(read(), saved1, 'újraindítás után ugyanazok a titkok');
    assert.notEqual(JSON.parse(saved1).GATE_QR_SECRET, 'qr-kapu-2026');
    assert.equal((await new Client(second.base).get('/kapu/qr-kapu-2026')).text.includes('Zárt kapu'), true, 'a régi nyilvános QR-titok nem nyit');
    await second.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saját titkokkal nincs figyelmeztetés', async () => {
  await withServer({ SESSION_SECRET: 'a'.repeat(40), GATE_QR_SECRET: 'b'.repeat(20), GATE_CODE: 'SAJAT' }, async (srv) => {
    assert.doesNotMatch(srv.log(), /alapértelmezett/);
  });
});

test('éles mód helyi hálózaton (HTTP): a süti működik, a játék játszható', async () => {
  await withServer(
    {
      NODE_ENV: 'production',
      BASE_URL: 'http://192.168.1.20:3000',
      SESSION_SECRET: 'nagyon-hosszu-es-egyedi-titok-1234567890',
      GATE_QR_SECRET: 'kapu-titok-xyz-987',
    },
    async (srv) => {
      const c = new Client(srv.base);
      const created = await c.post('/api/team/create', { name: 'LAN' });
      const cookie = created.headers.get('set-cookie') || '';
      assert.match(cookie, /HttpOnly/);
      assert.doesNotMatch(cookie, /Secure/, 'HTTP-n nem lehet Secure, különben a böngésző eldobja');
      const state = await c.get('/api/game');
      assert.equal(state.json.started, true, 'a munkamenet megmaradt');
    }
  );
});

test('hamis X-Forwarded-For fejléccel nem lehet kijátszani a korlátot (TRUST_PROXY nélkül)', async () => {
  await withServer({ RATE_LIMIT_PER_MIN: '2' }, async (srv) => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const r = await new Client(srv.base).req(
        'POST',
        '/api/team/join',
        { code: 'ZZZZZ' },
        { 'x-forwarded-for': `10.0.0.${i}` }
      );
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [404, 404, 429, 429]);
  });
});

test('válasz-korlát: a megoldások gépi végigpróbálása 429-et kap', async () => {
  await withServer({ ANSWER_RATE_PER_MIN: '3' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Brute' });
    await c.req('POST', '/api/game/upload', photoForm());
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await c.post('/api/game/answer', { value: `tipp${i}` })).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });
});

test('a válasz-korlát csapatonként számol: egy másik csapatot nem érint', async () => {
  await withServer({ ANSWER_RATE_PER_MIN: '2' }, async (srv) => {
    const a = new Client(srv.base);
    const b = new Client(srv.base);
    await a.post('/api/team/create', { name: 'Alfa' });
    await b.post('/api/team/create', { name: 'Béta' });
    for (const c of [a, b]) await c.req('POST', '/api/game/upload', photoForm());
    for (let i = 0; i < 3; i++) await a.post('/api/game/answer', { value: 'x' });
    const other = await b.post('/api/game/answer', { value: 'x' });
    assert.equal(other.status, 200);
  });
});

test('csapat-korlát: MAX_TEAMS felett nem jön létre új csapat (memória-védelem)', async () => {
  await withServer({ MAX_TEAMS: '2' }, async (srv) => {
    const s = [];
    for (let i = 0; i < 3; i++) s.push((await new Client(srv.base).post('/api/team/create', { name: `Csapat ${i}` })).status);
    assert.deepEqual(s, [200, 200, 503]);
  });
});

test('hamisított kép (PNG-nek mondott szöveg) elutasítva, és nem marad a lemezen', async () => {
  await withServer({}, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Hamis' });
    const r = await c.req('POST', '/api/game/upload', photoForm(Buffer.from('ez nem kép, csak szöveg'), 'image/png', 'x.png'));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /nem érvényes kép/);
    const left = fs.readdirSync(srv.uploadDir).filter((f) => f !== 'uploads.log');
    assert.deepEqual(left, []);
    const state = await c.get('/api/game');
    assert.equal(state.json.stage.id, 'statue', 'nem léptetett tovább');
  });
});

test('valódi PNG, JPEG és WEBP fejléc elfogadva', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);
  for (const [buf, type] of [
    [PNG_1PX, 'image/png'],
    [jpeg, 'image/jpeg'],
    [webp, 'image/webp'],
  ]) {
    await withServer({}, async (srv) => {
      const c = new Client(srv.base);
      await c.post('/api/team/create', { name: 'Kép' });
      const r = await c.req('POST', '/api/game/upload', photoForm(buf, type, 'kep'));
      assert.equal(r.json && r.json.correct, true, type);
    });
  }
});

test('a feltöltési méretkorlát környezeti változóból jön, és az üzenet a valós korlátot írja', async () => {
  await withServer({ UPLOAD_MAX_MB: '1' }, async (srv) => {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Nagy' });
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024)]);
    const r = await c.req('POST', '/api/game/upload', photoForm(big, 'image/png', 'nagy.png'));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /max\. 1 MB/);
  });
});

test('a tesztek az ideiglenes mappába írnak, nem a projekt uploads/ mappájába', async () => {
  const projectUploads = path.join(__dirname, '..', 'uploads');
  const before = fs.existsSync(projectUploads) ? fs.readdirSync(projectUploads).length : 0;
  await withServer({}, async (srv) => {
    assert.notEqual(path.resolve(srv.uploadDir), path.resolve(projectUploads));
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Elszigetelt' });
    await c.req('POST', '/api/game/upload', photoForm());
    assert.ok(fs.readdirSync(srv.uploadDir).some((f) => f.endsWith('.png')));
  });
  const after = fs.existsSync(projectUploads) ? fs.readdirSync(projectUploads).length : 0;
  assert.equal(after, before, 'a projekt uploads/ mappája érintetlen');
});

test('a válaszok közül a kapukód és a régi üzenet megoldása nem kérhető le a webről', async () => {
  await withServer({ GATE_CODE: 'TITKOSKAPU', LETTERS_ANSWER: 'REJTETT' }, async (srv) => {
    const c = new Client(srv.base);
    for (const url of ['/', '/js/app.js', '/api/game', '/sw.js', '/src/stages.js', '/src/config.js', '/package.json']) {
      const r = await c.get(url);
      assert.equal(r.text.includes('TITKOSKAPU'), false, url);
      assert.equal(r.text.includes('REJTETT'), false, url);
    }
  });
});

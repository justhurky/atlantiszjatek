'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { startServer, Client } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

test('éles indítás titkok nélkül: a szerver generál sajátot, elmenti, és elindul', async () => {
  const srv = await startServer({ NODE_ENV: 'production', SESSION_SECRET: '', GATE_QR_SECRET: '', GATE_CODE: '' });
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(srv.dataFile), 'secrets.json'), 'utf8'));
    assert.match(saved.SESSION_SECRET, /^[0-9a-f]{64}$/);
    assert.ok(saved.GATE_QR_SECRET.length >= 16);
    assert.match(saved.GATE_CODE, /^[A-Z]+\d{2}$/);
    assert.match(srv.log(), /generálta/);
    assert.match(srv.log(), new RegExp(`kapukód.*${saved.GATE_CODE}`));
    assert.equal((await new Client(srv.base).get('/healthz')).status, 200);
  } finally {
    srv.stop();
  }
});

test('korlátozás: a csapatkód-próbálkozások IP-nként percenként korlátozva', async () => {
  const srv = await startServer({ RATE_LIMIT_PER_MIN: '3' });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await new Client(srv.base).post('/api/team/join', { code: 'ZZZZZ' });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
  } finally {
    srv.stop();
  }
});

test('korlátozás: a sikeres csatlakozások nem fogyasztják a keretet (egy Wi-Fi mögött sok telefon)', async () => {
  const srv = await startServer({ RATE_LIMIT_PER_MIN: '3' });
  try {
    const statuses = [];
    for (let t = 0; t < 4; t++) {
      const code = (await new Client(srv.base).post('/api/team/create', { name: `Wifi ${t}` })).json.team.code;
      for (let i = 0; i < 4; i++) statuses.push((await new Client(srv.base).post('/api/team/join', { code })).status);
    }
    assert.deepEqual([...new Set(statuses)], [200]);
  } finally {
    srv.stop();
  }
});

test('a régi üzenet alapból az ORÁKULUM, a LETTERS_ANSWER felülírja; nincs figyelmeztetés', async () => {
  const srv = await startServer({ LETTERS_ANSWER: '' });
  try {
    assert.doesNotMatch(srv.log(), /FIGYELEM.*old-message/);
  } finally {
    srv.stop();
  }
});

test('a szerver nem omlik össze hibás multipart kérésre', async () => {
  const srv = await startServer({});
  try {
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Teszt' });
    const r = await c.req('POST', '/api/game/upload', 'nem multipart', { 'content-type': 'multipart/form-data; boundary=x' });
    assert.ok(r.status >= 400 && r.status < 500, `várt 4xx, kapott ${r.status}`);
    assert.ok(r.json && r.json.error);
    const still = await c.get('/api/game');
    assert.equal(still.status, 200, 'a szerver még él');
  } finally {
    srv.stop();
  }
});

test('a tag, akinek lejárt a helye (idle), kiesik; a felszabaduló helyre új tag fér', async () => {
  const srv = await startServer({ MEMBER_IDLE_MS: '300', CLEANUP_INTERVAL_MS: '60000' });
  try {
    const host = new Client(srv.base);
    const created = await host.post('/api/team/create', { name: 'Lejáró' });
    const code = created.json.team.code;
    await new Promise((r) => setTimeout(r, 500));
    const gone = await host.get('/api/game');
    assert.equal(gone.json.started, false, 'a tulajdonos inaktivitás után kiesett');
    const joinAgain = await new Client(srv.base).post('/api/team/join', { code });
    assert.equal(joinAgain.status, 200, 'a csapat még létezik, a tagok helye felszabadult');
    assert.equal(joinAgain.json.team.members, 1);
  } finally {
    srv.stop();
  }
});

test('üres és lejárt csapat takarítás után megszűnik (TEAM_TTL)', async () => {
  const srv = await startServer({ TEAM_TTL_MS: '200', CLEANUP_INTERVAL_MS: '100', MEMBER_IDLE_MS: '60000' });
  try {
    const host = new Client(srv.base);
    const { json } = await host.post('/api/team/create', { name: 'Régi' });
    const code = json.team.code;
    await new Promise((r) => setTimeout(r, 600));
    const r = await new Client(srv.base).post('/api/team/join', { code });
    assert.equal(r.status, 404, 'a lejárt csapat törlődött');
  } finally {
    srv.stop();
  }
});

test('éles mód HTTPS-proxy mögött (TRUST_PROXY=1): a süti Secure és HttpOnly', async () => {
  const srv = await startServer({
    NODE_ENV: 'production',
    TRUST_PROXY: '1',
    BASE_URL: 'https://atlantisz.example',
    SESSION_SECRET: 'nagyon-hosszu-es-egyedi-titok-1234567890',
    GATE_QR_SECRET: 'kapu-titok-xyz-987',
    GATE_CODE: 'SAJATKOD',
  });
  try {
    // HTTPS-proxyn át érkezik a kérés (X-Forwarded-Proto), így a secure süti kiadódik
    const r = await new Client(srv.base).req('POST', '/api/team/create', { name: 'Éles' }, { 'x-forwarded-proto': 'https' });
    assert.match(r.headers.get('set-cookie') || '', /Secure/);
    assert.match(r.headers.get('set-cookie') || '', /HttpOnly/);
  } finally {
    srv.stop();
  }
});

test('feltöltés: a fájl kiterjesztése a MIME-típusból jön, nem a kliens nevéből', async () => {
  const srv = await startServer({});
  try {
    const { PNG_1PX, photoForm } = require('./helpers');
    const fs = require('node:fs');
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Kiterjesztés' });
    const r = await c.req('POST', '/api/game/upload', photoForm(PNG_1PX, 'image/png', 'evil.exe'));
    assert.equal(r.json.correct, true);
    await new Promise((res) => setTimeout(res, 200));
    const log = fs.readFileSync(path.join(srv.uploadDir, 'uploads.log'), 'utf8').trim().split('\n').pop();
    const file = JSON.parse(log).file;
    assert.match(file, /\.png$/);
    assert.doesNotMatch(file, /\.exe$/);
  } finally {
    srv.stop();
  }
});

test('elavult feladatra érkező fotó stale-ként visszautasítva, a fájl nem marad a lemezen', async () => {
  const srv = await startServer({});
  try {
    const { PNG_1PX, photoForm } = require('./helpers');
    const fs = require('node:fs');
    const dir = srv.uploadDir;
    const c = new Client(srv.base);
    await c.post('/api/team/create', { name: 'Elavult' });
    const before = fs.readdirSync(dir).length;
    const fd = photoForm(PNG_1PX, 'image/png', 'x.png');
    fd.append('expectKey', 'valami-regi-kulcs');
    const r = await c.req('POST', '/api/game/upload', fd);
    assert.equal(r.json.stale, true);
    assert.equal(fs.readdirSync(dir).length, before, 'nem maradt fájl');
  } finally {
    srv.stop();
  }
});

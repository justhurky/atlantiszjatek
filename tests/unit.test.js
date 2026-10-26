'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, sameAnswer } = require('../src/utils');

test('normalize: ékezet, nagybetű és írásjel nem számít', () => {
  assert.equal(normalize('Poszeidón'), normalize('POSZEIDON'));
  assert.equal(normalize('  Platón! '), 'platon');
  assert.equal(normalize('sötétség'), 'sotetseg');
  assert.equal(normalize('Hádész'), normalize('hadesz'));
});

test('sameAnswer: üres válasz soha nem egyezik', () => {
  assert.equal(sameAnswer('', 'platon'), false);
  assert.equal(sameAnswer('   ', 'platon'), false);
  assert.equal(sameAnswer('!!!', 'platon'), false);
});

test('sameAnswer: több elfogadott alak és null-kezelés', () => {
  assert.equal(sameAnswer('jovo', ['jövő', 'jovo']), true);
  assert.equal(sameAnswer('valami', ['jövő', 'jovo']), false);
  assert.equal(sameAnswer('x', null), false);
});

test('sameAnswer: a „Poszeidon" és a „Poszeidón" elfogadott', () => {
  assert.equal(sameAnswer('Poszeidon', 'Poszeidón'), true);
});

test('díszített QR-kód: logóval H hibajavítás, középen kitakart terület, hosszú címnél logó nélkül', () => {
  const { qrArtSvg, hasLogo } = require('../src/qrart');
  assert.equal(hasLogo(), true);
  const svg = qrArtSvg('https://atlantisz.pelda.hu/');
  assert.match(svg, /^<svg[^>]+viewBox="0 0 (\d+) \1"/);
  assert.match(svg, /<image href="data:image\/png;base64,/);
  assert.doesNotMatch(qrArtSvg('https://atlantisz.pelda.hu/', { logo: false }), /<image/);
  // 7-es verziótól (középen igazító minta) nem takarunk ki a kód közepéből
  assert.doesNotMatch(qrArtSvg(`https://atlantisz.pelda.hu/${'x'.repeat(90)}`), /<image/);
});

test('a régi üzenet: 8 kiemelt betű, összekeverve, az ORÁKULUM betűi; jelölő nem marad a szövegben', () => {
  const { STAGES } = require('../src/stages');
  const st = STAGES.find((x) => x.id === 'old-message');
  const chars = [...st.text];
  const letters = st.marked.map((i) => chars[i]).join('');
  assert.equal(st.marked.length, 8);
  assert.notEqual(normalize(letters), normalize('ORÁKULUM'), 'nem sorrendben vannak');
  const sorted = (w) => [...normalize(w)].sort().join('');
  assert.equal(sorted(letters), sorted('ORÁKULUM'));
  assert.equal(/[{}]/.test(st.text), false);
  assert.ok(sameAnswer('orakulum', st.answer));
  assert.ok(sameAnswer('Orákulum', st.answer));
});

test('„Ki látható a képen?": Poszeidón és Széchenyi István is helyes', () => {
  const { STAGES } = require('../src/stages');
  const st = STAGES.find((x) => x.id === 'who-is-it');
  assert.ok(sameAnswer('Poszeidón', st.answer));
  assert.ok(sameAnswer('Széchenyi István', st.answer));
  assert.equal(sameAnswer('Zeusz', st.answer), false);
});

test('.env betöltése: megjegyzés, idézőjel, a meglévő környezeti változót nem írja felül', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadDotEnv } = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-')), '.env');
  fs.writeFileSync(file, '\uFEFF# megjegyzés\r\nTESZT_A=alma\r\nTESZT_B = "körte fa"\nTESZT_C=marad\nhibás sor\n');
  process.env.TESZT_C = 'eredeti';
  const before = process.env.DOTENV;
  delete process.env.DOTENV;
  loadDotEnv(file);
  if (before !== undefined) process.env.DOTENV = before;
  assert.equal(process.env.TESZT_A, 'alma');
  assert.equal(process.env.TESZT_B, 'körte fa');
  assert.equal(process.env.TESZT_C, 'eredeti');
});

test('GAME_END_AT: a rendezvény időzónájában értendő, nyári és téli időben is', () => {
  const { parseTime } = require('../src/config');
  assert.equal(new Date(parseTime('2026-10-27 22:00', 'Europe/Budapest')).toISOString(), '2026-10-27T21:00:00.000Z'); // téli idő
  assert.equal(new Date(parseTime('2026-07-01 22:00', 'Europe/Budapest')).toISOString(), '2026-07-01T20:00:00.000Z'); // nyári idő
  assert.equal(new Date(parseTime('2026-10-27T22:00:00+01:00')).toISOString(), '2026-10-27T21:00:00.000Z');
  assert.throws(() => parseTime('holnap'), /GAME_END_AT/);
});

// ---------- csapatnév-szűrő ----------
{
  const { test } = require('node:test');
  const assert = require('node:assert');
  const { checkTeamName, isOffensive } = require('../src/namefilter');
  test('trágár csapatnevek trükkökkel együtt fennakadnak', () => {
    for (const n of ['fasz', 'f@sz', 'F.A.S.Z', 'f a s z', 'f*sz', 'faaasz', 'FÁSZOK', 'kurwa', 'k*rva', 'p1csa', 'köcsög', 'szar', 'kapd be', 'f u c k', 'Sh1t', 'náci', '𝐟𝐚𝐬𝐳', 'fаsz']) {
      assert.ok(isOffensive(n), n);
      assert.equal(checkTeamName(n).ok, false, n);
    }
  });
  test('normális csapatnevek átmennek', () => {
    for (const n of ['Atlantisz Kalózai', 'Szarvasok', 'Császárok', 'Basszus Banda', 'Alfa Szél', 'Pocsolya Lovagok', 'Foszfor', 'Gondolkodók', 'Szárnyas Halak', 'Grapefruit', 'IVK Mérnökök']) {
      assert.ok(checkTeamName(n).ok, n);
    }
    assert.equal(checkTeamName('').name, 'Kalandor csapat');
    assert.equal(checkTeamName('!!!').ok, false);
  });
}

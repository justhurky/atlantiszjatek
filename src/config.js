'use strict';

const fs = require('fs');
const path = require('path');

// Beállítások a projekt mappájában lévő .env fájlból (KULCS=érték soronként, # megjegyzés).
// A már megadott környezeti változókat nem írja felül. Kikapcsolás (pl. tesztekhez): DOTENV=0
function loadDotEnv(file) {
  if (process.env.DOTENV === '0') return;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // nincs .env: minden marad alapértéken
  }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

// Az időpontok a rendezvény időzónájában értendők (felhőben a szerver órája gyakran UTC-n jár)
const TIME_ZONE = process.env.TIME_ZONE || 'Europe/Budapest';

// Egy adott időzónabeli falióra-időpont → UTC ezredmásodperc (nyári/téli idő szerint)
function zonedTime(y, mo, d, h, mi, tz) {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += target - shown;
  }
  return guess;
}

// A játék vége: "2026-10-27 22:00" (a rendezvény helyi ideje, TIME_ZONE) vagy teljes ISO időpont időzónával
function parseTime(v, tz = TIME_ZONE) {
  if (!v) return null;
  const text = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text);
  const t = m ? zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], tz) : Date.parse(text);
  if (!Number.isFinite(t)) throw new Error(`Hibás időpont a GAME_END_AT beállításban: ${v} (példa: 2026-10-27 22:00)`);
  return t;
}

const crypto = require('crypto');
const os = require('os');

const PRODUCTION = process.env.NODE_ENV === 'production';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'state.json');

// ---------- titkok: ha nincsenek megadva, a szerver generálja és a mentés mellé írja ----------
// Így sosem a (forráskódban nyilvános) alapérték védi a kaput, és újraindítás után is ugyanazok maradnak.
// Figyelem: felhőben, nem tartós lemezen minden új indításkor új titok készülne – ott add meg őket.
const SECRETS_FILE = path.join(path.dirname(DATA_FILE), 'secrets.json');
function loadSecrets() {
  const wanted = {
    SESSION_SECRET: () => crypto.randomBytes(32).toString('hex'),
    GATE_QR_SECRET: () => crypto.randomBytes(12).toString('base64url'),
  };
  const missing = Object.keys(wanted).filter((k) => !process.env[k]);
  if (!missing.length) return { values: {}, generated: [] };
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    /* még nincs mentett titok */
  }
  const values = {};
  let changed = false;
  for (const k of missing) {
    if (typeof saved[k] === 'string' && saved[k]) {
      values[k] = saved[k];
    } else {
      values[k] = wanted[k]();
      saved[k] = values[k];
      changed = true;
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
    fs.writeFileSync(SECRETS_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  }
  return { values, generated: missing };
}
const secrets = loadSecrets();

// ---------- a játék címe a telefonokról: ha nincs megadva, a gép helyi hálózati címe ----------
const VIRTUAL_NIC = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vbox|virbr|br-|Loopback|Bluetooth|utun|tailscale|zerotier/i;
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      out.push({ name, address: a.address, score: (VIRTUAL_NIC.test(name) ? 0 : 2) + (priv ? 1 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : fallback);

// Minden beállítás környezeti változóval felülírható (lásd README.md).
const PORT = num(process.env.PORT, 3000);
const lan = process.env.BASE_URL || process.env.AUTO_BASE_URL === '0' ? [] : lanAddresses();

module.exports = {
  PRODUCTION,
  PORT,
  // Melyik hálózati címen figyeljen a szerver. Proxy (nginx) mögött: 127.0.0.1, így a port kívülről nem érhető el.
  HOST: process.env.HOST || '',
  // A játék címe, amire a QR-kódok és a szervezői link mutat. Üresen: a gép helyi hálózati címe.
  BASE_URL: process.env.BASE_URL || (lan.length ? `http://${lan[0].address}:${PORT}` : `http://localhost:${PORT}`),
  BASE_URL_AUTO: !process.env.BASE_URL,
  LAN_ADDRESSES: lan.map((a) => `${a.address} (${a.name})`),
  SESSION_SECRET: process.env.SESSION_SECRET || secrets.values.SESSION_SECRET,
  // A kapunál megjelenő kód, amit a csapatok beírnak a játékba
  // Tartalék, mindig érvényes kapukód – csak ha kifejezetten megadják (alapból nincs, mert egy közös kódot
  // a csapatok továbbadhatnának egymásnak). Helyette a kapu minden beolvasáskor egyszer használható kódot ad.
  GATE_CODE: process.env.GATE_CODE || '',
  // Az egyszer használható kapukód érvényessége (perc)
  GATE_CODE_TTL_MIN: num(process.env.GATE_CODE_TTL_MIN, 15),
  // A QR-kódba írt titok (ezt nyomtatja ki a szervező a helyszínre)
  GATE_QR_SECRET: process.env.GATE_QR_SECRET || secrets.values.GATE_QR_SECRET,
  // ezeket a szerver generálta (és a data/secrets.json fájlba mentette)
  GENERATED_SECRETS: secrets.generated,
  SECRETS_FILE,
  // A régi üzenet megoldó szava (a szervező innen is megadhatja, kód-módosítás nélkül)
  LETTERS_ANSWER: process.env.LETTERS_ANSWER || null,
  // Csapat-kezelés időzítései (ms)
  MEMBER_IDLE_MS: num(process.env.MEMBER_IDLE_MS, 3 * 60 * 60 * 1000),
  TEAM_TTL_MS: num(process.env.TEAM_TTL_MS, 12 * 60 * 60 * 1000),
  CLEANUP_INTERVAL_MS: num(process.env.CLEANUP_INTERVAL_MS, 10 * 60 * 1000),
  // Csapatkód-próbálkozások száma IP-nként percenként (a bulinál egy Wi-Fi mögött sok telefon van)
  RATE_LIMIT_PER_MIN: num(process.env.RATE_LIMIT_PER_MIN, 60),
  // Csapat-létrehozások száma IP-nként percenként (a helyszíni Wi-Fin mindenki egy IP mögött van)
  CREATE_RATE_PER_MIN: num(process.env.CREATE_RATE_PER_MIN, 120),
  // Válaszküldések száma csapatonként percenként (a megoldások végigpróbálása ellen)
  ANSWER_RATE_PER_MIN: num(process.env.ANSWER_RATE_PER_MIN, 30),
  // Egyszerre létező csapatok maximális száma (memória-védelem)
  MAX_TEAMS: num(process.env.MAX_TEAMS, 500),
  // Feltöltött fotó maximális mérete (MB). A kliens tömörít, egy fotó jellemzően 1 MB alatt van.
  UPLOAD_MAX_MB: num(process.env.UPLOAD_MAX_MB, 5),
  // A feltöltött fotók helye (a tesztek ideiglenes mappát használnak)
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
  // Csak akkor kapcsold be (1), ha a szerver HTTPS-proxy mögött fut. Különben a kliens
  // hamis X-Forwarded-For fejléccel kijátszhatná az IP-alapú korlátot.
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  // Szervezői belépés jelszó nélkül: egy titkos kulcs a szervezői linkben (/admin/<kulcs>).
  // Ha nincs megadva, a szerver első indításkor generál egyet, és a mentés mellé írja (data/admin-key.txt).
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  // A szerver gépéről (localhost) az admin felület külön belépés nélkül megnyílik. Kikapcsolás: ADMIN_LOCAL=0
  ADMIN_LOCAL: process.env.ADMIN_LOCAL !== '0',
  // Ennyi ideig marad belépve egy szervezői telefon (óra)
  ADMIN_SESSION_HOURS: num(process.env.ADMIN_SESSION_HOURS, 24),
  // A régi, jelszavas belépés már nem használt; csak azért olvassuk, hogy figyelmeztessünk rá
  LEGACY_ADMIN_PASSWORD: Boolean(process.env.ADMIN_PASSWORD),

  // Mentés: a csapatok és a munkamenetek ide íródnak, így újraindítás után folytatható a játék
  DATA_FILE,
  SAVE_INTERVAL_MS: num(process.env.SAVE_INTERVAL_MS, 3000),

  // Segítség (tipp): ennyi idő vagy ennyi rossz válasz után kérhető, ennyi büntetéssel
  HINT_AFTER_MS: num(process.env.HINT_AFTER_MS, 2 * 60 * 1000),
  HINT_AFTER_WRONG: num(process.env.HINT_AFTER_WRONG, 2),
  HINT_PENALTY_MS: num(process.env.HINT_PENALTY_MS, 2 * 60 * 1000),

  // A játék vége: utána nem lehet csapatot indítani és válaszolni, a ranglista végleges.
  // Példa: GAME_END_AT=2026-10-27 22:00. Üresen: nincs időkorlát.
  GAME_END_AT: parseTime(process.env.GAME_END_AT),
  TIME_ZONE,
  // A játék végén és a ranglistán megjelenő megjegyzés, pl. „Eredményhirdetés 23:00 után!"
  RESULTS_NOTE: process.env.RESULTS_NOTE || '',

  // Kivetíthető ranglista (/ranglista). Kikapcsolás: PUBLIC_BOARD=0
  PUBLIC_BOARD: process.env.PUBLIC_BOARD !== '0',

  // Adatvédelem: ennyi nap után a feltöltött fotók automatikusan törlődnek (tört szám is lehet)
  PHOTO_RETENTION_DAYS: num(process.env.PHOTO_RETENTION_DAYS, 30),
  // Az adatkezelési tájékoztató adatai (a /adatvedelem oldalon jelennek meg)
  PRIVACY_CONTROLLER: process.env.PRIVACY_CONTROLLER || '',
  PRIVACY_CONTACT: process.env.PRIVACY_CONTACT || '',
  PRIVACY_EVENT: process.env.PRIVACY_EVENT || '',
  PRIVACY_DPO: process.env.PRIVACY_DPO || '',
  // Ki készítette és üzemelteti az alkalmazást (a tájékoztatóban és a játék alján jelenik meg)
  PRIVACY_DEVELOPER: process.env.PRIVACY_DEVELOPER || '',
  PRIVACY_HOSTING: process.env.PRIVACY_HOSTING || '',
  PRIVACY_UPDATED: process.env.PRIVACY_UPDATED || '',
};

// a tesztekhez
Object.defineProperty(module.exports, 'loadDotEnv', { value: loadDotEnv, enumerable: false });
Object.defineProperty(module.exports, 'parseTime', { value: parseTime, enumerable: false });

'use strict';

// Mentés fájlba: a csapatok ÉS a munkamenetek együtt kerülnek a lemezre.
// Csak a csapatok mentése nem lenne elég: újraindítás után a telefonok sütije egy nem létező
// munkamenetre mutatna, és a játékosok nem tudnák folytatni a játékot.

const fs = require('fs');
const path = require('path');
const session = require('express-session');

const DEFAULT_SESSION_MS = 6 * 60 * 60 * 1000;

function expiryOf(sess) {
  const exp = sess && sess.cookie && sess.cookie.expires;
  const t = exp ? new Date(exp).getTime() : NaN;
  return Number.isFinite(t) ? t : Date.now() + DEFAULT_SESSION_MS;
}

// Memóriában tartott munkamenet-tár, amely lejáratkor magától takarít, és menthető.
// (Az express-session beépített MemoryStore-ja nem takarít és nem menthető.)
class PersistentSessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = new Map(); // sid -> { data: string, expires: number }
  }

  get(sid, cb) {
    const entry = this.sessions.get(sid);
    if (!entry) return cb(null, null);
    if (entry.expires <= Date.now()) {
      this.sessions.delete(sid);
      return cb(null, null);
    }
    try {
      return cb(null, JSON.parse(entry.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    this.sessions.set(sid, { data: JSON.stringify(sess), expires: expiryOf(sess) });
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    const entry = this.sessions.get(sid);
    if (entry) entry.expires = expiryOf(sess);
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this.sessions.delete(sid);
    if (cb) cb(null);
  }

  prune(now = Date.now()) {
    for (const [sid, entry] of this.sessions) {
      if (entry.expires <= now) this.sessions.delete(sid);
    }
  }

  dump() {
    return [...this.sessions.entries()];
  }

  restore(entries) {
    this.sessions = new Map(Array.isArray(entries) ? entries : []);
  }

  // A leállás idejével kitolja a munkamenetek lejáratát (a visszatöltés után; a lejártakat takarítja)
  extend(ms) {
    for (const entry of this.sessions.values()) entry.expires += ms;
    this.prune();
  }
}

function serializeTeam(team) {
  return { ...team, members: [...team.members.entries()] };
}

function deserializeTeam(raw) {
  return {
    ...raw,
    members: new Map(Array.isArray(raw.members) ? raw.members : []),
    photos: Array.isArray(raw.photos) ? raw.photos : [],
    photoMeta: raw.photoMeta && typeof raw.photoMeta === 'object' ? raw.photoMeta : {},
    hints: raw.hints && typeof raw.hints === 'object' ? raw.hints : {},
    wrong: raw.wrong && typeof raw.wrong === 'object' ? raw.wrong : {},
    penaltyMs: Number(raw.penaltyMs) || 0,
  };
}

// Atomikus írás: előbb ideiglenes fájlba, majd átnevezés. Így egy áramszünet vagy összeomlás
// közben sem marad félig írt (sérült) mentés.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windowson egy víruskereső pillanatnyilag zárolhatja a célfájlt: ilyenkor közvetlenül írunk
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

// graceMs: ha a szerver ennél rövidebb ideig állt, a leállás ideje nem számít bele az inaktivitásba
// (különben egy újraindítás után mindenki kiesne a csapatából, akinek a „legutóbb látva" ideje régi lett)
function createPersistence({ file, intervalMs, teams, store, graceMs = 0, log = console }) {
  let lastSaved = null;
  let timer = null;
  let lastSavedAt = null; // az utolsó sikeres mentés (vagy visszatöltés) ideje
  let lastError = null;

  // A tartalom (az időbélyeg nélkül): ezzel döntjük el, változott-e valami
  function snapshot() {
    return JSON.stringify({
      version: 1,
      teams: [...teams.values()].map(serializeTeam),
      sessions: store.dump(),
    });
  }

  // A fájlba a mentés ideje is bekerül, hogy újraindításkor tudjuk, mennyi ideig állt a szerver
  const withTime = (text) => `{"savedAt":${Date.now()},${text.slice(1)}`;

  function load() {
    if (!fs.existsSync(file)) return { teams: 0, sessions: 0 };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || data.version !== 1 || !Array.isArray(data.teams)) throw new Error('ismeretlen formátum');
    } catch (err) {
      // A sérült mentést nem töröljük: félretesszük, hogy kézzel meg lehessen nézni
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch {
        /* ha az átnevezés sem megy, üres állapottal indulunk */
      }
      log.warn(`FIGYELEM: a mentés nem olvasható (${err.message}). Félretéve: ${aside}. Üres állapottal indulok.`);
      return { teams: 0, sessions: 0, corrupt: true };
    }
    teams.clear();
    for (const raw of data.teams) {
      if (raw && typeof raw.code === 'string') teams.set(raw.code, deserializeTeam(raw));
    }
    store.restore(data.sessions);

    // Rövid leállás (pl. újraindítás, áramszünet) idejét jóváírjuk: a tagok helye és a csapatok maradnak
    const now = Date.now();
    const downtime = Number.isFinite(data.savedAt) ? Math.max(0, now - data.savedAt) : 0;
    const shifted = downtime > 0 && downtime <= graceMs;
    if (shifted) {
      for (const team of teams.values()) {
        for (const [sid, seen] of team.members) team.members.set(sid, Math.min(now, seen + downtime));
        team.lastActive = Math.min(now, (team.lastActive || now) + downtime);
      }
      store.extend(downtime);
    }

    lastSaved = snapshot();
    lastSavedAt = now;
    return { teams: teams.size, sessions: store.sessions.size, downtime, shifted };
  }

  // Csak akkor írunk, ha változott valami: a lemezt nem koptatjuk feleslegesen
  function save() {
    try {
      const text = snapshot();
      if (text === lastSaved) return false;
      writeAtomic(file, withTime(text));
      lastSaved = text;
      lastSavedAt = Date.now();
      lastError = null;
      return true;
    } catch (err) {
      lastError = err.message;
      log.error(`Nem sikerült menteni (${file}): ${err.message}`);
      return false;
    }
  }

  function start() {
    timer = setInterval(save, intervalMs);
    timer.unref();
    // Leállításkor (Ctrl+C, vagy a tárhely leállító jele) még egyszer mentünk
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        save();
        process.exit(0);
      });
    }
  }

  // Az admin felület számára: mikor mentett utoljára, és volt-e hiba
  function status() {
    return { file, lastSavedAt, lastError };
  }

  return { load, save, start, status, stop: () => clearInterval(timer) };
}

module.exports = { PersistentSessionStore, createPersistence };

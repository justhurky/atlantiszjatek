'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const compression = require('compression');
const QRCode = require('qrcode');

const config = require('./config');
const { STAGES, SHARK } = require('./stages');
const { checkTeamName, setExtraBlocked } = require('./namefilter');
setExtraBlocked(process.env.BLOCKED_NAMES || '');
const { sameAnswer } = require('./utils');
const { PersistentSessionStore, createPersistence } = require('./persistence');
const { privacyPage, gatePage, notFoundPage, posterPage, POSTERS } = require('./pages');
const { qrArtSvg } = require('./qrart');

const app = express();
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = config.UPLOAD_DIR;
const UPLOAD_LOG = path.join(UPLOAD_DIR, 'uploads.log');

const ATLANTIS_DEPTH = 200;
const SHARK_MAX_AGE_MS = 20000;
const MAX_TEAM_SIZE = 5;
const CODE_LENGTH = 5;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // nincs I, L, O, 0, 1
const PHOTO_NAME = /^[0-9]+-[0-9a-f]{12}\.(jpg|png|webp)$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MESSAGE = 'Ez a feladat közben már megoldódott a csapatotokban. Frissítjük a haladásotokat.';
const GATE_INDEX = STAGES.findIndex((s) => s.type === 'gate');
const STARTED_AT = Date.now();
const GATE_URL = `${config.BASE_URL.replace(/\/+$/, '')}/kapu/${encodeURIComponent(config.GATE_QR_SECRET)}`;
// A kinyomtatott belépő QR-kód célja: a játék kezdőlapja
const JOIN_URL = `${config.BASE_URL.replace(/\/+$/, '')}/`;
const BASE_IS_LOCAL = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(config.BASE_URL);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Csak kifejezett kérésre bízunk a proxy-fejlécekben (különben az IP-korlát kijátszható)
if (config.TRUST_PROXY) app.set('trust proxy', 1);

// ---------- indulás előtti figyelmeztetések (a szervező ezt a konzolon látja) ----------

const unconfigured = STAGES.filter((s) => s.type === 'letters' && s.answer == null).map((s) => s.id);
if (unconfigured.length) {
  console.warn(`FIGYELEM: ezek az állomások még nincsenek beállítva: ${unconfigured.join(', ')} (LETTERS_ANSWER)`);
}
if (config.GENERATED_SECRETS.length) {
  console.log(
    `A titkokat a szerver generálta és elmentette (${config.SECRETS_FILE}): ${config.GENERATED_SECRETS.join(', ')}. ` +
      'Újraindítás után is ugyanazok maradnak.'
  );
}
console.log(
  config.GATE_CODE
    ? `Tartalék kapukód (GATE_CODE, mindig érvényes – ne add ki!): ${config.GATE_CODE}`
    : `A kapu minden beolvasáskor egyszer használható, ${config.GATE_CODE_TTL_MIN} percig érvényes kódot ad.`
);
if (config.BASE_URL_AUTO) {
  console.log(
    `A játék címe a telefonokról (automatikusan felismerve): ${config.BASE_URL}` +
      (config.LAN_ADDRESSES.length > 1 ? `\n  A gép többi címe: ${config.LAN_ADDRESSES.slice(1).join(', ')}` : '') +
      '\n  Ha nem ez a Wi-Fi-hálózat címe, add meg a BASE_URL-t a .env fájlban.'
  );
}
if (config.LEGACY_ADMIN_PASSWORD) {
  console.warn('Megjegyzés: az ADMIN_PASSWORD már nem használt. A szervezői belépés a szervezői linkkel megy (lásd lent).');
}
if (!config.PRIVACY_CONTROLLER || !config.PRIVACY_CONTACT) {
  console.warn('FIGYELEM: az adatkezelési tájékoztatóból hiányzik az adatkezelő (PRIVACY_CONTROLLER / PRIVACY_CONTACT).');
}
if (config.PRODUCTION && !/^https:\/\//.test(config.BASE_URL)) {
  console.warn('Megjegyzés: HTTP-n a forgalom titkosítatlan. Helyi hálózaton elfogadható, interneten HTTPS kell.');
}

// ---------- csapatok és munkamenetek (memóriában, rendszeresen fájlba mentve) ----------

const teams = new Map(); // code -> team
const sessionStore = new PersistentSessionStore();
const persistence = createPersistence({
  file: config.DATA_FILE,
  intervalMs: config.SAVE_INTERVAL_MS,
  teams,
  store: sessionStore,
  graceMs: config.TEAM_TTL_MS,
});
const restored = persistence.load();
sessionStore.prune();
if (restored.teams || restored.sessions) {
  const pause = restored.shifted ? ` A ${Math.round(restored.downtime / 60000)} perces leállást jóváírtam, senki nem esett ki.` : '';
  console.log(`Mentés visszatöltve: ${restored.teams} csapat, ${restored.sessions} munkamenet.${pause}`);
}
persistence.start();

// ---------- alap middleware ----------

app.disable('x-powered-by');

// Böngészős biztonsági fejlécek: XSS, clickjacking és MIME-szaglás ellen.
// Minden erőforrás saját tárhelyről jön (betűtípus is), így külső szolgáltató nem kap adatot.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(), geolocation=()');
  next();
});

app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(
  session({
    name: 'atlantis.sid',
    secret: config.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // HTTPS-en Secure jelzéssel, helyi hálózaton (HTTP) anélkül: így az éles mód bulin is működik
      secure: 'auto',
      maxAge: 6 * 60 * 60 * 1000,
    },
  })
);
// Az admin felület fájljai csak szervezőnek: a sima játékos semmit nem lát belőle
const ADMIN_ASSETS = new Set(['/admin.html', '/js/admin.js', '/css/admin.css']);
app.use((req, res, next) => {
  if (!ADMIN_ASSETS.has(req.path)) return next();
  if (req.path === '/admin.html' || !isAdmin(req)) {
    return res.status(404).set('Cache-Control', 'no-store').type('html').send(notFoundPage());
  }
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(
  express.static(PUBLIC_DIR, {
    maxAge: '1h',
    setHeaders(res, filePath) {
      // A kód és a stílus mindig újraellenőrzött (ETag, változatlannál pici 304-es válasz): így egy
      // javítás a következő frissítéskor azonnal megjelenik a telefonokon, nem csak egy óra múlva.
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (filePath.endsWith('.woff2')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// Állapot-ellenőrzés a tárhelynek (felhős futtatásnál): nem árul el semmit a játékról
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

// Egyszerű, percenkénti korlát. Minden korlát saját táblát kap, a takarítás közös.
const limiters = [];
// countIf: ha meg van adva, csak azok a kérések számítanak, amelyek válaszkódjára igaz (pl. csak a hibás próbák)
function makeLimiter(keyOf, max, { countIf = null } = {}) {
  const hits = new Map(); // kulcs -> { count, reset }
  limiters.push(hits);
  return (req, res, next) => {
    const now = Date.now();
    const key = keyOf(req);
    let entry = hits.get(key);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + 60 * 1000 };
      hits.set(key, entry);
    }
    if (entry.count >= max) {
      return res.status(429).json({ error: 'Túl sok próbálkozás. Várj egy percet, aztán próbáld újra!' });
    }
    if (countIf) res.on('finish', () => countIf(res.statusCode) && (entry.count += 1));
    else entry.count += 1;
    next();
  };
}

// Csapatkód-találgatás ellen: IP-nként, de csak a HIBÁS kódok számítanak. A helyszíni Wi-Fin mindenki
// ugyanarról az IP-ről jön, ezért a sikeres csatlakozások nem fogyaszthatják el a keretet.
const joinLimit = makeLimiter((req) => req.ip, config.RATE_LIMIT_PER_MIN, { countIf: (status) => status === 404 });
// Csapat-létrehozás: IP-nként (memória-védelem; a csapatok száma ezen felül is korlátozott)
const createLimit = makeLimiter((req) => req.ip, config.CREATE_RATE_PER_MIN);
// Megoldások végigpróbálása ellen: csapatonként (csapat nélkül IP-nként)
const answerLimit = makeLimiter((req) => req.session.teamCode || `ip:${req.ip}`, config.ANSWER_RATE_PER_MIN);

// ---------- eseménynapló (az admin felületen látható; csak memóriában, a legutóbbi 300) ----------

const events = [];
function logEvent(team, text) {
  events.push({ at: Date.now(), team: team ? team.name : null, code: team ? team.code : null, text });
  if (events.length > 300) events.shift();
}

// ---------- csapat-segédek ----------

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
  } while (teams.has(code));
  return code;
}

function newTeam(code, name, sessionId, now) {
  return {
    code,
    name,
    members: new Map([[sessionId, now]]),
    stageIndex: 0,
    riddleIndex: 0,
    sharkStartedAt: null,
    sharkZone: null,
    finished: false,
    lastActive: now,
    createdAt: now,
    stageStartedAt: now, // az állomás kezdete (admin: „mióta vannak itt")
    keyStartedAt: now, // az aktuális feladat (rejtvénynél a rejtvény) kezdete: a tipp időzítéséhez
    finishedAt: null,
    photos: [],
    photoMeta: {}, // fájlnév -> { publish: bool, at: ms }
    hints: {}, // feladat-kulcs -> true (felhasznált tippek)
    wrong: {}, // feladat-kulcs -> rossz válaszok száma
    penaltyMs: 0,
  };
}

function pruneMembers(team, now) {
  for (const [sid, seen] of team.members) {
    if (now - seen > config.MEMBER_IDLE_MS) team.members.delete(sid);
  }
}

function leaveTeam(req) {
  const code = req.session.teamCode;
  const team = code ? teams.get(code) : null;
  if (team && team.members.delete(req.sessionID)) {
    if (team.members.size === 0) {
      teams.delete(code);
      logEvent(team, 'Az utolsó tag is kilépett, a csapat megszűnt');
    } else {
      logEvent(team, `Egy tag kilépett (${team.members.size}/${MAX_TEAM_SIZE} fő)`);
    }
  }
  req.session.teamCode = null;
}

// A munkamenet csapatát adja vissza, ha a munkamenet még tagja annak.
function currentTeam(req) {
  const code = req.session.teamCode;
  const team = code ? teams.get(code) : null;
  if (!team) return null;
  const now = Date.now();
  pruneMembers(team, now);
  if (!team.members.has(req.sessionID)) return null;
  team.members.set(req.sessionID, now);
  team.lastActive = now;
  return team;
}

function requireTeam(req, res) {
  const team = currentTeam(req);
  if (!team) {
    res.status(401).json({ error: 'Nem vagy csapat tagja. Hozz létre csapatot vagy csatlakozz egyhez!' });
    return null;
  }
  return team;
}

// ---------- állapot-segédek ----------

function currentStage(team) {
  return team && !team.finished ? STAGES[team.stageIndex] : null;
}

// Egyedi azonosító az aktuális feladatra (a szfinxnél a rejtvény sorszámával együtt).
// A kliens ezt visszaküldi, így a késve érkező válasz nem a következő feladatra számít.
function stageKey(team) {
  const stage = currentStage(team);
  if (!stage) return 'vege';
  return stage.type === 'riddles' ? `${stage.id}#${team.riddleIndex}` : stage.id;
}

function isStale(team, req) {
  const key = req.body?.expectKey;
  return typeof key === 'string' && key !== stageKey(team);
}

function advance(team, { by = null } = {}) {
  const now = Date.now();
  const solved = STAGES[team.stageIndex];
  if (solved) logEvent(team, by ? `Átléptetve (${by}): ${solved.title}` : `Megoldva: ${solved.title}`);
  team.stageIndex += 1;
  team.riddleIndex = 0;
  team.sharkStartedAt = null;
  team.sharkZone = null;
  team.stageStartedAt = now;
  team.keyStartedAt = now;
  if (team.stageIndex >= STAGES.length) {
    team.finished = true;
    team.finishedAt = now;
    logEvent(team, 'Célba ért: Atlantisz!');
  }
}

function nextRiddle(team) {
  team.riddleIndex += 1;
  team.keyStartedAt = Date.now();
}

function registerWrong(team) {
  const key = stageKey(team);
  team.wrong[key] = (team.wrong[key] || 0) + 1;
}

// ---------- segítség (tipp) ----------

function hintTextOf(team) {
  const stage = currentStage(team);
  if (!stage) return null;
  if (stage.type === 'riddles') return stage.riddles[team.riddleIndex].hint || null;
  return stage.hint || null;
}

function hintInfo(team) {
  const text = hintTextOf(team);
  if (!text) return null;
  const key = stageKey(team);
  const used = Boolean(team.hints[key]);
  const wrong = team.wrong[key] || 0;
  const elapsed = Date.now() - (team.keyStartedAt || team.stageStartedAt);
  const availableInMs = used || wrong >= config.HINT_AFTER_WRONG ? 0 : Math.max(0, config.HINT_AFTER_MS - elapsed);
  return {
    used,
    available: availableInMs === 0,
    availableInMs,
    afterWrong: config.HINT_AFTER_WRONG,
    penaltyMinutes: Math.round(config.HINT_PENALTY_MS / 60000),
    text: used ? text : null,
  };
}

// ---------- eredmények és ranglista ----------

function totalMs(team) {
  return (team.finishedAt || Date.now()) - team.createdAt + team.penaltyMs;
}

function finishedRanking() {
  return [...teams.values()].filter((t) => t.finished).sort((a, b) => totalMs(a) - totalMs(b));
}

// Közös ranglista-számítás: a kivetítőnek, az adminnak és a célba ért csapat telefonjának.
// Csapatkódot nem tartalmaz; a „saját csapat" jelölése csak a csapat tagjainak megy ki.
function leaderboardData(viewer = null) {
  const finished = finishedRanking();
  const playing = [...teams.values()]
    .filter((t) => !t.finished)
    .sort((a, b) => b.stageIndex - a.stageIndex || b.riddleIndex - a.riddleIndex || a.keyStartedAt - b.keyStartedAt);
  const mark = (t) => (viewer ? { isMe: t === viewer } : {});
  return {
    serverTime: Date.now(),
    game: gameInfo(),
    totalStages: STAGES.length,
    maxDepth: ATLANTIS_DEPTH,
    teams: [
      ...finished.map((t, i) => ({
        rank: i + 1,
        name: t.name,
        finished: true,
        depth: ATLANTIS_DEPTH,
        stage: 'Atlantisz',
        totalMs: totalMs(t),
        penaltyMs: t.penaltyMs,
        ...mark(t),
      })),
      ...playing.map((t) => ({
        rank: null,
        name: t.name,
        finished: false,
        depth: STAGES[t.stageIndex].depth,
        stage: STAGES[t.stageIndex].title,
        ...mark(t),
      })),
    ],
  };
}

function resultOf(team) {
  const ranking = finishedRanking();
  return {
    rank: ranking.indexOf(team) + 1,
    finishedTeams: ranking.length,
    totalMs: totalMs(team),
    penaltyMs: team.penaltyMs,
    hintsUsed: Object.keys(team.hints).length,
    photos: team.photos,
    retentionDays: config.PHOTO_RETENTION_DAYS,
  };
}

// ---------- a játékosnak küldött állapot (megoldások nélkül) ----------

function publicStage(stage, team) {
  const base = {
    id: stage.id,
    key: stageKey(team),
    type: stage.type,
    title: stage.title,
    intro: stage.intro,
    instructions: stage.instructions,
    depth: stage.depth,
    hint: hintInfo(team),
  };
  switch (stage.type) {
    case 'choice':
      return { ...base, question: stage.question, image: stage.image, imageAlt: stage.imageAlt, options: stage.options };
    case 'text':
    case 'gate':
      return { ...base, question: stage.question, image: stage.image, imageAlt: stage.imageAlt };
    case 'letters':
      return { ...base, question: stage.question, text: stage.text, marked: stage.marked };
    case 'upload':
      return {
        ...base,
        references: (stage.references || []).map((r) => (typeof r === 'string' ? { src: r, name: '' } : r)),
        retentionDays: config.PHOTO_RETENTION_DAYS,
      };
    case 'shark':
      return { ...base, shark: { speed: SHARK.speed, greenWidth: SHARK.greenWidth } };
    case 'riddles': {
      const r = stage.riddles[team.riddleIndex];
      return { ...base, riddle: r.q, riddleNo: team.riddleIndex + 1, riddleTotal: stage.riddles.length };
    }
    default:
      return base;
  }
}

function teamInfo(team) {
  return { name: team.name, code: team.code, members: team.members.size, maxMembers: MAX_TEAM_SIZE };
}

// ---------- a játék vége (GAME_END_AT): utána nincs új csapat és nincs válasz, a ranglista végleges ----------

const gameEnded = () => config.GAME_END_AT !== null && Date.now() >= config.GAME_END_AT;
const endClock = () =>
  config.GAME_END_AT === null
    ? ''
    : new Date(config.GAME_END_AT).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: config.TIME_ZONE });
function gameInfo() {
  return { endsAt: config.GAME_END_AT, endClock: endClock(), ended: gameEnded(), note: config.RESULTS_NOTE };
}
function endMessage() {
  return `A játék ${endClock()}-kor véget ért, már nem lehet válaszolni.${config.RESULTS_NOTE ? ` ${config.RESULTS_NOTE}` : ''}`;
}
function gameOpen(req, res, next) {
  if (!gameEnded()) return next();
  const team = currentTeam(req);
  res.status(403).json({ error: endMessage(), ended: true, state: stateOf(team) });
}

function stateOf(team) {
  return { ...stateCore(team), game: gameInfo() };
}

function stateCore(team) {
  if (!team) return { started: false };
  if (team.finished) {
    return {
      started: true,
      finished: true,
      team: teamInfo(team),
      depth: ATLANTIS_DEPTH,
      progress: { done: STAGES.length, total: STAGES.length },
      result: resultOf(team),
    };
  }
  const stage = STAGES[team.stageIndex];
  return {
    started: true,
    finished: false,
    team: teamInfo(team),
    depth: stage.depth,
    progress: { done: team.stageIndex, total: STAGES.length },
    stage: publicStage(stage, team),
  };
}

function staleResponse(res, team) {
  return res.json({ correct: false, stale: true, message: STALE_MESSAGE, state: stateOf(team) });
}

// ---------- fotók: törlés és megőrzési idő ----------

function removeFile(file) {
  if (file) fs.unlink(file.path, () => {});
}

// A feltöltési naplóból kiveszi a megadott fájlok sorait (pl. törlési kérelemnél vagy lejáratkor)
function pruneUploadLog(keep) {
  if (!fs.existsSync(UPLOAD_LOG)) return;
  const lines = fs.readFileSync(UPLOAD_LOG, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((line) => {
    try {
      return keep(JSON.parse(line));
    } catch {
      return false;
    }
  });
  if (kept.length !== lines.length) {
    fs.writeFileSync(UPLOAD_LOG, kept.length ? `${kept.join('\n')}\n` : '');
  }
}

function deletePhotos(team) {
  const files = new Set(team.photos);
  for (const file of files) fs.rmSync(path.join(UPLOAD_DIR, file), { force: true });
  team.photos = [];
  team.photoMeta = {};
  pruneUploadLog((entry) => !files.has(entry.file));
  return files.size;
}

// A megőrzési idő lejárta után a fotók automatikusan törlődnek (a tájékoztatóban vállalt határidő)
function purgeExpiredPhotos(now = Date.now()) {
  const cutoff = now - config.PHOTO_RETENTION_DAYS * DAY_MS;
  const expired = new Set();
  for (const file of fs.readdirSync(UPLOAD_DIR)) {
    if (!PHOTO_NAME.test(file)) continue;
    const full = path.join(UPLOAD_DIR, file);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        expired.add(file);
      }
    } catch {
      /* időközben törölték */
    }
  }
  if (expired.size) {
    for (const team of teams.values()) {
      team.photos = team.photos.filter((f) => !expired.has(f));
      for (const f of expired) delete team.photoMeta[f];
    }
  }
  pruneUploadLog((entry) => !expired.has(entry.file) && Date.parse(entry.at) >= cutoff);
  return expired.size;
}
purgeExpiredPhotos();

// ---------- csapat-kezelés ----------

app.get('/api/game', (req, res) => {
  res.json(stateOf(currentTeam(req)));
});

app.post('/api/team/create', createLimit, gameOpen, (req, res) => {
  const checked = checkTeamName(req.body?.name);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  leaveTeam(req);
  if (teams.size >= config.MAX_TEAMS) {
    return res.status(503).json({ error: 'Most nem lehet több csapatot létrehozni. Szólj a szervezőnek!' });
  }
  const name = checked.name;
  const code = newCode();
  const team = newTeam(code, name, req.sessionID, Date.now());
  teams.set(code, team);
  req.session.teamCode = code;
  logEvent(team, 'Csapat létrehozva');
  res.json(stateOf(team));
});

app.post('/api/team/join', joinLimit, gameOpen, (req, res) => {
  const code = String(req.body?.code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
  const team = teams.get(code);
  if (!team) {
    return res.status(404).json({ error: 'Nincs ilyen csapatkód. Ellenőrizd, és próbáld újra!' });
  }
  const now = Date.now();
  pruneMembers(team, now);
  const alreadyIn = team.members.has(req.sessionID);
  if (!alreadyIn && team.members.size >= MAX_TEAM_SIZE) {
    return res.status(409).json({ error: `A csapat betelt (max. ${MAX_TEAM_SIZE} fő).` });
  }
  if (req.session.teamCode !== code) leaveTeam(req);
  team.members.set(req.sessionID, now);
  team.lastActive = now;
  req.session.teamCode = code;
  if (!alreadyIn) logEvent(team, `Új tag csatlakozott (${team.members.size}/${MAX_TEAM_SIZE} fő)`);
  res.json(stateOf(team));
});

app.post('/api/team/leave', (req, res) => {
  leaveTeam(req);
  res.json({ started: false });
});

// ---------- feladatok ----------

// ---------- a kapu egyszer használható kódjai ----------
// Ha a kapu QR-kódját nem a játék böngészője nyitja meg, a kapu oldala egy friss kódot mutat. Minden
// beolvasás új kódot ad, egy kód csak egyszer és csak rövid ideig érvényes: így egy csapat nem tudja
// egyszerűen bemondani a többieknek – a kaput nekik is meg kell találniuk.
const gateCodes = new Map(); // kód -> lejárat
const GATE_CODE_LEN = 6;
function issueGateCode() {
  const now = Date.now();
  if (gateCodes.size > 2000) {
    for (const [c, exp] of gateCodes) if (exp < now) gateCodes.delete(c);
    while (gateCodes.size > 2000) gateCodes.delete(gateCodes.keys().next().value);
  }
  let code;
  do {
    code = Array.from({ length: GATE_CODE_LEN }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (gateCodes.has(code));
  gateCodes.set(code, now + config.GATE_CODE_TTL_MIN * 60 * 1000);
  return code;
}
function consumeGateCode(value) {
  const code = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const exp = gateCodes.get(code);
  if (!exp) return false;
  gateCodes.delete(code);
  return exp >= Date.now();
}

// Szöveges / választós / rejtvényes feladatok
app.post('/api/game/answer', answerLimit, gameOpen, (req, res) => {
  const team = requireTeam(req, res);
  if (!team) return;
  if (isStale(team, req)) return staleResponse(res, team);
  const stage = currentStage(team);
  if (!stage) return res.status(400).json({ error: 'A csapat már a végén jár.' });
  if (!['choice', 'text', 'gate', 'letters', 'riddles'].includes(stage.type)) {
    return res.status(400).json({ error: 'Ehhez a feladathoz most nem szöveges válasz kell.' });
  }

  const value = String(req.body?.value ?? '').slice(0, 100);
  let correct;
  if (stage.type === 'gate') {
    // a kapu egyszer használható kódja (vagy a kifejezetten megadott tartalék kód)
    correct = consumeGateCode(value) || Boolean(config.GATE_CODE && sameAnswer(value, config.GATE_CODE));
  } else {
    const expected = stage.type === 'riddles' ? stage.riddles[team.riddleIndex].a : stage.answer;
    if (expected == null) {
      return res.status(503).json({ error: 'Ez a feladat még nincs beállítva – szóljatok a szervezőnek!' });
    }
    correct = sameAnswer(value, expected);
  }
  if (!correct) {
    registerWrong(team);
    return res.json({
      correct: false,
      message: 'Nem ez a megoldás. Figyeld meg jobban, és próbáld újra!',
      state: stateOf(team),
    });
  }

  if (stage.type === 'riddles' && team.riddleIndex < stage.riddles.length - 1) {
    nextRiddle(team);
    return res.json({
      correct: true,
      message: 'A szfinx bólint. Jöjjön a következő rejtvény!',
      state: stateOf(team),
    });
  }

  const message = stage.successText;
  advance(team);
  return res.json({ correct: true, message, state: stateOf(team) });
});

// Segítség kérése: csak ha már elérhető; az első kéréskor időbüntetés jár, az ismételt lekérés ingyenes
app.post('/api/game/hint', answerLimit, gameOpen, (req, res) => {
  const team = requireTeam(req, res);
  if (!team) return;
  if (isStale(team, req)) return staleResponse(res, team);
  const info = currentStage(team) ? hintInfo(team) : null;
  if (!info) return res.status(400).json({ error: 'Ehhez a feladathoz nincs segítség.' });
  if (!info.available) {
    return res.status(400).json({ error: 'A segítség még nem kérhető. Próbálkozzatok még egy kicsit!' });
  }
  if (!info.used) {
    team.hints[stageKey(team)] = true;
    team.penaltyMs += config.HINT_PENALTY_MS;
    logEvent(team, `Segítséget kért: ${currentStage(team).title} (+${Math.round(config.HINT_PENALTY_MS / 60000)} perc)`);
  }
  res.json({ hint: hintTextOf(team), state: stateOf(team) });
});

// Cápa-kör: a zöld sávot a szerver sorsolja minden indításkor. A kezdést a szerver rögzíti,
// az időzítést a telefon méri (így a hálózati késleltetés nem tolja el az ütést).
app.post('/api/game/shark/start', gameOpen, (req, res) => {
  const team = requireTeam(req, res);
  if (!team) return;
  const stage = currentStage(team);
  if (!stage || stage.type !== 'shark') return res.status(400).json({ error: 'Most nincs cápa-kör.' });
  team.sharkZone = { start: crypto.randomInt(SHARK.zoneMin, SHARK.zoneMax + 1), width: SHARK.greenWidth };
  team.sharkStartedAt = Date.now();
  res.json({ shark: { speed: SHARK.speed, greenStart: team.sharkZone.start, greenWidth: team.sharkZone.width } });
});

app.post('/api/game/shark/press', answerLimit, gameOpen, (req, res) => {
  const team = requireTeam(req, res);
  if (!team) return;
  if (isStale(team, req)) return staleResponse(res, team);
  const stage = currentStage(team);
  if (!stage || stage.type !== 'shark') return res.status(400).json({ error: 'Most nincs cápa-kör.' });

  const zone = team.sharkZone;
  const wasStarted = team.sharkStartedAt !== null && zone !== null;
  team.sharkStartedAt = null;
  team.sharkZone = null;
  if (!wasStarted) return res.status(400).json({ error: 'Előbb indítsd el a kört!' });

  const elapsed = req.body?.elapsedMs;
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0) {
    return res.status(400).json({ error: 'Érvénytelen ütés.' });
  }
  if (elapsed > SHARK_MAX_AGE_MS) {
    registerWrong(team);
    return res.json({ correct: false, message: 'Túl későn! A cápa már elúszott.', state: stateOf(team) });
  }

  const angle = ((elapsed / 1000) * SHARK.speed) % 360;
  const hit = angle >= zone.start && angle <= zone.start + zone.width;
  if (!hit) {
    registerWrong(team);
    return res.json({ correct: false, message: 'A cápa a piros vízben volt. Próbáld újra!', state: stateOf(team) });
  }

  const message = stage.successText;
  advance(team);
  return res.json({ correct: true, message, state: stateOf(team) });
});

// Szobor-fotó feltöltés (a kliens már tömörítve küldi, így gyenge mobilneten is megy)
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    // A kiterjesztést a tényleges MIME-típusból adjuk, nem a kliens által küldött névből
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const photoUpload = multer({
  storage,
  limits: { fileSize: config.UPLOAD_MAX_MB * 1024 * 1024, fields: 10, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

// A kliens által megadott típus hamisítható: a fájl első bájtjait is ellenőrizzük
function looksLikeImage(filePath, mime) {
  const head = Buffer.alloc(12);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, head, 0, 12, 0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (mime === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

app.post('/api/game/upload', gameOpen, (req, res) => {
  photoUpload.single('photo')(req, res, (err) => {
    if (err) {
      const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig
          ? `A kép túl nagy (max. ${config.UPLOAD_MAX_MB} MB).`
          : 'Hibás feltöltés. Válassz egy képet, és próbáld újra!',
      });
    }

    const team = requireTeam(req, res);
    if (!team) return removeFile(req.file);

    const stage = currentStage(team);
    if (isStale(team, req)) {
      removeFile(req.file);
      return staleResponse(res, team);
    }
    if (!stage || stage.type !== 'upload') {
      removeFile(req.file);
      return res.status(400).json({ error: 'Most nem várunk fotót.' });
    }
    // GDPR / képmáshoz való jog: a fotón szereplők hozzájárulása nélkül nem fogadunk el képet
    if (req.body?.consent !== 'yes') {
      removeFile(req.file);
      return res.status(400).json({
        error: 'A feltöltéshez jelöld be, hogy a fotón szereplők hozzájárultak, és elolvastátok a tájékoztatót.',
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Nem érkezett támogatott kép (JPG, PNG vagy WEBP).' });
    }
    if (!looksLikeImage(req.file.path, req.file.mimetype)) {
      removeFile(req.file);
      return res.status(400).json({ error: 'A fájl nem érvényes kép. Válassz egy fotót!' });
    }

    const publish = req.body?.publish === 'yes';
    const entry = {
      at: new Date().toISOString(),
      team: team.name,
      code: team.code,
      stage: stage.id,
      file: req.file.filename,
      consent: true,
      publish,
    };
    fs.appendFile(UPLOAD_LOG, JSON.stringify(entry) + '\n', () => {});
    team.photos.push(req.file.filename);
    team.photoMeta[req.file.filename] = { publish, at: Date.now() };
    logEvent(team, `Fotót töltött fel${publish ? ' (közzétehető)' : ''}`);

    const message = stage.successText;
    advance(team);
    return res.json({ correct: true, message, state: stateOf(team) });
  });
});

function sendPhoto(res, file) {
  const full = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Nincs ilyen fotó.' });
  // A fájlnév egyedi és a tartalom nem változik: a böngésző gyorsítótárazhatja (csak privátan)
  res.set('Cache-Control', 'private, max-age=3600');
  return res.sendFile(full);
}

// A csapat a saját fotóit láthatja (a záróképernyőn), másét nem
app.get('/api/game/photos/:file', (req, res) => {
  const team = requireTeam(req, res);
  if (!team) return;
  const file = String(req.params.file);
  if (!PHOTO_NAME.test(file) || !team.photos.includes(file)) {
    return res.status(404).json({ error: 'Nincs ilyen fotó.' });
  }
  return sendPhoto(res, file);
});

// ---------- QR-kapu ----------

// Ha a játékot futtató böngészővel szkennelik, a kapu magától kinyílik (nincs kód, amit el lehetne árulni).
// Ha másik böngésző nyílik meg (nincs munkamenet), a kódot mutatjuk, hogy kézzel beírható legyen.
app.get('/kapu/:secret', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.params.secret !== config.GATE_QR_SECRET) {
    return res.type('html').send(gatePage('closed'));
  }
  const team = currentTeam(req);
  if (!team) return res.type('html').send(gatePage('code', { code: issueGateCode(), minutes: config.GATE_CODE_TTL_MIN }));
  if (team.finished) return res.type('html').send(gatePage('finished', { name: team.name }));
  if (gameEnded()) return res.type('html').send(gatePage('ended', { name: team.name, message: endMessage() }));
  if (team.stageIndex < GATE_INDEX) {
    logEvent(team, 'Túl korán szkennelte a QR-kaput');
    return res.type('html').send(gatePage('early', { name: team.name }));
  }
  logEvent(team, 'A QR-kódot szkennelve nyitotta a kaput');
  advance(team);
  return res.type('html').send(gatePage('opened', { name: team.name }));
});

// ---------- kivetíthető ranglista (nyilvános, csak olvasható; csapatkódot nem árul el) ----------

app.get('/api/leaderboard', (req, res) => {
  if (!config.PUBLIC_BOARD) return res.status(404).json({ error: 'A ranglista ki van kapcsolva.' });
  res.set('Cache-Control', 'no-store');
  res.json(leaderboardData());
});

// A célba ért csapat a telefonján követheti az élő ranglistát (a saját csapata kiemelve).
// Ez a kivetítő kikapcsolásától függetlenül működik.
app.get('/api/game/leaderboard', (req, res) => {
  const team = requireTeam(req, res);
  if (!team) return;
  if (!team.finished) return res.status(403).json({ error: 'A ranglista a cél elérése után látható.' });
  res.set('Cache-Control', 'no-store');
  res.json(leaderboardData(team));
});

app.get('/ranglista', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'ranglista.html'));
});

// ---------- adatkezelési tájékoztató ----------

app.get('/adatvedelem', (req, res) => {
  res.type('html').send(privacyPage(config));
});

// ---------- admin felület: jelszó nélkül, szervezői linkkel vagy a szerver gépéről ----------

const ADMIN_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ADMIN_KEY_FILE = path.join(path.dirname(config.DATA_FILE), 'admin-key.txt');

// A kulcs forrása: ADMIN_KEY környezeti változó, különben a mentett fájl, különben egy új, véletlen kulcs
function loadAdminKey() {
  if (config.ADMIN_KEY) {
    if (!ADMIN_KEY_RE.test(config.ADMIN_KEY)) {
      throw new Error('Az ADMIN_KEY 16–128 karakter legyen, csak betű, szám, kötőjel és aláhúzás.');
    }
    return { key: config.ADMIN_KEY, fromEnv: true };
  }
  try {
    const saved = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
    if (ADMIN_KEY_RE.test(saved)) return { key: saved, fromEnv: false };
  } catch {
    /* még nincs kulcs: generálunk */
  }
  return { key: writeNewAdminKey(), fromEnv: false };
}

function writeNewAdminKey() {
  const key = crypto.randomBytes(24).toString('base64url'); // 32 karakter, 192 bit
  fs.mkdirSync(path.dirname(ADMIN_KEY_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_KEY_FILE, `${key}\n`, { mode: 0o600 });
  return key;
}

let adminKey = loadAdminKey();
// A belépett munkamenet a kulcs lenyomatát kapja: kulcscsere után a régi belépések érvénytelenek
const keyId = () => crypto.createHash('sha256').update(adminKey.key).digest('hex').slice(0, 24);
const adminLink = () => `${config.BASE_URL.replace(/\/+$/, '')}/admin/${adminKey.key}`;

function keyMatches(given) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(adminKey.key).digest();
  return crypto.timingSafeEqual(a, b);
}

// A szerver saját gépéről érkező kérés. Csak ha: a kapcsolat valóban a loopback-ről jön, a böngésző
// localhost címet használ (DNS-rebinding ellen), és nincs proxy-fejléc (alagút vagy helyi proxy esetén
// minden kérés a loopback-ről jönne, ezért azokat nem tekintjük helyinek).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function isLocalRequest(req) {
  if (!config.ADMIN_LOCAL || config.TRUST_PROXY) return false;
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return false;
  const proxied = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-host'];
  return !proxied.some((h) => h in req.headers);
}

function isAdmin(req) {
  if (isLocalRequest(req)) return true;
  return req.session.isAdmin === true && req.session.adminKeyId === keyId();
}

// Nem szervezőnek az admin rész egyszerűen nem létezik (404), nem árulja el magát
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(404).json({ error: 'Nincs ilyen művelet.' });
  next();
}

// Módosító admin-kérés csak JSON-ként fogadható el (CSRF elleni plusz védelem a SameSite süti mellett)
function requireJson(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON kérés szükséges.' });
  next();
}

// Kulcs-találgatás ellen: percenként 10 hibás próbálkozás után zárolás (IP-nként)
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // ip -> { count, reset }
limiters.push(loginFailures);
function loginBlocked(ip) {
  const e = loginFailures.get(ip);
  return Boolean(e && Date.now() <= e.reset && e.count >= LOGIN_MAX_FAILURES);
}
function loginFailed(ip) {
  const now = Date.now();
  let e = loginFailures.get(ip);
  if (!e || now > e.reset) {
    e = { count: 0, reset: now + 60 * 1000 };
    loginFailures.set(ip, e);
  }
  e.count += 1;
}

function adminTeam(team) {
  const stage = currentStage(team);
  return {
    code: team.code,
    name: team.name,
    members: team.members.size,
    maxMembers: MAX_TEAM_SIZE,
    stageIndex: team.stageIndex,
    stageId: stage ? stage.id : null,
    stageTitle: stage ? stage.title : 'Atlantisz',
    riddleNo: stage && stage.type === 'riddles' ? team.riddleIndex + 1 : null,
    depth: stage ? stage.depth : ATLANTIS_DEPTH,
    finished: team.finished,
    createdAt: team.createdAt,
    stageStartedAt: team.stageStartedAt,
    finishedAt: team.finishedAt,
    lastActive: team.lastActive,
    hintsUsed: Object.keys(team.hints).length,
    penaltyMs: team.penaltyMs,
    totalMs: team.finished ? totalMs(team) : null,
    photos: team.photos.map((file) => ({ file, publish: Boolean(team.photoMeta[file]?.publish) })),
  };
}

// A szervezői link: egyszeri megnyitás után a telefon belépve marad (ADMIN_SESSION_HOURS óráig)
app.get('/admin/:key', (req, res, next) => {
  if (req.params.key === 'plakat') return next(); // a nyomtatható plakát útvonala (lent)
  res.set('Cache-Control', 'no-store');
  if (loginBlocked(req.ip)) return res.status(429).type('html').send(notFoundPage());
  if (!keyMatches(req.params.key)) {
    loginFailed(req.ip);
    return res.status(404).type('html').send(notFoundPage());
  }
  loginFailures.delete(req.ip);
  // Új munkamenet-azonosító a belépéskor (session fixation ellen)
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.isAdmin = true;
    req.session.adminKeyId = keyId();
    req.session.cookie.maxAge = config.ADMIN_SESSION_HOURS * 60 * 60 * 1000;
    // átirányítás a kulcs nélküli címre: a kulcs nem marad a címsorban és az előzményekben
    res.redirect(303, '/admin');
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  req.session.adminKeyId = null;
  res.json({ ok: true, stillLocal: isLocalRequest(req) });
});

// Új szervezői link: a régi linkkel belépett többi telefon hozzáférése azonnal megszűnik
app.post('/api/admin/key/rotate', requireAdmin, requireJson, (req, res) => {
  if (adminKey.fromEnv) {
    return res.status(409).json({ error: 'A kulcs az ADMIN_KEY környezeti változóban van megadva, ott cseréld le, majd indítsd újra a szervert.' });
  }
  adminKey = { key: writeNewAdminKey(), fromEnv: false };
  if (req.session.isAdmin) req.session.adminKeyId = keyId();
  logEvent(null, 'Új szervezői link készült, a régi linkkel belépett telefonok kiléptek');
  res.json({ ok: true, link: adminLink() });
});

// A szervezői link QR-kódja (a Beállítások fülön, a többi szervező telefonjához)
app.get('/api/admin/access-qr.png', requireAdmin, async (req, res, next) => {
  try {
    const png = await QRCode.toBuffer(adminLink(), { width: 600, margin: 2 });
    res.set('Cache-Control', 'no-store');
    res.type('png').send(png);
  } catch (err) {
    next(err);
  }
});

// A rendezvény előtti ellenőrzőlista: mi van rendben, és mi hiányzik még
const STAGE_IMAGES = STAGES.flatMap((s) => [
  ...(s.references || []).map((r) => (typeof r === 'string' ? r : r.src)),
  ...(s.image ? [s.image] : []),
]);

function configStatus() {
  const missingImages = STAGE_IMAGES.filter((p) => !fs.existsSync(path.join(PUBLIC_DIR, p)));
  const local = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.BASE_URL);
  const save = persistence.status();
  const checks = [
    {
      ok: !unconfigured.length,
      label: 'Minden állomás be van állítva',
      detail: unconfigured.length ? 'Hiányzik a régi üzenet megoldása (LETTERS_ANSWER). Az ide érő csapatokat át kell léptetni.' : 'Rendben.',
    },
    {
      ok: true,
      label: 'Saját titkok és kapukód',
      detail: `${config.GENERATED_SECRETS.length ? `A szerver generálta őket (${config.GENERATED_SECRETS.join(', ')}), a data mappában vannak.` : 'Megadva.'} ${
        config.GATE_CODE ? 'Tartalék kapukód is be van állítva (GATE_CODE): ezt ne adjátok ki.' : 'A kapu minden beolvasáskor egyszer használható kódot ad.'
      }`,
    },
    {
      ok: !local,
      label: 'A QR-kód a telefonokról elérhető címre mutat',
      detail: local
        ? `A BASE_URL most ${config.BASE_URL}, ezt telefonról nem lehet megnyitni.`
        : config.BASE_URL_AUTO
          ? `${config.BASE_URL} (automatikusan felismerve: a telefonok ugyanazon a Wi-Fin legyenek, mint ez a gép)`
          : config.BASE_URL,
    },
    {
      ok: Boolean(config.PRIVACY_CONTROLLER && config.PRIVACY_CONTACT),
      label: 'Adatkezelési tájékoztató kitöltve',
      detail:
        config.PRIVACY_CONTROLLER && config.PRIVACY_CONTACT
          ? 'Rendben.'
          : 'Hiányzik az adatkezelő (PRIVACY_CONTROLLER) vagy az elérhetőség (PRIVACY_CONTACT).',
    },
    {
      ok: !missingImages.length,
      label: 'A feladatok képei megvannak',
      detail: missingImages.length ? `Hiányzik: ${missingImages.join(', ')}` : 'Rendben.',
    },
    {
      // Csak valódi mentési hiba számít problémának; frissen indított szervernél még nem volt mentés
      ok: !save.lastError,
      label: 'A játék állása mentődik',
      detail: save.lastError
        ? `Mentési hiba: ${save.lastError}`
        : save.lastSavedAt
          ? `Utolsó mentés: ${new Date(save.lastSavedAt).toLocaleTimeString('hu-HU')}`
          : `Még nem volt mentés (${Math.round(config.SAVE_INTERVAL_MS / 1000)} másodpercenként ment, ha változott valami).`,
    },
  ];
  return {
    checks,
    settings: [
      ['Mód', config.PRODUCTION ? 'éles (production)' : 'fejlesztői'],
      ['Játék címe', config.BASE_URL],
      ['Csapatlétszám', `legfeljebb ${MAX_TEAM_SIZE} fő`],
      ['A játék vége', config.GAME_END_AT === null ? 'nincs időkorlát' : `${new Date(config.GAME_END_AT).toLocaleString('hu-HU', { timeZone: config.TIME_ZONE })}${gameEnded() ? ' (lezárult)' : ''}`],
      ['Eredményhirdetés szövege', config.RESULTS_NOTE || '–'],
      ['Segítség', `${Math.round(config.HINT_AFTER_MS / 60000)} perc vagy ${config.HINT_AFTER_WRONG} rossz válasz után, +${Math.round(config.HINT_PENALTY_MS / 60000)} perc`],
      ['Fotók megőrzése', `${config.PHOTO_RETENTION_DAYS} nap`],
      ['Kivetíthető ranglista', config.PUBLIC_BOARD ? 'bekapcsolva' : 'kikapcsolva'],
      ['Mentésfájl', save.file],
      ['A szerver fut', `${new Date(STARTED_AT).toLocaleString('hu-HU')} óta`],
    ],
  };
}

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const list = [...teams.values()].map(adminTeam);
  res.json({
    serverTime: Date.now(),
    totals: {
      teams: list.length,
      players: list.reduce((sum, t) => sum + t.members, 0),
      finished: list.filter((t) => t.finished).length,
      photos: list.reduce((sum, t) => sum + t.photos.length, 0),
    },
    stages: STAGES.map((s) => ({ id: s.id, title: s.title, depth: s.depth })),
    unconfigured,
    retentionDays: config.PHOTO_RETENTION_DAYS,
    publicBoard: config.PUBLIC_BOARD,
    gateUrl: GATE_URL,
    joinUrl: JOIN_URL,
    baseIsLocal: BASE_IS_LOCAL,
    access: { link: adminLink(), local: isLocalRequest(req), fromEnv: adminKey.fromEnv, hours: config.ADMIN_SESSION_HOURS },
    teams: list,
    leaderboard: leaderboardData().teams,
    events: events.slice(-150).reverse(),
    status: configStatus(),
  });
});

// A helyszínre kinyomtatandó QR-kód, közvetlenül az admin felületről (nem kell hozzá parancssor)
app.get('/api/admin/qr.png', requireAdmin, async (req, res, next) => {
  try {
    const png = await QRCode.toBuffer(GATE_URL, { width: 800, margin: 2 });
    // A QR-kód a szerver futása alatt nem változik: a böngésző gyorsítótárazhatja (csak privátan)
    res.set('Cache-Control', 'private, max-age=3600');
    if (req.query.download) res.set('Content-Disposition', 'attachment; filename="atlantisz-qr-kapu.png"');
    res.type('png').send(png);
  } catch (err) {
    next(err);
  }
});

// Belépő QR-kód a játékhoz (plakátra, szórólapra): nyomdai minőségű, vektoros SVG,
// középen az ESK–IVK emblémával. (PNG-t az admin felület készít belőle a böngészőben.)
app.get('/api/admin/join-qr.svg', requireAdmin, (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, max-age=3600');
    if (req.query.download) res.set('Content-Disposition', 'attachment; filename="atlantisz-qr-jatek.svg"');
    res.type('image/svg+xml').send(qrArtSvg(JOIN_URL, { logo: req.query.logo !== '0' }));
  } catch (err) {
    next(err);
  }
});

// Nyomtatható A4-es plakát: ?mi=jatek (belépés) vagy ?mi=kapu (Atlantisz kapuja), ?tema=sotet
app.get('/admin/plakat', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!isAdmin(req)) return res.status(404).type('html').send(notFoundPage());
  try {
    const kind = POSTERS[req.query.mi] ? req.query.mi : 'jatek';
    const url = kind === 'kapu' ? GATE_URL : JOIN_URL;
    const svg = qrArtSvg(url, { margin: 1 });
    res.type('html').send(
      posterPage({
        kind,
        url: JOIN_URL.replace(/\/$/, ''),
        svg,
        dark: req.query.tema !== 'vilagos', // alapból a sötét, a játékhoz illő változat
        cards: req.query.meret === 'kartya',
        showUrl: !BASE_IS_LOCAL,
      })
    );
  } catch (err) {
    next(err);
  }
});

function withTeam(handler) {
  return (req, res) => {
    const team = teams.get(String(req.params.code || '').toUpperCase());
    if (!team) return res.status(404).json({ error: 'Nincs ilyen csapat.' });
    handler(team, req, res);
  };
}

// Elakadt csapat átléptetése a következő állomásra
app.post('/api/admin/teams/:code/advance', requireAdmin, requireJson, withTeam((team, req, res) => {
  if (team.finished) return res.status(400).json({ error: 'A csapat már célba ért.' });
  advance(team, { by: 'admin' });
  res.json({ ok: true, team: adminTeam(team) });
}));

// Visszaállítás az elejére (a tagok maradnak, a tippek és a büntetés törlődik)
app.post('/api/admin/teams/:code/reset', requireAdmin, requireJson, withTeam((team, req, res) => {
  const now = Date.now();
  Object.assign(team, {
    stageIndex: 0,
    riddleIndex: 0,
    sharkStartedAt: null,
    sharkZone: null,
    finished: false,
    finishedAt: null,
    stageStartedAt: now,
    keyStartedAt: now,
    createdAt: now,
    hints: {},
    wrong: {},
    penaltyMs: 0,
  });
  logEvent(team, 'Visszaállítva az elejére (admin)');
  res.json({ ok: true, team: adminTeam(team) });
}));

// Csapat törlése a fotóival együtt: a tagok telefonja a következő frissítéskor a kezdő képernyőre kerül
app.post('/api/admin/teams/:code/delete', requireAdmin, requireJson, withTeam((team, req, res) => {
  deletePhotos(team);
  teams.delete(team.code);
  logEvent(team, 'Csapat törölve a fotóival együtt (admin)');
  res.json({ ok: true });
}));

// A tesztfázis után: minden csapat (és alapból minden fotó) törlése, hogy tiszta lappal induljon az este.
// Véletlen kattintás ellen a „TÖRLÉS" szót be kell írni.
app.post('/api/admin/reset-all', requireAdmin, requireJson, (req, res) => {
  if (String(req.body?.confirm ?? '').trim().toUpperCase() !== 'TÖRLÉS') {
    return res.status(400).json({ error: 'A megerősítéshez írd be: TÖRLÉS' });
  }
  const count = teams.size;
  let photos = 0;
  if (req.body?.photos !== false) {
    for (const file of fs.readdirSync(UPLOAD_DIR)) {
      if (!PHOTO_NAME.test(file)) continue;
      fs.rmSync(path.join(UPLOAD_DIR, file), { force: true });
      photos += 1;
    }
    fs.rmSync(UPLOAD_LOG, { force: true });
  }
  teams.clear();
  events.length = 0;
  logEvent(null, `Minden adat törölve (admin): ${count} csapat, ${photos} fotó`);
  res.json({ ok: true, teams: count, photos });
});

// Csak a fotók törlése (pl. egy játékos törlési kérelmére)
app.post('/api/admin/teams/:code/photos/delete', requireAdmin, requireJson, withTeam((team, req, res) => {
  const removed = deletePhotos(team);
  logEvent(team, `${removed} fotó törölve (admin)`);
  res.json({ ok: true, removed });
}));

// Feltöltött fotó megtekintése (csak adminnak; szigorú fájlnév-minta a path traversal ellen)
app.get('/api/admin/photos/:file', requireAdmin, (req, res) => {
  const file = String(req.params.file);
  if (!PHOTO_NAME.test(file)) return res.status(400).json({ error: 'Érvénytelen fájlnév.' });
  return sendPhoto(res, file);
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!isAdmin(req)) return res.status(404).type('html').send(notFoundPage());
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// ---------- API-hibák: mindig JSON, soha HTML ----------

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Nincs ilyen művelet.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'A kérés túl nagy.' });
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: 'Hibás kérés formátum.' });
  }
  console.error('Váratlan hiba:', err);
  return res.status(500).json({ error: 'Váratlan szerverhiba. Próbáld újra!' });
});

// ---------- takarítás: elhagyott csapatok, lejárt munkamenetek, korlátok és lejárt fotók ----------

setInterval(() => {
  const now = Date.now();
  for (const [code, team] of teams) {
    if (now - team.lastActive > config.TEAM_TTL_MS) teams.delete(code);
  }
  for (const hits of limiters) {
    for (const [key, entry] of hits) {
      if (now > entry.reset) hits.delete(key);
    }
  }
  sessionStore.prune(now);
  purgeExpiredPhotos(now);
}, config.CLEANUP_INTERVAL_MS).unref();

const onListen = () => {
  console.log(`\nAtlantisz játék fut: ${config.BASE_URL}  (ezen a gépen: http://localhost:${config.PORT})`);
  console.log(`Admin felület ezen a gépen: http://localhost:${config.PORT}/admin${config.ADMIN_LOCAL && !config.TRUST_PROXY ? '' : ' (a helyi belépés ki van kapcsolva)'}`);
  console.log(`Szervezői link a telefonokra (ne add tovább!): ${adminLink()}`);
  if (process.stdout.isTTY) {
    QRCode.toString(adminLink(), { type: 'terminal', small: true })
      .then((qr) => console.log(`Szervezői QR-kód:\n${qr}`))
      .catch(() => {});
  }
};
if (config.HOST) app.listen(config.PORT, config.HOST, onListen);
else app.listen(config.PORT, onListen);

module.exports = { app };

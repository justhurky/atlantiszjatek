'use strict';

import { startOcean } from './ocean.js';

// ===== Elemek és konstansok =====
const app = document.getElementById('app');
const splash = document.getElementById('intro');
const marker = document.getElementById('depthMarker');
const depthValue = document.getElementById('depthValue');

const MAX_DEPTH = 200;
const SEA = { top: [58, 183, 217], mid: [10, 42, 74], deep: [1, 6, 18] };
const REQUEST_TIMEOUT_MS = 10000;
const PHOTO_MAX_SIDE = 1280;
const PHOTO_QUALITY = 0.82;

// Egyszerre csak egy művelet mehet, így a duplázott koppintás nem küld kétszer választ.
let busy = false;
let chosenPhoto = null;
// Az aktuális feladat azonosítója: a szerver ezzel ellenőrzi, hogy a válasz még aktuális-e
let currentKey = null;
// Időnkénti állapot-lekérés, hogy a csapattagok lássák a csatlakozókat és a közös haladást
let pollTimer = null;
// A segítség gomb visszaszámlálója, és az utoljára kirajzolt állapota
let hintTimer = null;
let hintSig = null;
// Az utoljára mutatott mélység: ha nő, lejátsszuk a merülés-animációt
let lastDepth = null;
// A képernyő ébren tartása játék közben
let wakeLock = null;
// Az élő ranglista frissítése a záróképernyőn
let boardTimer = null;
const LIVE_BOARD_LIMIT = 15;

let game = {}; // a játék időkerete a szervertől: { endsAt, endClock, ended, note }
let ocean = null; // az animált tengeri háttér (WebGL); gyenge eszközön nincs, ott a CSS-háttér marad
let depthShown = false;

class NetworkError extends Error {}

// ===== Segédek =====
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const seaAt = (r) => (r < 0.5 ? mix(SEA.top, SEA.mid, r * 2) : mix(SEA.mid, SEA.deep, (r - 0.5) * 2));
const rgb = (c) => `rgb(${c.join(',')})`;
const isLite = () => document.documentElement.classList.contains('lite');

function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function setDepth(depth) {
  const r = Math.min(1, Math.max(0, depth / MAX_DEPTH));
  const style = document.documentElement.style;
  style.setProperty('--sea-top', rgb(seaAt(r)));
  style.setProperty('--sea-bottom', rgb(seaAt(Math.min(1, r + 0.2))));
  style.setProperty('--rays', String(Math.max(0.08, 1 - r * 1.1)));
  style.setProperty('--snow', String(Math.min(1, r * 1.3)));
  marker.style.setProperty('--d', String(r));
  depthValue.textContent = `${depth} m`;
  // első megjelenéskor (pl. újratöltés a játék közepén) azonnal, utána lágyan merül a háttér
  if (ocean) ocean.setDepth(r, !depthShown);
  depthShown = true;
}

// Gyengébb eszközön vagy hálózaton kikapcsoljuk a drága vizuális effekteket.
function detectLite() {
  const c = navigator.connection;
  const weakNet = Boolean(c && (c.saveData || /2g|3g/.test(c.effectiveType || '')));
  const weakCpu = (navigator.hardwareConcurrency || 8) <= 4;
  const small = window.matchMedia('(max-width: 640px)').matches;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (weakNet || (weakCpu && small) || reduced) {
    document.documentElement.classList.add('lite');
  }
}

async function request(url, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const init = { method, credentials: 'same-origin', signal: controller.signal, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new NetworkError(
      err.name === 'AbortError'
        ? 'A szerver nem válaszolt időben. Próbáld újra!'
        : 'Nincs kapcsolat a szerverrel. Ellenőrizd a hálózatot!'
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  const info = data.game || data.state?.game;
  if (info) game = info;
  if (!res.ok) {
    const err = new Error(data.error || 'Váratlan hiba történt.');
    err.status = res.status;
    err.ended = Boolean(data.ended);
    err.state = data.state;
    throw err;
  }
  return data;
}

// Visszajelzés. A helyes/helytelen válasz és a hibák középen, felugró ablakban jelennek meg (telefonon
// a lap alján nem vennék észre); a semleges állapotüzenetek („Feltöltés…") maradnak a feladat alatt.
// A szöveg a lap alján is bekerül (rejtve), hogy a képernyőolvasó is felolvassa.
function setFeedback(text, kind = '') {
  const el = document.getElementById('feedback');
  const popup = Boolean(text) && (kind === 'ok' || kind === 'bad');
  if (el) {
    el.textContent = text;
    el.className = `feedback ${kind}${popup ? ' sr-only' : ''}`.trim();
  }
  if (popup) showVerdict(text, kind);
  else if (!text) hideVerdict();
}

let verdictTimer = null;

// Középre ugró ablak. Helyes válasznál a következő feladat megjelenésekor tűnik el (render),
// rossz válasznál koppintásra, az „Újrapróbálom" gombbal vagy pár másodperc után.
function showVerdict(text, kind) {
  hideVerdict();
  const ok = kind === 'ok';
  const el = document.createElement('div');
  el.className = `verdict ${ok ? 'is-ok' : 'is-bad'}`;
  el.id = 'verdict';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'verdictTitle');
  el.setAttribute('aria-describedby', 'verdictText');
  el.innerHTML = `
    <div class="verdict-card">
      <div class="verdict-icon" aria-hidden="true">${ok ? '✓' : '✕'}</div>
      <p class="verdict-title" id="verdictTitle">${ok ? 'Helyes!' : 'Nem egészen…'}</p>
      <p class="verdict-text" id="verdictText">${esc(text)}</p>
      ${ok ? '<p class="verdict-next">Merülés a következő feladathoz…</p>' : '<button class="btn" type="button" id="verdictClose">Újrapróbálom</button>'}
    </div>`;
  document.body.appendChild(el);
  if (!ok) {
    const close = () => {
      hideVerdict();
      const input = app.querySelector('form.answer input');
      if (input && !input.disabled) input.focus({ preventScroll: true });
    };
    el.addEventListener('click', close);
    el.querySelector('#verdictClose').focus({ preventScroll: true });
    verdictTimer = setTimeout(close, 4500);
  } else {
    // biztonsági időzítő, ha a következő feladat valamiért késne
    verdictTimer = setTimeout(hideVerdict, 8000);
  }
}

function hideVerdict() {
  clearTimeout(verdictTimer);
  verdictTimer = null;
  document.getElementById('verdict')?.remove();
}

function setBusy(on) {
  busy = on;
  app.querySelectorAll('button, input, select').forEach((el) => {
    el.disabled = on;
  });
}

// Egy felhasználói művelet. A visszatérési érték true, ha a zár a késleltetett render-ig marad.
async function act(fn) {
  if (busy) return;
  setBusy(true);
  let keepLocked = false;
  try {
    keepLocked = Boolean(await fn());
  } catch (err) {
    if (err instanceof NetworkError || err.status === 401) {
      await resync(err.message);
    } else if (err.ended && err.state) {
      render(err.state); // közben lejárt a játékidő
    } else {
      setFeedback(err.message, 'bad');
    }
  } finally {
    if (!keepLocked) setBusy(false);
  }
}

// Hiba után újra lekérjük az állapotot, hogy a csapat ne egy elavult képernyőn ragadjon.
async function resync(message) {
  try {
    render(await request('/api/game'));
  } catch {
    return; // ha ez is nem megy, a helyi üzenet marad
  }
  setFeedback(message, 'bad');
}

async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
  return blob || file;
}

function hideBroken(root) {
  root.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.remove()));
}

// ===== Képernyő ébren tartása (a telefon ne aludjon el a feladat közben) =====
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // pl. http-n vagy energiatakarékos módban nem engedélyezett: a játék ettől még megy
  }
}

function releaseAwake() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ===== Merülés-animáció két állomás között =====
function playDive(from, to) {
  const lite = isLite();
  const el = document.createElement('div');
  el.className = `dive${lite ? ' dive-lite' : ''}`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="dive-streaks"></div>
    <div class="dive-inner">
      <p class="dive-label">Merülés</p>
      <p class="dive-depth">${from}<span class="unit">m</span></p>
    </div>`;
  document.body.appendChild(el);
  const out = el.querySelector('.dive-depth');
  const duration = lite ? 450 : 1300;
  if (ocean) ocean.dive(duration + 400);
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    out.firstChild.nodeValue = String(Math.round(from + (to - from) * eased));
    if (p < 1) {
      requestAnimationFrame(step);
    } else {
      el.classList.add('dive-out');
      setTimeout(() => el.remove(), 500);
    }
  };
  requestAnimationFrame(step);
}

// ===== Nyitóképernyő =====
function playIntro() {
  setDepth(0);
  let timer;
  const finish = () => {
    clearTimeout(timer);
    if (!splash.isConnected) return;
    splash.classList.add('fade-out');
    setTimeout(() => {
      splash.remove();
      showStart();
    }, 1800);
  };
  timer = setTimeout(finish, 13000);
  splash.addEventListener('click', finish, { once: true });
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollOnce, isLite() ? 10000 : 4000);
}

function stopHintTimer() {
  if (hintTimer) clearInterval(hintTimer);
  hintTimer = null;
}

const hintSignature = (h) => (h ? `${h.used}|${h.available}` : 'none');

// Csak akkor rajzolunk újra, ha a feladat változott: a félig beírt válasz nem vész el.
async function pollOnce() {
  if (document.hidden || busy || !currentKey) return;
  let state;
  try {
    state = await request('/api/game');
  } catch {
    return; // hálózati hiba: a következő körben újra próbáljuk
  }
  if (busy) return;
  if (!state.started || state.finished || state.stage?.key !== currentKey || state.game?.ended) {
    render(state);
    return;
  }
  const info = document.querySelector('.teaminfo');
  if (info) info.innerHTML = teamLine(state.team);
  // Ha egy csapattárs kérte a segítséget, itt is megjelenik
  if (hintSignature(state.stage.hint) !== hintSig) renderHint(state.stage.hint);
}

function teamLine(t) {
  return `<span class="team-name">${esc(t.name)}</span><span class="team-code">kód <strong>${esc(t.code)}</strong></span><span class="team-size">${t.members}/${t.maxMembers} fő</span>`;
}

function showStart(message, kind) {
  hideVerdict();
  stopPolling();
  stopHintTimer();
  stopLiveBoard();
  releaseAwake();
  busy = false;
  currentKey = null;
  lastDepth = 0;
  setDepth(0);
  app.innerHTML = `
    <h1>Atlantisz elveszett városa</h1>
    <div class="ornament" aria-hidden="true"></div>
    <p class="lead">Kilenc állomás vezet a felszíntől 200 méter mélyre. Minden megoldott feladat után lejjebb merültök, a végén pedig a kapu Atlantiszba nyílik.</p>
    <section class="card">
      <h2 class="subhead">Új csapat</h2>
      <form class="answer" id="createForm">
        <input name="name" maxlength="40" placeholder="Csapatnév" required autocomplete="off" aria-label="Csapatnév">
        <button class="btn" type="submit">Csapat létrehozása</button>
      </form>

      <h2 class="subhead">Csatlakozás egy csapathoz</h2>
      <form class="answer" id="joinForm">
        <input name="code" maxlength="5" placeholder="Csapatkód, 5 karakter" required autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Csapatkód">
        <button class="btn ghost" type="submit">Csatlakozás</button>
      </form>
      <p class="hint">Egy csapatban legfeljebb 5-en lehettek. A menetidő a csapat létrehozásakor indul, a csapatnév pedig a kivetített ranglistán is megjelenik.${
        game.endsAt ? ` A játék ${esc(game.endClock)}-ig tart.` : ''
      }</p>
      <p class="feedback" id="feedback" role="status" aria-live="polite"></p>
    </section>`;
  if (game.ended) {
    app.querySelector('.card').innerHTML = `
      <h2 class="subhead">A játék véget ért</h2>
      <p>A kapuk ${esc(game.endClock)}-kor bezárultak, új csapat már nem indulhat.</p>
      ${game.note ? `<p class="note">${esc(game.note)}</p>` : ''}`;
    if (message) setFeedback(message, kind);
    return;
  }

  const createForm = document.getElementById('createForm');
  const joinForm = document.getElementById('joinForm');
  const codeInput = joinForm.querySelector('input[name="code"]');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
  });

  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = new FormData(createForm).get('name');
    act(async () => {
      render(await request('/api/team/create', { method: 'POST', body: { name } }));
      return false;
    });
  });

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value;
    act(async () => {
      render(await request('/api/team/join', { method: 'POST', body: { code } }));
      return false;
    });
  });

  if (message) setFeedback(message, kind);
}

async function quitTeam() {
  if (!window.confirm('Biztosan kilépsz a csapatból?')) return;
  try {
    await request('/api/team/leave', { method: 'POST', body: {} });
  } catch {
    /* a kilépés a helyi oldalon akkor is megtörténik */
  }
  showStart();
}

// Fél órával a vége előtt figyelmeztetünk, mennyi idő van még hátra
function closingNote() {
  if (!game.endsAt || game.ended) return '';
  const left = Math.ceil((game.endsAt - Date.now()) / 60000);
  if (left > 30) return '';
  return `<p class="closing">Még ${left} perc a játék végéig (${esc(game.endClock)}).</p>`;
}

// Lejárt a játékidő, mielőtt a csapat célba ért
function renderEnded(state) {
  stopPolling();
  releaseAwake();
  app.innerHTML = `
    <div class="teambar">
      <span class="teaminfo">${teamLine(state.team)}</span>
      <button class="btn text" type="button" id="leave">Kilépés</button>
    </div>
    <section class="finale ended">
      <h1 class="finale-title">A kapu bezárult</h1>
      <div class="ornament short" aria-hidden="true"></div>
      <p class="lead">A játék ${esc(game.endClock)}-kor véget ért. ${esc(state.team.name)}, ti ${state.depth} méter mélyre jutottatok, ${state.progress.done} állomást teljesítve.</p>
      ${game.note ? `<p class="note">${esc(game.note)}</p>` : ''}
    </section>`;
  document.getElementById('leave').addEventListener('click', quitTeam);
}

// ===== Állomások megjelenítése =====
function render(state) {
  hideVerdict();
  busy = false;
  chosenPhoto = null;
  currentKey = null;
  stopHintTimer();
  stopLiveBoard();
  if (!state.started) return showStart();

  if (lastDepth !== null && state.depth > lastDepth) playDive(lastDepth, state.depth);
  lastDepth = state.depth;

  setDepth(state.depth);
  if (state.finished) return renderFinal(state);
  if (game.ended) return renderEnded(state);

  const s = state.stage;
  currentKey = s.key;

  app.innerHTML = `
    <div class="teambar">
      <span class="teaminfo">${teamLine(state.team)}</span>
      <button class="btn text" type="button" id="leave">Kilépés</button>
    </div>
    <header class="station-head">
      <div class="reading">
        <span class="reading-depth" aria-label="${s.depth} méter mélyen">${s.depth}<span class="unit">m</span></span>
        <span class="reading-step">${state.progress.done + 1}. állomás a ${state.progress.total}-ből</span>
      </div>
      <div class="ornament" aria-hidden="true"></div>
      <h1>${esc(s.title)}</h1>
      <p class="intro">${esc(s.intro)}</p>
      ${closingNote()}
    </header>
    ${s.instructions ? `<p class="instructions">${esc(s.instructions)}</p>` : ''}
    <section class="card" id="task"></section>
    <div class="hintbox" id="hintbox" hidden></div>
    <p class="feedback" id="feedback" role="status" aria-live="polite"></p>`;

  document.getElementById('leave').addEventListener('click', quitTeam);
  renderTask(s);
  renderHint(s.hint);
  hideBroken(app);
  startPolling();
  keepAwake();
}

function renderTask(s) {
  const box = document.getElementById('task');
  switch (s.type) {
    case 'choice': return renderChoice(box, s);
    case 'text':
    case 'gate':   return renderText(box, s);
    case 'letters': return renderLetters(box, s);
    case 'riddles': return renderRiddle(box, s);
    case 'upload':  return renderUpload(box, s);
    case 'shark':   return renderShark(box, s);
    default:
      box.innerHTML = '<p>Ez a feladat jelenleg nem elérhető.</p>';
  }
}

// ===== Segítség (tipp) =====
function renderHint(h) {
  stopHintTimer();
  hintSig = hintSignature(h);
  const box = document.getElementById('hintbox');
  if (!box) return;
  if (!h) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (h.used) {
    box.innerHTML = `<p class="hint-text"><strong>Segítség:</strong> ${esc(h.text)}</p>`;
    return;
  }
  const penalty = `+${h.penaltyMinutes} perc`;
  if (h.available) {
    box.innerHTML = `<button class="btn ghost small" type="button" id="hintBtn">Segítség kérése (${penalty})</button>`;
    document.getElementById('hintBtn').addEventListener('click', () => askHint(h));
    return;
  }
  const readyAt = Date.now() + h.availableInMs;
  const tick = () => {
    const left = readyAt - Date.now();
    if (left <= 0) {
      renderHint({ ...h, available: true, availableInMs: 0 });
      return;
    }
    box.innerHTML = `<p class="hint-wait">Segítség ${formatClock(left)} múlva vagy ${h.afterWrong} rossz válasz után kérhető, ${penalty} büntetéssel.</p>`;
  };
  tick();
  hintTimer = setInterval(tick, 1000);
}

function askHint(h) {
  if (!window.confirm(`A segítség ${h.penaltyMinutes} perc büntetéssel jár, ami hozzáadódik a menetidőtökhöz. Kéritek?`)) return;
  act(async () => {
    const data = await request('/api/game/hint', { method: 'POST', body: { expectKey: currentKey } });
    if (data.stale) {
      render(data.state);
      setFeedback(data.message, 'bad');
      return true;
    }
    renderHint(data.state.stage.hint);
    return false;
  });
}

// ===== Válaszok =====
function answerForm(placeholder, label) {
  return `
    <form class="answer">
      <input name="value" autocomplete="off" maxlength="100" placeholder="${esc(placeholder)}" required>
      <button class="btn" type="submit">${esc(label)}</button>
    </form>`;
}

function bindAnswer(box) {
  const form = box.querySelector('form.answer');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendAnswer(new FormData(form).get('value'));
  });
}

function sendAnswer(value) {
  return act(async () => {
    const data = await request('/api/game/answer', {
      method: 'POST',
      body: { value: String(value ?? ''), expectKey: currentKey },
    });
    return handleResult(data);
  });
}

// Sikernél rövid visszajelzés, majd a szerver szerinti következő állapot. true: a zár marad.
function handleResult(data) {
  if (data.stale) {
    // A csapat közben már továbbjutott: a friss állapotot mutatjuk, a választ nem számoljuk
    render(data.state);
    setFeedback(data.message, 'bad');
    return true;
  }
  setFeedback(data.message, data.correct ? 'ok' : 'bad');
  if (data.correct) {
    setTimeout(() => render(data.state), 2200);
    return true;
  }
  // Rossz válasz után a segítség elérhetővé válhat
  if (data.state?.stage) renderHint(data.state.stage.hint);
  return false;
}

// A válaszlehetőségek jelölése görög kisbetűkkel (alfa, béta, gamma, delta…)
const GREEK_KEYS = ['α', 'β', 'γ', 'δ', 'ε', 'ζ'];

function renderChoice(box, s) {
  box.innerHTML = `
    ${s.image ? `<img class="hero" src="${esc(s.image)}" alt="${esc(s.imageAlt || '')}" loading="lazy" decoding="async">` : ''}
    <p class="question">${esc(s.question)}</p>
    <div class="options">
      ${s.options
        .map((o, i) => `<button type="button" class="option" data-value="${esc(o)}"><span class="option-key" aria-hidden="true">${GREEK_KEYS.at(i) ?? ''}</span><span>${esc(o)}</span></button>`)
        .join('')}
    </div>`;
  box.querySelectorAll('.option').forEach((btn) =>
    btn.addEventListener('click', () => sendAnswer(btn.dataset.value))
  );
}

function renderText(box, s) {
  box.innerHTML = `
    ${s.image ? `<img class="hero" src="${esc(s.image)}" alt="${esc(s.imageAlt || '')}" loading="lazy" decoding="async">` : ''}
    <p class="question">${esc(s.question)}</p>
    ${answerForm('Írd ide a választ', 'Ellenőrzés')}`;
  bindAnswer(box);
}

function renderLetters(box, s) {
  const marked = new Set(s.marked);
  const html = [...s.text].map((ch, i) => (marked.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
  box.innerHTML = `
    <p class="question">${esc(s.question)}</p>
    <blockquote class="scroll${s.text.length > 200 ? ' long' : ''}" lang="hu">${html}</blockquote>
    ${answerForm('A kiemelt betűkből kirakott szó', 'Ellenőrzés')}`;
  bindAnswer(box);
}

function renderRiddle(box, s) {
  box.innerHTML = `
    <p class="counter">Rejtvény ${s.riddleNo} / ${s.riddleTotal}</p>
    <p class="riddle">${esc(s.riddle)}</p>
    ${answerForm('Válasz', 'Ellenőrzés')}`;
  bindAnswer(box);
}

// ===== Fotó-feltöltés (hozzájárulással) =====
function renderUpload(box, s) {
  const refs = s.references?.length
    ? `<div class="refs">${s.references
        .map(
          (r) => `<figure><img src="${esc(r.src)}" alt="${esc(r.name || 'Görög szobor')}" loading="lazy" decoding="async">${
            r.name ? `<figcaption>${esc(r.name)}</figcaption>` : ''
          }</figure>`
        )
        .join('')}</div>`
    : '';
  box.innerHTML = `
    ${refs}
    <form class="upload" novalidate>
      <label class="picker">
        <input class="visually-hidden" type="file" name="photo" accept="image/*" required>
        <span class="picker-btn" id="pickerLabel">Fotó készítése vagy kiválasztása</span>
        <span class="picker-note">Feltöltés előtt a telefon kicsinyíti a képet, így gyenge neten is gyorsan átmegy.</span>
      </label>
      <img id="preview" class="hero" alt="" hidden>
      <label class="check">
        <input type="checkbox" id="consent" name="consent" value="yes">
        <span>A fotón szereplő minden csapattag hozzájárult a fotó elkészítéséhez és feltöltéséhez, és elolvastuk az
          <a href="/adatvedelem" target="_blank" rel="noopener">adatkezelési tájékoztatót</a>.
          A fotót csak a szervezők és a csapatunk látja, és ${esc(s.retentionDays)} nap után automatikusan törlődik.</span>
      </label>
      <label class="check">
        <input type="checkbox" id="publish" name="publish" value="yes">
        <span><em>Nem kötelező.</em> Hozzájárulunk, hogy a szervezők a fotót a rendezvény beszámolójában vagy közösségi oldalán közzétegyék.</span>
      </label>
      <button class="btn" type="submit">Fotó feltöltése</button>
    </form>`;

  const form = box.querySelector('form.upload');
  const input = form.querySelector('input[type="file"]');
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    chosenPhoto = null;
    setFeedback('Kép előkészítése…');
    try {
      chosenPhoto = await shrinkImage(file);
      const preview = document.getElementById('preview');
      preview.src = URL.createObjectURL(chosenPhoto);
      preview.hidden = false;
      document.getElementById('pickerLabel').textContent = 'Másik fotó választása';
      setFeedback('');
    } catch {
      setFeedback('Nem sikerült megnyitni a képet. Próbálj másikat!', 'bad');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chosenPhoto) {
      setFeedback('Válassz képet, vagy várj, amíg az előkészítés kész lesz!', 'bad');
      return;
    }
    if (!document.getElementById('consent').checked) {
      setFeedback('A feltöltéshez jelöld be, hogy a fotón szereplők hozzájárultak.', 'bad');
      return;
    }
    const publish = document.getElementById('publish').checked;
    act(async () => {
      setFeedback('Feltöltés…');
      const fd = new FormData();
      fd.append('photo', chosenPhoto, 'poza.jpg');
      fd.append('expectKey', currentKey ?? '');
      fd.append('consent', 'yes');
      if (publish) fd.append('publish', 'yes');
      return handleResult(await request('/api/game/upload', { method: 'POST', body: fd }));
    });
  });
}

// ===== Cápa-kör =====
// Oldalnézeti cápa-sziluett, orral jobbra; a kör érintője mentén forgatjuk, így mindig úszási irányba néz
const SHARK_SVG =
  '<svg viewBox="0 0 64 28" focusable="false"><path fill="currentColor" d="M62 14C56 9 44 8 36 8L30 0 28 8.5C22 9.5 16 11 12 13L3 3 6 14 3 24 12 16C18 19 28 21 38 20L40 25 44 19.5C52 19 58 17 62 14Z"/><circle cx="54" cy="12.5" r="1.1" fill="#0b1e33"/></svg>';

// A zöld sávot a szerver sorsolja minden indításkor. A mozgás a telefonon fut, az időt a telefon méri.
// Színtévesztők miatt a cél-sáv nemcsak zöld, hanem világos és csíkos is; belépéskor a telefon rezeg.
function renderShark(box, s) {
  const cfg = s.shark;
  const len = 2 * Math.PI * 100;

  box.innerHTML = `
    <div class="shark-ring" id="sharkRing">
      <svg viewBox="0 0 260 260" aria-hidden="true">
        <circle cx="130" cy="130" r="72" class="ring-hub"></circle>
        <circle cx="130" cy="130" r="80" class="ring-dial" pathLength="360" stroke-dasharray="0.6 4.4" transform="rotate(-90.3 130 130)"></circle>
        <circle cx="130" cy="130" r="80" class="ring-dial major" pathLength="360" stroke-dasharray="1 44" transform="rotate(-90.5 130 130)"></circle>
        <circle cx="130" cy="130" r="100" class="ring-red"></circle>
        <circle cx="130" cy="130" r="100" class="ring-green" id="greenArc" visibility="hidden"></circle>
        <circle cx="130" cy="130" r="100" class="ring-ticks" id="greenTicks" visibility="hidden"></circle>
      </svg>
      <span class="shark" id="shark" aria-hidden="true">${SHARK_SVG}</span>
    </div>
    <p class="shark-legend">
      <span><span class="key key-green" aria-hidden="true"></span>cél: csíkos zöld sáv</span>
      <span><span class="key key-red" aria-hidden="true"></span>piros víz</span>
    </p>
    <div class="actions">
      <button class="btn" type="button" id="startShark">Kör indítása</button>
      <button class="btn danger" type="button" id="pressShark" disabled>Üss!</button>
    </div>`;

  const ring = document.getElementById('sharkRing');
  const arc = document.getElementById('greenArc');
  const ticks = document.getElementById('greenTicks');
  const shark = document.getElementById('shark');
  const startBtn = document.getElementById('startShark');
  const pressBtn = document.getElementById('pressShark');

  // Kezdő helyzet: a kör tetején ((130 - 100) / 260 = 11,54%)
  shark.style.left = '50%';
  shark.style.top = '11.54%';
  shark.style.transform = 'translate(-50%, -50%)';

  let frameId = null;
  let t0 = 0;
  let radius = 0;
  let zone = null;
  let wasIn = false;

  const showZone = (start, width) => {
    const arcLen = (len * width) / 360;
    arc.style.strokeDasharray = `${arcLen} ${len}`;
    // Csíkminta a cél-ív hosszán (6 vonal, 6 rés), utána rés a kör végéig
    const parts = [];
    let used = 0;
    while (used + 12 <= arcLen) {
      parts.push(6, 6);
      used += 12;
    }
    parts.push(0, len - used);
    ticks.style.strokeDasharray = parts.join(' ');
    for (const el of [arc, ticks]) {
      el.style.transformOrigin = '130px 130px';
      el.style.transform = `rotate(${start - 90}deg)`;
      el.setAttribute('visibility', 'visible');
    }
  };

  const hideZone = () => {
    arc.setAttribute('visibility', 'hidden');
    ticks.setAttribute('visibility', 'hidden');
    ring.classList.remove('in-zone');
    wasIn = false;
  };

  const place = () => {
    // Ha a játékos közben másik állomásra került, a ciklus magától leáll (nincs szivárgó animáció)
    if (!shark.isConnected) return;
    const angle = (((performance.now() - t0) / 1000) * cfg.speed) % 360;
    const rad = (angle * Math.PI) / 180;
    const x = radius * Math.sin(rad);
    const y = -radius * Math.cos(rad);
    // a kör bal felén (balra úszik) tükrözzük, hogy a hátuszony mindig fölfelé álljon
    const flip = angle > 90 && angle < 270 ? -1 : 1;
    shark.style.transform = `translate(-50%, -50%) translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${angle.toFixed(1)}deg) scale(1, ${flip})`;
    if (zone) {
      const inZone = angle >= zone.start && angle <= zone.start + zone.width;
      if (inZone && !wasIn) {
        ring.classList.add('in-zone');
        if (navigator.vibrate) navigator.vibrate(35);
      } else if (!inZone && wasIn) {
        ring.classList.remove('in-zone');
      }
      wasIn = inZone;
    }
    frameId = requestAnimationFrame(place);
  };

  const stop = () => {
    cancelAnimationFrame(frameId);
    frameId = null;
  };

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    hideZone();
    setFeedback('A cápa elindul…');
    try {
      const data = await request('/api/game/shark/start', { method: 'POST', body: {} });
      zone = { start: data.shark.greenStart, width: data.shark.greenWidth };
      showZone(zone.start, zone.width);
      radius = ring.clientWidth * (100 / 260);
      shark.style.top = '50%';
      t0 = performance.now();
      stop();
      frameId = requestAnimationFrame(place);
      pressBtn.disabled = false;
      setFeedback('Figyeld a cápát!');
    } catch (err) {
      startBtn.disabled = false;
      setFeedback(err.message, 'bad');
    }
  });

  pressBtn.addEventListener('click', () => {
    if (pressBtn.disabled) return;
    pressBtn.disabled = true;
    const elapsedMs = Math.round(performance.now() - t0);
    stop();
    request('/api/game/shark/press', { method: 'POST', body: { elapsedMs, expectKey: currentKey } })
      .then((data) => {
        if (data.stale) {
          render(data.state);
          setFeedback(data.message, 'bad');
          return;
        }
        setFeedback(data.message, data.correct ? 'ok' : 'bad');
        if (data.correct) {
          setTimeout(() => render(data.state), 2200);
        } else {
          hideZone();
          zone = null;
          startBtn.disabled = false;
          if (data.state?.stage) renderHint(data.state.stage.hint);
        }
      })
      .catch((err) => {
        setFeedback(err.message, 'bad');
        hideZone();
        startBtn.disabled = false;
      });
  });
}

// ===== Záróképernyő =====
// Görög templom homlokzata finom arany vonalakkal: oromzat, gerendázat, hat hornyolt oszlop, lépcsők
const TEMPLE_SVG = (() => {
  const cols = [0, 1, 2, 3, 4, 5]
    .map((i) => {
      const x = 38 + i * 29;
      return `<g><rect x="${x}" y="58" width="14" height="58" rx="1"/><path d="M${x + 4.5} 61v52M${x + 9.5} 61v52" opacity=".55"/><path d="M${x - 2} 58h18M${x - 2} 116h18"/></g>`;
    })
    .join('');
  return `<svg class="temple" viewBox="0 0 240 140" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">
    <path d="M24 44L120 8l96 36z"/><path d="M44 39l76-26 76 26" opacity=".5"/><circle cx="120" cy="30" r="5" opacity=".7"/>
    <rect x="22" y="44" width="196" height="9"/><path d="M28 53h184" opacity=".6"/>${cols}
    <path d="M26 118h188M18 124h204M10 130h220"/></svg>`;
})();
function renderFinal(state) {
  stopPolling();
  stopHintTimer();
  releaseAwake();
  setDepth(state.depth);
  const r = state.result || {};
  const photos = r.photos || [];
  app.innerHTML = `
    <section class="finale">
      ${TEMPLE_SVG}
      <h1 class="finale-title">Atlantisz</h1>
      <div class="ornament short" aria-hidden="true"></div>
      <p class="lead">${esc(state.team.name)}, megérkeztetek. Az elsüllyedt város kapui feltárultak, aranyló oszlopok és ősi jelek vezetnek a főtér felé.</p>
      <div class="result">
        <div class="result-item"><span class="result-value">${formatDuration(r.totalMs || 0)}</span><span class="result-label">menetidő</span></div>
        <div class="result-item"><span class="result-value" id="myRank">${r.rank ? `${r.rank}.` : '–'}</span><span class="result-label" id="myRankLabel">helyezés, ${r.finishedTeams || 0} célba ért csapatból</span></div>
        <div class="result-item"><span class="result-value">${r.hintsUsed || 0}</span><span class="result-label">felhasznált segítség</span></div>
      </div>
      ${r.penaltyMs ? `<p class="hint">A menetidő ${formatDuration(r.penaltyMs)} segítség-büntetést tartalmaz.</p>` : ''}
      ${game.note ? `<p class="note">${esc(game.note)}</p>` : ''}
      <h2 class="subhead">Élő ranglista</h2>
      <ol class="live-board" id="liveBoard" aria-live="polite"></ol>
      <p class="hint" id="liveUpdated">Betöltés…</p>
      ${
        photos.length
          ? `<h2 class="subhead">A ti szobraitok</h2>
        <div class="photo-grid">
          ${photos.map((f) => `<img src="/api/game/photos/${encodeURIComponent(f)}" alt="A csapat pózfotója" loading="lazy" decoding="async">`).join('')}
        </div>
        <p class="hint">Ezeket a fotókat csak a csapatotok és a szervezők látják, és ${esc(r.retentionDays)} nap után automatikusan törlődnek.</p>`
          : ''
      }
      <button class="btn ghost" id="restart" type="button">Kilépés és új játék</button>
    </section>`;
  hideBroken(app);
  document.getElementById('restart').addEventListener('click', quitTeam);
  refreshLiveBoard();
}

// ===== Élő ranglista a célba ért csapat telefonján =====
function stopLiveBoard() {
  if (boardTimer) clearTimeout(boardTimer);
  boardTimer = null;
}

async function refreshLiveBoard() {
  stopLiveBoard();
  if (!document.getElementById('liveBoard')) return;
  if (!document.hidden) {
    try {
      renderLiveBoard(await request('/api/game/leaderboard'));
    } catch (err) {
      if (err.status === 401) {
        await resync(err.message); // pl. a szervező törölte a csapatot
        return;
      }
      const updated = document.getElementById('liveUpdated');
      if (updated) updated.textContent = 'Nincs kapcsolat a szerverrel, újrapróbálom…';
    }
  }
  if (document.getElementById('liveBoard')) boardTimer = setTimeout(refreshLiveBoard, isLite() ? 10000 : 5000);
}

function renderLiveBoard(d) {
  const list = document.getElementById('liveBoard');
  if (!list) return;
  const me = d.teams.find((t) => t.isMe);
  let rows = d.teams.slice(0, LIVE_BOARD_LIMIT);
  // Ha a saját csapat lecsúszna a lista aljáról, akkor is látszódjon
  if (me && !rows.includes(me)) rows = [...rows, me];
  list.innerHTML = rows
    .map(
      (t) => `<li class="${t.isMe ? 'me' : ''}${t.finished ? ' done' : ''}">
        <span class="lb-pos">${t.finished ? `${t.rank}.` : '…'}</span>
        <span class="lb-name">${esc(t.name)}${t.isMe ? ' <em>(ti)</em>' : ''}</span>
        <span class="lb-val">${t.finished ? formatDuration(t.totalMs) : `${esc(t.depth)} m`}</span>
      </li>`
    )
    .join('');
  const finishedCount = d.teams.filter((t) => t.finished).length;
  if (me && me.rank) {
    const rank = document.getElementById('myRank');
    const label = document.getElementById('myRankLabel');
    if (rank) rank.textContent = `${me.rank}.`;
    if (label) label.textContent = `helyezés, ${finishedCount} célba ért csapatból`;
  }
  const rest = d.teams.length - rows.length;
  const updated = document.getElementById('liveUpdated');
  if (updated) {
    updated.textContent = `Élőben frissül, utoljára ${new Date().toLocaleTimeString('hu-HU')}.${rest > 0 ? ` További ${rest} csapat még úton van.` : ''}`;
  }
}

// Visszatéréskor (pl. a telefon zárolásából) azonnal frissítünk, és újra kérjük az ébren tartást
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  pollOnce();
  if (currentKey) keepAwake();
  if (document.getElementById('liveBoard')) refreshLiveBoard();
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* http-n (nem biztonságos kapcsolat) nem érhető el; a játék ettől még működik */
  });
}

// ===== Indulás =====
detectLite();
if (!isLite()) ocean = startOcean({ depth: 0 });
registerServiceWorker();

(async function boot() {
  try {
    const state = await request('/api/game');
    if (state.started) {
      splash.remove();
      render(state);
    } else {
      playIntro();
    }
  } catch (err) {
    splash.remove();
    showStart(`${err.message} Frissítsd az oldalt, ha újra próbálnád.`, 'bad');
  }
})();

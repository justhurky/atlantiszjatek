'use strict';

// Szerveroldalon előállított oldalak: a QR-kapu és az adatkezelési tájékoztató.
// Minden beillesztett érték escape-elve van (a csapatnév és a környezeti változók is).

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STYLE = `
  :root{--ink:#f4efe0;--soft:rgba(244,239,224,.7);--faint:rgba(244,239,224,.45);--gold:#d6a84a;--gold-light:#f8e7a5;
        --line:rgba(244,239,224,.14);--line-gold:rgba(214,168,74,.32)}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;min-height:100dvh;color:var(--ink);font-family:'Alegreya Sans','Segoe UI',system-ui,sans-serif;
       font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased;
       background:linear-gradient(180deg,#0a2a4a 0%,#031428 55%,#010a16 100%) fixed}
  main{max-width:720px;margin:0 auto;padding:40px 20px 64px}
  h1,h2{font-family:'Cinzel','Times New Roman',serif;font-weight:500;color:var(--gold-light);line-height:1.25}
  h1{font-size:clamp(1.6rem,5vw,2.2rem);margin:0 0 8px}
  h2{font-size:1.15rem;margin:36px 0 12px;padding-top:16px;border-top:1px solid var(--line-gold)}
  a{color:var(--gold-light);text-underline-offset:3px}
  p,li{color:var(--ink)}
  ul{padding-left:1.2em}
  li{margin-bottom:6px}
  .soft{color:var(--soft)}
  .card{background:rgba(3,17,33,.82);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
  .card p{margin:6px 0}
  .center{min-height:100vh;min-height:100dvh;display:grid;place-items:center;text-align:center}
  .center h1{margin-bottom:12px}
  .code{display:inline-block;font-family:'Cinzel','Times New Roman',serif;font-size:2rem;letter-spacing:.18em;color:var(--gold-light);
        border:1px solid var(--gold);padding:10px 22px;border-radius:10px;margin:8px 0}
  .btn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;margin-top:18px;padding:12px 24px;
       border-radius:10px;font-weight:700;color:#101820;background:var(--gold);text-decoration:none}
  .btn:hover{background:var(--gold-light)}
  .todo{background:rgba(255,210,122,.14);color:#ffd27a;border:1px dashed #ffd27a;border-radius:6px;padding:0 6px}
  .table{width:100%;border-collapse:collapse;font-size:16px}
  .table th,.table td{text-align:left;vertical-align:top;padding:10px 8px;border-bottom:1px solid var(--line)}
  .table th{font-weight:700;color:var(--soft)}
  @media (max-width:640px){
    .table thead{display:none}
    .table tr{display:block;border-bottom:1px solid var(--line);padding:8px 0}
    .table td{display:block;border:0;padding:3px 0}
    .table td::before{content:attr(data-label) ": ";font-weight:700;color:var(--soft)}
  }
`;

function layout(title, body, { center = false } = {}) {
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts/fonts.css">
<style>${STYLE}</style></head>
<body><main${center ? ' class="center"' : ''}>${body}</main></body></html>`;
}

// ---------- QR-kapu ----------

function gatePage(kind, data = {}) {
  const back = '<a class="btn" href="/">Vissza a játékhoz</a>';
  const bodies = {
    closed: '<h1>Zárt kapu</h1><p>Ez a kód nem a valódi kapuhoz tartozik.</p>',
    opened: `<h1>A kapu kinyílt!</h1><p>${esc(data.name)}, Atlantisz kapuja feltárult előttetek. Térjetek vissza a játékba!</p>${back}`,
    early: `<h1>A kapu még zárva</h1><p>${esc(data.name)}, ide még korán értetek: előbb oldjátok meg a többi feladatot.</p>${back}`,
    finished: `<h1>Már Atlantiszban vagytok!</h1><p>${esc(data.name)}, ti már átjutottatok a kapun.</p>${back}`,
    ended: `<h1>A kapu bezárult</h1><p>${esc(data.message)}</p>${back}`,
    code: `<h1>Atlantisz kapuja</h1>
      <p>Ha nem ebben a böngészőben játszotok, írjátok be ezt a kódot a játékba:</p>
      <p class="code">${esc(data.code)}</p>
      <p class="soft">A kód csak a ti csapatotoké: egyszer használható, és ${esc(data.minutes)} percig érvényes. Ha lejárt, olvassátok be újra a QR-kódot.</p>
      <p class="soft">Tipp: ha a játékot futtató böngészővel olvassátok be a QR-kódot, a kapu magától kinyílik.</p>`,
  };
  return layout('Atlantisz kapuja', `<div>${bodies[kind] || bodies.closed}</div>`, { center: true });
}

// ---------- nem található ----------

// Egyszerű „nincs ilyen oldal" válasz (az admin cím is ezt adja annak, aki nem szervező)
function notFoundPage() {
  return layout('Nincs ilyen oldal', `<div><h1>Nincs ilyen oldal</h1>
    <p>Ez az oldal nem található.</p><a class="btn" href="/">Vissza a játékhoz</a></div>`, { center: true });
}

// ---------- nyomtatható A4-es plakát a QR-kóddal (belépés a játékba / Atlantisz kapuja) ----------

const MEANDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='14'%3E%3Cpath d='M0 13.5H18M0 0.5H18M15.5 13.5V3.5H3.5V10.5H11.5V6.5H7.5' fill='none' stroke='%23d6a84a' stroke-width='1'/%3E%3C/svg%3E";

const POSTERS = {
  jatek: {
    title: 'Atlantisz elveszett városa',
    kicker: 'Merülj velünk a mélybe',
    lead: 'A küldetésre hívunk, bátor kalandor, hogy megtaláld Atlantisz elveszett városát!',
    steps: [
      'Olvasd be a QR-kódot a telefonod kamerájával.',
      'Hozzatok létre csapatot, vagy csatlakozzatok egy csapatkóddal (legfeljebb 5 fő).',
      'Oldjátok meg a feladatokat, és merüljetek 200 méter mélyre!',
    ],
    file: 'atlantisz-plakat-jatek',
  },
  kapu: {
    title: 'Atlantisz kapuja',
    kicker: 'Az utolsó állomás',
    lead: 'Megtaláltátok a kaput. Olvassátok be, és a kapu feltárul előttetek.',
    steps: [
      'Ugyanazzal a böngészővel olvassátok be, amelyikben játszotok.',
      'Ha a kamera másik böngészőt nyit meg, írjátok be a játékba a megjelenő kódot.',
    ],
    file: 'atlantisz-plakat-kapu',
  },
};

function posterPage({ kind, url, svg, dark, showUrl, cards = false }) {
  const p = POSTERS[kind];
  const href = (k, d, c) => `/admin/plakat?mi=${k}&amp;tema=${d ? 'sotet' : 'vilagos'}${c ? '&amp;meret=kartya' : ''}`;
  const logos = '<div class="logos"><img src="/assets/logo/esk.png" alt="ESK Hallgatói Önkormányzat"><img src="/assets/logo/ivk.png" alt="IVK Hallgatói Önkormányzat"></div>';
  // tenyérnyi kártya (A6): négy fér egy A4-es lapra, a szaggatott vonal mentén kell szétvágni
  const card = `<article class="card">
    <p class="kicker">${esc(p.kicker)}</p>
    <h2>${esc(p.title)}</h2>
    <div class="meander" aria-hidden="true"></div>
    <div class="qr">${svg}</div>
    <p class="cta">${kind === 'jatek' ? 'Olvasd be, és indulhat a merülés!' : 'Olvassátok be a játék böngészőjével!'}</p>
    ${kind === 'jatek' ? `<p class="url">${esc(url)}</p>` : ''}
    ${logos}
  </article>`;
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${esc(p.file)}</title>
<link rel="stylesheet" href="/fonts/fonts.css">
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { background: #2a3440; font-family: 'Alegreya Sans', 'Segoe UI', sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center;
    padding: 12px 16px; background: #061a30; color: #f4efe0; font-size: 15px; }
  .bar a, .bar button { font: inherit; font-weight: 700; padding: 9px 14px; border-radius: 8px; text-decoration: none; cursor: pointer;
    color: #f8e7a5; border: 1px solid rgba(214,168,74,.6); background: transparent; }
  .bar button { color: #101820; background: #d6a84a; border-color: #d6a84a; }
  .bar .on { background: rgba(214,168,74,.18); }
  .bar .warn { flex-basis: 100%; text-align: center; color: #f2b8b5; }
  .sheet { --ink: #0a2a4a; --soft: #3d5670; --paper: #fffdf7; --line: rgba(214,168,74,.9);
    width: 210mm; height: 297mm; margin: 24px auto; padding: 18mm 18mm 15mm; overflow: hidden; position: relative;
    display: flex; flex-direction: column; align-items: center; text-align: center;
    color: var(--ink); background: var(--paper); box-shadow: 0 10px 40px rgba(0,0,0,.4); }
  .sheet.dark { --ink: #f8e7a5; --soft: rgba(244,239,224,.78); --paper: #031121;
    background: radial-gradient(ellipse at 50% 0%, #0f4a7a 0%, #062844 38%, #021428 72%, #010a16 100%); }
  .frame { position: absolute; inset: 8mm; border: 0.5mm solid var(--line); border-radius: 3mm; pointer-events: none; }
  .frame::after { content: ""; position: absolute; inset: 2mm; border: 0.25mm solid var(--line); border-radius: 2mm; opacity: .55; }
  .kicker { margin: 0; font-size: 13pt; letter-spacing: .22em; text-transform: uppercase; color: var(--soft); }
  h1 { margin: 4mm 0 0; font-family: 'Cinzel', serif; font-weight: 700; font-size: 34pt; line-height: 1.08; color: var(--ink); }
  .dark h1 { color: #f8e7a5; }
  .meander { width: 120mm; height: 14px; margin: 6mm auto; background: url("${MEANDER}") repeat-x center / 18px 14px; }
  .lead { margin: 0 8mm; font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 19pt; line-height: 1.3; color: var(--soft); }
  .qr { margin: 7mm 0 4mm; padding: 4mm; background: #fff; border-radius: 4mm; border: 0.6mm solid #d6a84a; }
  .qr svg { display: block; width: 96mm; height: 96mm; }
  .url { margin: 0; font-size: 13pt; font-weight: 500; color: var(--ink); word-break: break-all; }
  ol { margin: 6mm auto 0; padding: 0; max-width: 150mm; list-style: none; counter-reset: s; text-align: left; }
  li { counter-increment: s; position: relative; padding-left: 12mm; margin: 0 0 4mm; font-size: 14pt; line-height: 1.35; color: var(--ink); }
  .dark li { color: #f4efe0; }
  li::before { content: counter(s); position: absolute; left: 0; top: -0.5mm; width: 8mm; height: 8mm; border-radius: 50%;
    display: grid; place-items: center; font-family: 'Cinzel', serif; font-weight: 700; font-size: 12pt;
    color: #101820; background: #d6a84a; }
  .foot { margin-top: auto; font-size: 10pt; color: var(--soft); }
  .foot p { margin: 2mm 0 0; }
  .logos { display: inline-flex; justify-content: center; gap: 12mm; }
  .logos img { height: 19mm; width: auto; }
  .dark .logos { padding: 2.5mm 7mm; border-radius: 3mm; background: #fffdf7; }
  .sheet > * { flex-shrink: 0; }
  /* tenyérnyi kártyák: 2 × 2 darab A6 egy A4-es lapon */
  .sheet.cards { padding: 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .card { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 7mm 8mm;
    text-align: center; border: 0.2mm dashed rgba(127,127,127,.55); overflow: hidden; }
  .card::before { content: ""; position: absolute; inset: 4mm; border: 0.35mm solid var(--line); border-radius: 2.5mm; pointer-events: none; }
  .card .kicker { font-size: 7.5pt; letter-spacing: .2em; }
  .card h2 { margin: 1.5mm 0 0; font-family: 'Cinzel', serif; font-weight: 700; font-size: 17pt; line-height: 1.1; color: var(--ink); }
  .dark .card h2 { color: #f8e7a5; }
  .card .meander { width: 52mm; margin: 2.5mm auto 3mm; }
  .card .qr { margin: 0 0 2.5mm; padding: 2.5mm; border-radius: 2.5mm; border-width: 0.4mm; }
  .card .qr svg { width: 62mm; height: 62mm; }
  .card .cta { margin: 0; font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 13pt; color: var(--soft); }
  .card .url { margin: 1mm 0 0; font-size: 8.5pt; }
  .card .logos { margin-top: 3mm; gap: 6mm; }
  .card .logos img { height: 10mm; }
  .dark .card .logos { padding: 1.5mm 4mm; border-radius: 2mm; }
  @media print {
    body { background: none; }
    .bar { display: none; }
    .sheet { margin: 0; box-shadow: none; }
  }
  @media screen and (max-width: 860px) {
    .sheet { zoom: .45; }
  }
</style></head>
<body>
<div class="bar">
  <button type="button" id="print">Nyomtatás / mentés PDF-be</button>
  <a class="${kind === 'jatek' ? 'on' : ''}" href="${href('jatek', dark, cards)}">Belépés a játékba</a>
  <a class="${kind === 'kapu' ? 'on' : ''}" href="${href('kapu', dark, cards)}">Atlantisz kapuja</a>
  <a class="${cards ? '' : 'on'}" href="${href(kind, dark, false)}">A4-es plakát</a>
  <a class="${cards ? 'on' : ''}" href="${href(kind, dark, true)}">Tenyérnyi kártyák (4 db / A4)</a>
  <a class="${dark ? 'on' : ''}" href="${href(kind, true, cards)}">Sötét</a>
  <a class="${dark ? '' : 'on'}" href="${href(kind, false, cards)}">Világos (kevés tinta)</a>
  <a href="/admin#beallitasok">Vissza</a>
  ${showUrl ? '' : '<span class="warn">Figyelem: a QR-kód most a gépen belüli címre (localhost) mutat, telefonról nem fog működni. Állítsd be a BASE_URL-t, és indítsd újra a szervert nyomtatás előtt!</span>'}
</div>
${
  cards
    ? `<main class="sheet cards${dark ? ' dark' : ''}">${card.repeat(4)}</main>`
    : `<main class="sheet${dark ? ' dark' : ''}">
  <div class="frame" aria-hidden="true"></div>
  <p class="kicker">${esc(p.kicker)}</p>
  <h1>${esc(p.title)}</h1>
  <div class="meander" aria-hidden="true"></div>
  <p class="lead">${esc(p.lead)}</p>
  <div class="qr">${svg}</div>
  ${kind === 'jatek' ? `<p class="url">${esc(url)}</p>` : ''}
  <ol>${p.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  <footer class="foot">
    ${logos}
    <p>${kind === 'jatek' ? 'Az ESK és az IVK Hallgatói Önkormányzat játéka · Adatkezelési tájékoztató a játék oldalán.' : 'Atlantisz elveszett városa'}</p>
  </footer>
</main>`
}
<script src="/js/print.js"></script>
</body></html>`;
}

// ---------- adatkezelési tájékoztató ----------

// A szervező által megadandó adat: ha hiányzik, jól látható „kitöltendő" jelölést kap
function field(value, placeholder) {
  return value ? esc(value) : `<span class="todo">[kitöltendő: ${esc(placeholder)}]</span>`;
}

function privacyPage(config) {
  const days = config.PHOTO_RETENTION_DAYS;
  const daysText = Number.isInteger(days) ? `${days} nap` : `${days} nap`;
  const contact = field(config.PRIVACY_CONTACT, 'e-mail-cím vagy postacím');

  const rows = [
    [
      'Csapatnév (ti adjátok meg)',
      'A játék működése; a csapatnév a kivetített ranglistán is megjelenik.',
      'Jogos érdek (GDPR 6. cikk (1) bekezdés f) pont)',
      'A csapat utolsó aktivitásától számított legfeljebb 12 óra.',
    ],
    [
      'Munkamenet-süti (véletlenszerű azonosító)',
      'A telefon csapathoz rendelése. A süti a játék működéséhez feltétlenül szükséges, ezért nem kérünk hozzá külön hozzájárulást.',
      'Jogos érdek (GDPR 6. cikk (1) bekezdés f) pont)',
      'Legfeljebb 6 óra.',
    ],
    [
      'Játékállapot (haladás, a válaszok helyessége, felhasznált segítség, időpontok)',
      'A játék működése és a ranglista.',
      'Jogos érdek (GDPR 6. cikk (1) bekezdés f) pont)',
      'A csapattal együtt törlődik (legfeljebb 12 óra inaktivitás után).',
    ],
    [
      'Fotó a szobor-pózról',
      'A feladat teljesítése; a szervezők ellenőrizhetik.',
      'Hozzájárulás (GDPR 6. cikk (1) bekezdés a) pont; Ptk. 2:48. § – képmáshoz való jog)',
      `${daysText} után automatikusan törlődik, vagy korábban, ha kéritek.`,
    ],
    [
      'A fotó közzététele (csak ha külön hozzájárultatok)',
      `A rendezvény beszámolójában vagy közösségi oldalán${config.PRIVACY_EVENT ? ` (${esc(config.PRIVACY_EVENT)})` : ''}.`,
      'Hozzájárulás (GDPR 6. cikk (1) bekezdés a) pont)',
      'A hozzájárulás visszavonásáig.',
    ],
    [
      'Feltöltési napló (időpont, csapatnév, fájlnév, a hozzájárulás ténye)',
      'Annak igazolása, hogy a fotóhoz hozzájárultatok (GDPR 7. cikk (1) bekezdés).',
      'Jogos érdek (GDPR 6. cikk (1) bekezdés f) pont)',
      'A fotóval együtt törlődik.',
    ],
    [
      'IP-cím',
      'Visszaélések elleni védelem (a próbálkozások számának korlátozása).',
      'Jogos érdek (GDPR 6. cikk (1) bekezdés f) pont)',
      'Csak a memóriában, legfeljebb 1 percig; nem naplózzuk.',
    ],
  ];

  const table = `<table class="table">
    <thead><tr><th>Adat</th><th>Cél</th><th>Jogalap</th><th>Megőrzés</th></tr></thead>
    <tbody>${rows
      .map(
        ([a, b, c, d]) =>
          `<tr><td data-label="Adat">${a}</td><td data-label="Cél">${b}</td><td data-label="Jogalap">${c}</td><td data-label="Megőrzés">${d}</td></tr>`
      )
      .join('')}</tbody></table>`;

  const body = `
  <h1>Adatkezelési tájékoztató</h1>
  <p class="soft">Atlantisz elveszett városa – telefonos kalandjáték${config.PRIVACY_EVENT ? ` · ${esc(config.PRIVACY_EVENT)}` : ''}</p>

  <h2>1. Ki kezeli az adataitokat?</h2>
  <div class="card">
    <p><strong>Adatkezelő:</strong> ${field(config.PRIVACY_CONTROLLER, 'a szervező szervezet neve és címe')}</p>
    <p><strong>Elérhetőség:</strong> ${contact}</p>
    ${config.PRIVACY_DPO ? `<p><strong>Adatvédelmi tisztviselő:</strong> ${esc(config.PRIVACY_DPO)}</p>` : ''}
    ${config.PRIVACY_DEVELOPER ? `<p><strong>Az alkalmazás fejlesztője és üzemeltetője:</strong> ${esc(config.PRIVACY_DEVELOPER)}</p>` : ''}
  </div>

  <h2>2. Milyen adatokat kezelünk, miért és meddig?</h2>
  <p>A játékhoz nem kell regisztrálni, és nem kérünk nevet, e-mail-címet vagy telefonszámot.</p>
  ${table}

  <h2>3. Szabályok a fotóhoz</h2>
  <ul>
    <li>Csak olyan fotót töltsetek fel, amelynek elkészítéséhez és feltöltéséhez a rajta szereplő <strong>minden személy hozzájárult</strong>.</li>
    <li>Ne szerepeljen rajta kívülálló (aki nem tagja a csapatnak).</li>
    <li>16 év alatti személyről csak a szülő vagy törvényes képviselő hozzájárulásával készülhet fotó.</li>
    <li>A közzétételhez külön, önkéntes hozzájárulás kell. Enélkül a fotót csak a szervezők és a csapatotok látja.</li>
  </ul>

  <h2>4. Ki fér hozzá az adatokhoz?</h2>
  <ul>
    <li><strong>A szervezők</strong> egy jelszóval védett felületen látják a csapatok haladását és a fotókat.</li>
    <li><strong>A csapattársaitok</strong> a játék végén a csapat saját fotóit láthatják.</li>
    <li><strong>A kivetített ranglistán</strong> csak a csapatnév, a mélység és a menetidő jelenik meg.</li>
    <li>Az adatokat <strong>nem adjuk át</strong> harmadik félnek. Nincs analitika, nincs hirdetés, és külső szolgáltatást (pl. betűtípust) sem töltünk be.</li>
    <li><strong>Tárhely:</strong> ${field(config.PRIVACY_HOSTING, 'a tárhelyszolgáltató neve, vagy: a szervezők saját eszköze')}</li>
  </ul>

  <h2>5. Milyen jogaitok vannak?</h2>
  <ul>
    <li>Tájékoztatást kérhettek, és hozzáférhettek az adataitokhoz (GDPR 15. cikk).</li>
    <li>Kérhetitek a helyesbítésüket (16. cikk), törlésüket (17. cikk) vagy kezelésük korlátozását (18. cikk).</li>
    <li>Tiltakozhattok a jogos érdeken alapuló adatkezelés ellen (21. cikk), és kérhetitek az adatok hordozhatóságát (20. cikk).</li>
    <li>A hozzájárulásotokat <strong>bármikor visszavonhatjátok</strong> (7. cikk (3) bekezdés). Ez nem érinti a visszavonás előtti adatkezelés jogszerűségét.</li>
  </ul>
  <p>Kérelmeteket ide küldjétek: ${contact}. Adjátok meg a csapat nevét és a feltöltés hozzávetőleges idejét, hogy azonosítani tudjuk a fotót. Legkésőbb egy hónapon belül válaszolunk (GDPR 12. cikk (3) bekezdés).</p>

  <h2>6. Jogorvoslat</h2>
  <p>Ha úgy érzitek, hogy megsértettük az adatvédelmi jogaitokat, panaszt tehettek a Nemzeti Adatvédelmi és Információszabadság Hatóságnál:</p>
  <div class="card">
    <p><strong>Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH)</strong><br>
    Székhely: 1055 Budapest, Falk Miksa utca 9–11.<br>
    Postacím: 1363 Budapest, Pf. 9.<br>
    Telefon: +36 (1) 391-1400<br>
    E-mail: <a href="mailto:ugyfelszolgalat@naih.hu">ugyfelszolgalat@naih.hu</a><br>
    Honlap: <a href="https://www.naih.hu" rel="noopener">www.naih.hu</a></p>
  </div>
  <p>Bírósághoz is fordulhattok. A pert a lakóhelyetek szerinti törvényszék előtt is megindíthatjátok.</p>

  <h2>7. Az adatok biztonsága</h2>
  <p>A fotók a webről közvetlenül nem érhetők el, csak a szervezők jelszóval védett felületén és a saját csapatotok számára. A feltöltött fájlok típusát ellenőrizzük. Interneten keresztül a kapcsolat titkosított (HTTPS).</p>

  <p class="soft" style="margin-top:40px">Utolsó módosítás: ${field(config.PRIVACY_UPDATED, 'dátum')}</p>
  <p><a class="btn" href="/">Vissza a játékhoz</a></p>`;

  return layout('Adatkezelési tájékoztató', body);
}

module.exports = { gatePage, privacyPage, notFoundPage, posterPage, POSTERS, esc };

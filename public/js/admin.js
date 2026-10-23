'use strict';

// Admin felület – minden egy helyen: csapatok, ranglista, fotók, eseménynapló, beállítások és QR-kód.
// Minden adat a jelszóval védett /api/admin végpontokról jön.
(function () {
  const root = document.getElementById('admin');
  const REFRESH_MS = 5000;
  const STUCK_MS = 10 * 60 * 1000; // ennyi idő után jelezzük, hogy egy csapat elakadhatott
  const IDLE_MS = 5 * 60 * 1000; // ennyi inaktivitás után „inaktív"
  const TABS = [
    ['csapatok', 'Csapatok'],
    ['ranglista', 'Ranglista'],
    ['fotok', 'Fotók'],
    ['naplo', 'Napló'],
    ['beallitasok', 'Beállítások és QR'],
  ];

  let timer = null;
  let skew = 0; // a szerver és a böngésző órája közti eltérés
  let data = null; // az utolsó áttekintés (fülváltáskor nem kell újra letölteni)
  let tab = TABS.some(([id]) => `#${id}` === location.hash) ? location.hash.slice(1) : 'csapatok';
  const openPhotos = new Set(); // lenyitott fotó-blokkok, hogy a frissítés ne csukja össze őket

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(url, body) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const init = { credentials: 'same-origin', signal: controller.signal, headers: {} };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      const e = new Error('Nincs kapcsolat a szerverrel.');
      e.status = 0;
      throw e;
    } finally {
      clearTimeout(t);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(json.error || 'Váratlan hiba.');
      e.status = res.status;
      throw e;
    }
    return json;
  }

  function ago(ts) {
    if (!ts) return '–';
    const s = Math.max(0, Math.round((Date.now() - skew - ts) / 1000));
    if (s < 60) return `${s} mp`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} perc`;
    return `${Math.floor(m / 60)} ó ${m % 60} p`;
  }

  function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  const clock = (ts) => new Date(ts).toLocaleTimeString('hu-HU');

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => (document.hidden ? schedule() : load()), REFRESH_MS);
  }

  function stopRefresh() {
    clearTimeout(timer);
    timer = null;
  }

  // ===== belépés és üzenetek =====

  // Nincs (már) hozzáférés: lejárt a belépés, kiléptél, vagy közben új szervezői link készült
  function showNoAccess(text) {
    stopRefresh();
    data = null;
    showMessage(
      'Nincs hozzáférés',
      text || 'Nyisd meg újra a szervezői linket (vagy olvasd be a szervezői QR-kódot), vagy nyisd meg az admin felületet a szerver gépén.'
    );
  }

  let qrVersion = 0; // a QR-kép újratöltéséhez linkcsere után
  let accessShown = false; // a szervezői QR csak kérésre látszik (vállon át ne lehessen lefotózni)

  function note(text, bad = false) {
    const msg = document.getElementById('adminMsg');
    if (!msg) return;
    msg.textContent = text;
    msg.className = `msg${bad ? ' bad' : ''}`;
  }

  // A logós QR-kód PNG-ként: a vektoros SVG-t a böngésző rajzolja ki nagy felbontásban
  async function downloadQrPng(btn) {
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/join-qr.svg', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('A QR-kód nem tölthető le.');
      const url = URL.createObjectURL(new Blob([await res.text()], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = () => fail(new Error('A QR-kód nem rajzolható ki.'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2000;
      canvas.getContext('2d').drawImage(img, 0, 0, 2000, 2000);
      URL.revokeObjectURL(url);
      const png = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(png);
      a.download = 'atlantisz-qr-jatek.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      note(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function copyLink(btn) {
    const input = document.getElementById('accessLink');
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      // régebbi böngésző vagy http: kijelöljük, a felhasználó másolja
      input.select();
      document.execCommand?.('copy');
    }
    btn.textContent = 'Kimásolva';
    setTimeout(() => (btn.textContent = 'Link másolása'), 2000);
  }

  function showMessage(title, text) {
    stopRefresh();
    root.innerHTML = `<section class="panel login"><h1>${esc(title)}</h1><p class="msg">${esc(text)}</p></section>`;
  }

  // ===== Csapatok fül =====

  function teamStatus(t, now) {
    if (t.finished) return '<span class="badge ok">Célba ért</span>';
    const badges = [];
    if (now - t.stageStartedAt > STUCK_MS) badges.push(`<span class="badge warn">Elakadtak? ${esc(ago(t.stageStartedAt))} itt</span>`);
    if (now - t.lastActive > IDLE_MS) badges.push(`<span class="badge idle">Inaktív ${esc(ago(t.lastActive))}</span>`);
    return badges.join(' ');
  }

  function photoFigures(t) {
    return t.photos
      .map(
        (p) => `<figure>
          <a href="/api/admin/photos/${esc(p.file)}" target="_blank" rel="noopener"><img src="/api/admin/photos/${esc(p.file)}" alt="${esc(t.name)} fotója" loading="lazy" decoding="async"></a>
          <figcaption>${p.publish ? '<span class="badge ok">Közzétehető</span>' : '<span class="badge idle">Csak belső</span>'}</figcaption>
        </figure>`
      )
      .join('');
  }

  function teamCard(t, total, now) {
    const done = t.finished ? total : t.stageIndex;
    const pct = Math.round((done / total) * 100);
    const where = t.finished
      ? `Atlantisz · ${esc(t.depth)} m`
      : `${t.stageIndex + 1}. ${esc(t.stageTitle)}${t.riddleNo ? ` (rejtvény ${t.riddleNo}/3)` : ''} · ${esc(t.depth)} m`;
    const photos = t.photos.length
      ? `<details class="photos" data-code="${esc(t.code)}" ${openPhotos.has(t.code) ? 'open' : ''}>
           <summary>Fotók (${t.photos.length})</summary>
           <div class="photo-grid">${photoFigures(t)}</div>
           <button class="btn ghost" data-action="photos/delete" data-code="${esc(t.code)}">Fotók törlése</button>
         </details>`
      : '';
    return `
      <article class="panel team">
        <div class="team-head">
          <span class="team-name">${esc(t.name)}</span>
          <span class="team-code">${esc(t.code)}</span>
        </div>
        <div class="team-meta">
          <span>${where}</span>
          <span>${t.members}/${t.maxMembers} fő</span>
          <span>Aktív: ${esc(ago(t.lastActive))}</span>
          <span>Indult: ${esc(ago(t.createdAt))}</span>
          ${t.hintsUsed ? `<span>Segítség: ${t.hintsUsed} (+${duration(t.penaltyMs)})</span>` : ''}
        </div>
        <div class="progress" aria-label="Haladás ${pct}%"><span style="width:${pct}%"></span></div>
        <div>${teamStatus(t, now)}</div>
        <div class="actions">
          <button class="btn ghost" data-action="advance" data-code="${esc(t.code)}" ${t.finished ? 'disabled' : ''}>Átléptetés</button>
          <button class="btn ghost" data-action="reset" data-code="${esc(t.code)}">Visszaállítás</button>
          <button class="btn danger" data-action="delete" data-code="${esc(t.code)}">Törlés</button>
        </div>
        ${photos}
      </article>`;
  }

  function teamsTab(d) {
    const now = d.serverTime;
    const total = d.stages.length;
    const sorted = [...d.teams].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.totalMs - b.totalMs;
      if (a.stageIndex !== b.stageIndex) return b.stageIndex - a.stageIndex;
      return a.stageStartedAt - b.stageStartedAt;
    });
    const perStage = d.stages.map((s, i) => ({
      ...s,
      count: d.teams.filter((t) => !t.finished && t.stageIndex === i).length,
    }));
    const maxCount = Math.max(1, ...perStage.map((s) => s.count), d.totals.finished);
    const stageRow = (depth, title, count) => `
      <div class="stage-row">
        <span class="depth">${esc(depth)} m</span>
        <span><span>${esc(title)}</span><span class="bar"><span style="width:${(count / maxCount) * 100}%"></span></span></span>
        <span class="count">${count}</span>
      </div>`;
    return `
      <h2>Hol tartanak a csapatok</h2>
      <section class="panel stages">
        ${perStage.map((s) => stageRow(s.depth, s.title, s.count)).join('')}
        ${stageRow(200, 'Atlantisz', d.totals.finished)}
      </section>
      <h2>Csapatok (${d.teams.length})</h2>
      <section class="teams">
        ${sorted.length ? sorted.map((t) => teamCard(t, total, now)).join('') : '<p class="empty">Még nincs csapat. Amint valaki létrehoz egyet, itt megjelenik.</p>'}
      </section>`;
  }

  // ===== Ranglista fül =====

  function boardTab(d) {
    const rows = d.leaderboard
      .map(
        (t) => `<tr class="${t.finished ? 'done' : ''}">
          <td>${t.finished ? `${t.rank}.` : '…'}</td>
          <td>${esc(t.name)}</td>
          <td>${t.finished ? 'Atlantisz' : `${esc(t.stage)} · ${esc(t.depth)} m`}</td>
          <td>${t.finished ? `${duration(t.totalMs)}${t.penaltyMs ? ` <span class="soft">(+${duration(t.penaltyMs)})</span>` : ''}` : '–'}</td>
        </tr>`
      )
      .join('');
    return `
      <div class="tab-head">
        <h2>Élő ranglista</h2>
        <a class="btn ghost" href="/ranglista" target="_blank" rel="noopener">Kivetítő nézet megnyitása</a>
      </div>
      <p class="soft">A célba ért csapatok a menetidő szerint (a segítség-büntetéssel együtt), a többiek a mélység szerint. A célba ért csapatok ugyanezt látják a telefonjukon. ${d.publicBoard ? '' : 'A nyilvános kivetítő nézet ki van kapcsolva (PUBLIC_BOARD=0).'}</p>
      <section class="panel">
        ${
          d.leaderboard.length
            ? `<table class="board"><thead><tr><th>#</th><th>Csapat</th><th>Hol tart</th><th>Menetidő</th></tr></thead><tbody>${rows}</tbody></table>`
            : '<p class="empty">Még nincs csapat.</p>'
        }
      </section>`;
  }

  // ===== Fotók fül =====

  function photosTab(d) {
    const withPhotos = d.teams.filter((t) => t.photos.length);
    return `
      <h2>Fotók (${d.totals.photos})</h2>
      <p class="soft">A fotókat csak itt lehet látni. ${esc(d.retentionDays)} nap után automatikusan törlődnek. Törlési kérelemnél a csapat fotóit a „Fotók törlése" gombbal azonnal törölheted. „Közzétehető" csak az a fotó, amelyhez a csapat külön hozzájárult.</p>
      ${
        withPhotos.length
          ? withPhotos
              .map(
                (t) => `<section class="panel gallery-team">
                  <div class="tab-head">
                    <span class="team-name">${esc(t.name)} <span class="soft">(${t.photos.length})</span></span>
                    <button class="btn ghost" data-action="photos/delete" data-code="${esc(t.code)}">Fotók törlése</button>
                  </div>
                  <div class="photo-grid">${photoFigures(t)}</div>
                </section>`
              )
              .join('')
          : '<p class="empty">Még nincs feltöltött fotó.</p>'
      }`;
  }

  // ===== Napló fül =====

  function eventsTab(d) {
    return `
      <h2>Eseménynapló</h2>
      <p class="soft">A legutóbbi események, legfrissebb elöl. A napló csak a szerver memóriájában van, újraindításkor üresen indul.</p>
      <section class="panel">
        ${
          d.events.length
            ? `<ol class="events">${d.events
                .map(
                  (e) => `<li>
                    <time>${clock(e.at)}</time>
                    <span class="ev-team">${esc(e.team || '–')}</span>
                    <span class="ev-text">${esc(e.text)}</span>
                  </li>`
                )
                .join('')}</ol>`
            : '<p class="empty">Még nem történt semmi.</p>'
        }
      </section>`;
  }

  // ===== Beállítások és QR fül =====

  function settingsTab(d) {
    const st = d.status;
    return `
      <h2>Ellenőrzőlista a rendezvény előtt</h2>
      <section class="panel">
        <ul class="checks">
          ${st.checks
            .map(
              (c) => `<li class="${c.ok ? 'ok' : 'bad'}">
                <span class="check-icon" aria-hidden="true">${c.ok ? '✓' : '!'}</span>
                <span><strong>${esc(c.label)}</strong><br><span class="soft">${esc(c.detail)}</span></span>
              </li>`
            )
            .join('')}
        </ul>
      </section>

      <h2>Szervezői hozzáférés</h2>
      <section class="panel qr access">
        ${
          accessShown
            ? `<img src="/api/admin/access-qr.png?v=${qrVersion}" alt="A szervezői belépés QR-kódja" width="220" height="220">`
            : `<button class="qr-cover" data-action="show-access" type="button"><span>QR-kód megjelenítése</span></button>`
        }
        <div>
          <p>A többi szervező ezzel a QR-kóddal vagy linkkel lép be a telefonján. Jelszó nem kell: egyszeri megnyitás után a telefon ${esc(d.access.hours)} óráig belépve marad.</p>
          <p class="soft">Ne add a játékosoknak és ne vetítsd ki! A szerver gépén a <code>localhost</code> címen az admin felület mindig megnyílik.</p>
          ${
            accessShown
              ? `<div class="copy-row"><input id="accessLink" class="mono" readonly value="${esc(d.access.link)}" aria-label="Szervezői link"><button class="btn ghost" data-action="copy-link" type="button">Link másolása</button></div>`
              : ''
          }
          ${
            d.access.fromEnv
              ? '<p class="soft">A kulcs az ADMIN_KEY környezeti változóból jön, ott cserélhető.</p>'
              : '<p><button class="btn danger ghost" data-action="rotate" type="button">Új link, a régi kiléptetése</button></p>'
          }
        </div>
      </section>

      <h2>QR-kód a játékhoz (kinyomtatható)</h2>
      <section class="panel qr">
        <img src="/api/admin/join-qr.svg" alt="A játék belépő QR-kódja" width="220" height="220">
        <div>
          <p>Ezzel érik el a játékosok a játékot: plakátra, asztali kártyára, kivetítőre. Beolvasás után egyből a kezdőképernyő nyílik meg.</p>
          <p class="soft">Cél: <code>${esc(d.joinUrl)}</code></p>
          ${
            d.baseIsLocal
              ? '<p class="msg bad">A cím most localhost: telefonról nem működne. Nyomtatás előtt állítsd be a BASE_URL-t (a végleges címre), és indítsd újra a szervert.</p>'
              : '<p class="soft">Csak akkor nyomtasd ki előre, ha ez a cím a rendezvényen is ugyanez lesz (fix IP-cím vagy domain).</p>'
          }
          <p class="links">
            <a class="btn" href="/admin/plakat?mi=jatek&amp;meret=kartya" target="_blank" rel="noopener">Tenyérnyi kártyák</a>
            <a class="btn ghost" href="/admin/plakat?mi=jatek" target="_blank" rel="noopener">A4-es plakát</a>
            <a class="btn ghost" href="/api/admin/join-qr.svg?download=1" download="atlantisz-qr-jatek.svg">SVG (nyomdába)</a>
            <button class="btn ghost" type="button" data-action="qr-png">PNG (2000 px)</button>
          </p>
        </div>
      </section>

      <h2>QR-kód a kapuhoz</h2>
      <section class="panel qr">
        <img src="/api/admin/qr.png" alt="A kapu QR-kódja" width="220" height="220">
        <div>
          <p>Ezt nyomtasd ki, és helyezd el a kapunál. A csapat a játék böngészőjével szkennelve automatikusan átjut.</p>
          <p class="soft">Cél: <code>${esc(d.gateUrl)}</code></p>
          <p class="links"><a class="btn" href="/admin/plakat?mi=kapu" target="_blank" rel="noopener">A4-es plakát</a> <a class="btn ghost" href="/api/admin/qr.png?download=1" download="atlantisz-qr-kapu.png">QR-kód letöltése</a></p>
        </div>
      </section>

      <h2>Beállítások</h2>
      <section class="panel">
        <table class="board settings">
          <tbody>${st.settings.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody>
        </table>
        <p class="soft">A beállítások környezeti változókkal módosíthatók (lásd README), és a szerver újraindítása után érvényesek.</p>
      </section>

      <h2>Tesztfázis vége</h2>
      <section class="panel danger-zone">
        <p>A próbajáték után innen indíthatsz tiszta lappal: minden csapat, a napló és a feltöltött fotók törlődnek. A beállítások, a kapukód és a szervezői link megmarad.</p>
        <div class="copy-row">
          <input id="resetConfirm" autocomplete="off" placeholder="Írd be: TÖRLÉS" aria-label="Megerősítés: írd be, hogy TÖRLÉS">
          <button class="btn danger" type="button" data-action="reset-all">Minden csapat és fotó törlése</button>
        </div>
      </section>

      <h2>Hasznos oldalak</h2>
      <section class="panel links">
        <a class="btn ghost" href="/ranglista" target="_blank" rel="noopener">Kivetíthető ranglista</a>
        <a class="btn ghost" href="/adatvedelem" target="_blank" rel="noopener">Adatkezelési tájékoztató</a>
        <a class="btn ghost" href="/" target="_blank" rel="noopener">A játék</a>
      </section>`;
  }

  // ===== teljes nézet =====

  function render() {
    const d = data;
    skew = Date.now() - d.serverTime;
    const failing = d.status.checks.filter((c) => !c.ok).length;
    const counts = { csapatok: d.totals.teams, fotok: d.totals.photos, beallitasok: failing || '' };
    const body = { csapatok: teamsTab, ranglista: boardTab, fotok: photosTab, naplo: eventsTab, beallitasok: settingsTab }[tab](d);

    root.innerHTML = `
      <div class="topbar">
        <h1>Irányítóterem</h1>
        <div class="actions">
          <span class="updated">Frissítve: ${new Date().toLocaleTimeString('hu-HU')}</span>
          <button class="btn ghost" data-action="refresh">Frissítés</button>
          ${d.access.local ? '<span class="updated">Szerver gépe</span>' : '<button class="btn ghost" data-action="logout">Kilépés</button>'}
        </div>
      </div>

      ${
        failing
          ? `<button class="banner" data-tab="beallitasok">${failing} dolog még hiányzik a rendezvény előtt. Ellenőrzőlista megnyitása</button>`
          : ''
      }

      <div class="tiles">
        <div class="panel tile"><div class="value">${d.totals.teams}</div><div class="label">csapat</div></div>
        <div class="panel tile"><div class="value">${d.totals.players}</div><div class="label">játékos</div></div>
        <div class="panel tile"><div class="value">${d.totals.finished}</div><div class="label">célba ért</div></div>
        <div class="panel tile"><div class="value">${d.totals.photos}</div><div class="label">fotó</div></div>
      </div>

      <nav class="tabs" role="tablist">
        ${TABS.map(
          ([id, label]) =>
            `<button role="tab" class="tab${id === tab ? ' active' : ''}" aria-selected="${id === tab}" data-tab="${id}">${esc(label)}${
              counts[id] !== undefined && counts[id] !== '' ? ` <span class="tab-count${id === 'beallitasok' ? ' warn' : ''}">${esc(counts[id])}</span>` : ''
            }</button>`
        ).join('')}
      </nav>

      <div class="tab-body">${body}</div>
      <p class="msg" id="adminMsg" role="status"></p>`;

    // Telefonon a fülsáv görgethető: a kiválasztott fül mindig látszódjon
    const active = root.querySelector('.tab.active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  async function load() {
    try {
      data = await api('/api/admin/overview');
      render();
      schedule();
    } catch (err) {
      if (err.status === 401 || err.status === 404) return showNoAccess();
      const msg = document.getElementById('adminMsg');
      if (msg) {
        msg.textContent = `${err.message} Újrapróbálom…`;
        msg.className = 'msg bad';
      } else {
        showMessage('Nincs kapcsolat', `${err.message} Újrapróbálom…`);
      }
      schedule();
    }
  }

  // ===== műveletek (eseménydelegálással, mert a nézet frissítéskor újrarajzolódik) =====

  const CONFIRM = {
    reset: 'Biztosan visszaállítod ezt a csapatot az első állomásra? A menetidő is újraindul.',
    delete: 'Biztosan törlöd ezt a csapatot? A tagok a kezdő képernyőre kerülnek, és a csapat fotói is törlődnek.',
    'photos/delete': 'Biztosan törlöd a csapat összes fotóját? Ez nem vonható vissza (pl. törlési kérelem esetén).',
    advance: 'Átléptetted ezt a csapatot a következő állomásra?',
  };

  root.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      history.replaceState(null, '', `#${tab}`);
      if (data) render();
      window.scrollTo({ top: 0 });
      return;
    }
    if (e.target.closest('[data-action="show-access"]')) {
      accessShown = true;
      if (data) render();
      return;
    }
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, code } = btn.dataset;
    if (action === 'refresh') return load();
    if (action === 'logout') {
      await api('/api/admin/logout', {}).catch(() => {});
      return showNoAccess('Kiléptél. Újra belépni a szervezői linkkel vagy QR-kóddal tudsz.');
    }
    if (action === 'copy-link') return copyLink(btn);
    if (action === 'qr-png') return downloadQrPng(btn);
    if (action === 'reset-all') {
      const confirmText = document.getElementById('resetConfirm')?.value || '';
      if (confirmText.trim().toUpperCase() !== 'TÖRLÉS') return note('A törléshez írd be a mezőbe: TÖRLÉS', true);
      if (!window.confirm('Biztosan törölsz minden csapatot és fotót? Ez nem vonható vissza.')) return;
      btn.disabled = true;
      try {
        const r = await api('/api/admin/reset-all', { confirm: confirmText });
        await load();
        return note(`Kész: ${r.teams} csapat és ${r.photos} fotó törölve. Indulhat az este!`);
      } catch (err) {
        btn.disabled = false;
        return note(err.message, true);
      }
    }
    if (action === 'rotate') {
      if (!window.confirm('Új szervezői linket készítesz? A régi linkkel belépett összes többi telefon azonnal kilép, nekik az új QR-kódot kell beolvasniuk.')) return;
      btn.disabled = true;
      try {
        await api('/api/admin/key/rotate', {});
        qrVersion += 1;
      } catch (err) {
        btn.disabled = false;
        return note(err.message, true);
      }
      await load();
      return note('Kész: az új szervezői link él, a régi már nem nyit be.');
    }
    if (CONFIRM[action] && !window.confirm(CONFIRM[action])) return;
    btn.disabled = true;
    try {
      await api(`/api/admin/teams/${encodeURIComponent(code)}/${action}`, {});
    } catch (err) {
      const msg = document.getElementById('adminMsg');
      if (msg) {
        msg.textContent = err.message;
        msg.className = 'msg bad';
      }
    }
    load();
  });

  root.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.dataset.code) return;
      if (d.open) openPhotos.add(d.dataset.code);
      else openPhotos.delete(d.dataset.code);
    },
    true
  );

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && timer) load();
  });

  load();
})();

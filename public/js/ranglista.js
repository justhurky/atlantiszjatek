'use strict';

// Kivetíthető ranglista: 5 másodpercenként frissül, csak csapatnevet, mélységet és időt mutat.
(function () {
  const rows = document.getElementById('rows');
  const more = document.getElementById('more');
  const updated = document.getElementById('updated');
  const note = document.getElementById('note');
  const MAX_ROWS = 12;

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function render(data) {
    const shown = data.teams.slice(0, MAX_ROWS);
    if (!shown.length) {
      rows.innerHTML = '<p class="empty">Még egy csapat sem merült le. Hozzatok létre csapatot a telefonotokon!</p>';
    } else {
      rows.innerHTML = shown
        .map((t) => {
          const pct = Math.round((t.depth / data.maxDepth) * 100);
          return `
          <article class="row${t.finished ? ' done' : ''}">
            <span class="pos${t.finished ? '' : ' playing'}">${t.finished ? `${t.rank}.` : '…'}</span>
            <span class="name">${esc(t.name)}</span>
            <div class="gauge" aria-label="${esc(t.depth)} méter">
              <span class="fill" style="width:${pct}%"></span>
              <span class="label">${esc(t.stage)}</span>
            </div>
            ${
              t.finished
                ? `<span class="right time">${duration(t.totalMs)}</span>`
                : `<span class="right depth">${esc(t.depth)} m</span>`
            }
          </article>`;
        })
        .join('');
    }
    const rest = data.teams.length - shown.length;
    more.hidden = rest <= 0;
    more.textContent = rest > 0 ? `+ még ${rest} csapat a mélyben` : '';
    const g = data.game || {};
    const status = g.ended
      ? `A játék ${g.endClock}-kor véget ért, ez a végeredmény.`
      : g.endsAt
        ? `A játék ${g.endClock}-ig tart.`
        : '';
    note.textContent = [status, g.note].filter(Boolean).join(' ');
    note.hidden = !note.textContent;
    updated.textContent = `Frissítve: ${new Date().toLocaleTimeString('hu-HU')}`;
  }

  async function load() {
    try {
      const res = await fetch('/api/leaderboard', { cache: 'no-store' });
      if (res.status === 404) {
        rows.innerHTML = '<p class="empty">A ranglista ki van kapcsolva.</p>';
        return; // nincs mit frissíteni
      }
      render(await res.json());
    } catch {
      updated.textContent = 'Nincs kapcsolat a szerverrel, újrapróbálom…';
    }
    setTimeout(load, 5000);
  }

  load();
})();

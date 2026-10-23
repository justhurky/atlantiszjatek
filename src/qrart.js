'use strict';

// Díszített, nyomdai minőségű (vektoros) QR-kód: lekerekített modulok, lekerekített „szemek",
// középen az ESK–IVK közös embléma. A logó miatt a legerősebb (H, ~30%) hibajavítást használjuk,
// és a logó csak a kód kb. 7%-át takarja, így bármely kamera biztonsággal beolvassa.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const LOGO_FILE = path.join(__dirname, '..', 'public', 'assets', 'logo', 'hok-emblema.png');
let logoUri = null;
try {
  logoUri = `data:image/png;base64,${fs.readFileSync(LOGO_FILE).toString('base64')}`;
} catch {
  /* nincs logó: sima QR-kód készül */
}

const r3 = (v) => Math.round(v * 1000) / 1000;

// Lekerekített téglalap pályaként (az összes modul egyetlen path-ba kerül: kicsi, gyors SVG)
function roundRect(x, y, w, h, r) {
  return `M${r3(x + r)} ${r3(y)}h${r3(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${r3(h - 2 * r)}a${r} ${r} 0 0 1 -${r} ${r}h-${r3(w - 2 * r)}a${r} ${r} 0 0 1 -${r} -${r}v-${r3(h - 2 * r)}a${r} ${r} 0 0 1 ${r} -${r}z`;
}

/**
 * @param {string} text  a kódolt cím
 * @param {{ logo?: boolean, dark?: string, accent?: string, margin?: number }} opts
 * @returns {string} SVG
 */
function qrArtSvg(text, { logo = true, dark = '#061a30', accent = '#b8862b', margin = 3 } = {}) {
  const useLogo = Boolean(logo && logoUri);
  const qr = QRCode.create(text, { errorCorrectionLevel: useLogo ? 'H' : 'Q' });
  const n = qr.modules.size;
  const data = qr.modules.data;
  // 7-es verziótól középen igazító minta van: ott nem takarunk ki semmit (rövid címnél ez nem fordul elő)
  const withLogo = useLogo && qr.version <= 6;
  let clear = 0;
  if (withLogo) {
    clear = Math.round(n * 0.27);
    if ((n - clear) % 2) clear += 1; // pontosan középre essen
  }
  const c0 = (n - clear) / 2;
  const inClear = (x, y) => withLogo && x >= c0 && x < c0 + clear && y >= c0 && y < c0 + clear;
  const inFinder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);

  const m = margin;
  let dots = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!data[y * n + x] || inFinder(x, y) || inClear(x, y)) continue;
      dots += roundRect(m + x + 0.04, m + y + 0.04, 0.92, 0.92, 0.28);
    }
  }
  // a három „szem": külső keret (lekerekített gyűrű) + belső pötty
  let eyes = '';
  let pupils = '';
  for (const [ex, ey] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    const x = m + ex;
    const y = m + ey;
    eyes += roundRect(x, y, 7, 7, 2) + roundRect(x + 1, y + 1, 5, 5, 1.3);
    pupils += roundRect(x + 2, y + 2, 3, 3, 0.9);
  }
  const size = n + 2 * m;
  let logoSvg = '';
  if (withLogo) {
    const pad = 0.55;
    const t = m + c0 + pad;
    const w = clear - 2 * pad;
    logoSvg =
      `<circle cx="${r3(m + n / 2)}" cy="${r3(m + n / 2)}" r="${r3(clear / 2 - 0.15)}" fill="#fff" stroke="${accent}" stroke-width="0.18"/>` +
      `<image href="${logoUri}" x="${r3(t + 0.35)}" y="${r3(t + 0.35)}" width="${r3(w - 0.7)}" height="${r3(w - 0.7)}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="geometricPrecision">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path fill="${dark}" d="${dots}"/>` +
    `<path fill="${dark}" fill-rule="evenodd" d="${eyes}"/>` +
    `<path fill="${dark}" d="${pupils}"/>` +
    logoSvg +
    `</svg>`
  );
}

module.exports = { qrArtSvg, hasLogo: () => Boolean(logoUri) };

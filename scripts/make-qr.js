'use strict';

// Használat: npm run qr  →  a public/assets mappába:
//   qr-jatek.svg                 – belépés a játékba, középen az ESK–IVK emblémával (nyomdába)
//   qr-jatek.png                 – ugyanez egyszerű PNG-ként, logó nélkül
//   qr-kapu.png                  – Atlantisz kapuja (a helyszínen kell elrejteni)
// Kényelmesebb: az admin felület Beállítások és QR fülén A4-es plakátként is nyomtatható.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const config = require('../src/config');
const { qrArtSvg } = require('../src/qrart');

const dir = path.join(__dirname, '..', 'public', 'assets');
const base = config.BASE_URL.replace(/\/+$/, '');
const join = `${base}/`;
const gate = `${base}/kapu/${encodeURIComponent(config.GATE_QR_SECRET)}`;
const style = { errorCorrectionLevel: 'Q', margin: 2, color: { dark: '#061a30', light: '#ffffff' } };

(async () => {
  await QRCode.toFile(path.join(dir, 'qr-jatek.png'), join, { ...style, width: 2000 });
  fs.writeFileSync(path.join(dir, 'qr-jatek.svg'), qrArtSvg(join));
  await QRCode.toFile(path.join(dir, 'qr-kapu.png'), gate, { width: 800, margin: 2 });
  console.log(`Kész a ${dir} mappában.\nJáték: ${join}\nKapu:  ${gate}`);
  if (/\/\/(localhost|127\.0\.0\.1)/.test(base)) {
    console.warn('FIGYELEM: a BASE_URL localhost, ezek a QR-kódok telefonról nem működnek! Állítsd be a végleges címet.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

// Használat: npm run clean:uploads
// Törli a feltöltött fotókat és a feltöltési naplót (pl. a rendezvény után, vagy tesztelés után).
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../src/config');

if (!fs.existsSync(UPLOAD_DIR)) {
  console.log(`Nincs mit törölni (${UPLOAD_DIR} nem létezik).`);
  process.exit(0);
}

let removed = 0;
for (const name of fs.readdirSync(UPLOAD_DIR)) {
  fs.rmSync(path.join(UPLOAD_DIR, name), { recursive: true, force: true });
  removed += 1;
}
console.log(`${removed} fájl törölve innen: ${UPLOAD_DIR}`);

'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
// A tesztszerverek szervezői kulcsa. A helyi (localhost) automatikus admin-hozzáférés a tesztekben
// alapból ki van kapcsolva, mert a tesztkliensek is a 127.0.0.1 címről jönnek.
const TEST_ADMIN_KEY = 'teszt-szervezoi-kulcs-0123456789';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Külön szerverpéldányt indít a megadott környezeti változókkal.
// Minden példány saját, ideiglenes feltöltési mappát kap: a tesztek soha nem írnak a valódi uploads/ mappába.
async function startServer(env = {}) {
  const port = await freePort();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantisz-teszt-'));
  const uploadDir = path.join(baseDir, 'uploads');
  const dataFile = path.join(baseDir, 'state.json');
  const cleanup = () => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* Windowson egy pillanatig zárolva lehet; az ideiglenes mappát a rendszer is takarítja */
    }
  };
  let out = '';
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, NODE_ENV: '', PORT: String(port), UPLOAD_DIR: uploadDir, DATA_FILE: dataFile, ADMIN_LOCAL: '0', ADMIN_KEY: TEST_ADMIN_KEY, DOTENV: '0', AUTO_BASE_URL: '0', SESSION_SECRET: 'teszt-munkamenet-titok', GATE_QR_SECRET: 'qr-kapu-2026', GATE_CODE: 'ATLANTISZ', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + '/api/game');
      return {
        base,
        child,
        uploadDir,
        dataFile,
        log: () => out,
        // leállítás; a visszaadott ígéret akkor teljesül, amikor a folyamat (és a leállás előtti mentés) befejeződött
        stop: () => {
          const exited = child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', r));
          child.kill();
          return exited.then(cleanup);
        },
      };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  child.kill();
  cleanup();
  throw new Error('A szerver nem indult el:\n' + out);
}

// Egy "telefon": saját munkamenet-sütivel
class Client {
  constructor(base) {
    this.base = base;
    this.cookie = null;
  }

  async req(method, url, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (typeof body === 'string') {
      headers['content-type'] ??= 'application/json';
      payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* nem JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  get(url) {
    return this.req('GET', url);
  }

  post(url, body = {}) {
    return this.req('POST', url, body);
  }
}

// Szervezőként belépett kliens (a szervezői link megnyitásával)
async function adminClient(base, key = TEST_ADMIN_KEY) {
  const c = new Client(base);
  const r = await c.get(`/admin/${key}`);
  if (r.status !== 303) throw new Error(`Szervezői belépés sikertelen: ${r.status}`);
  return c;
}

// Egy PNG-kép (1x1), a fotó-feltöltés teszteléséhez
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// Zajos, nagy PNG (tömörítés-teszthez). Tiszta Node: nincs natív függőség.
function noisePng(w, h) {
  const zlib = require('node:zlib');
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bitmélység
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // szűrő nélkül
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (Math.random() * 256) | 0;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Fotó-űrlap; alapból a kötelező hozzájárulással (consent), ahogy a játék felülete is küldi
function photoForm(buf = PNG_1PX, type = 'image/png', name = 'pose.png', { consent = true, publish = false } = {}) {
  const fd = new FormData();
  fd.append('photo', new Blob([buf], { type }), name);
  if (consent) fd.append('consent', 'yes');
  if (publish) fd.append('publish', 'yes');
  return fd;
}

// Kikeresi a JSON-ban az összes kulcsot (titok-szivárgás ellenőrzéshez)
function allKeys(obj, out = new Set()) {
  if (Array.isArray(obj)) obj.forEach((v) => allKeys(v, out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

module.exports = { TEST_ADMIN_KEY, adminClient, startServer, Client, photoForm, PNG_1PX, allKeys, noisePng };

'use strict';

// Csapatnév-szűrő: kiszűri a trágár, sértő és gyűlöletkeltő neveket, a szokásos trükkökkel együtt
// (f@sz, f4sz, f.a.s.z, f a s z, f*sz, faaasz, fász, kurwa, 𝐟𝐚𝐬𝐳, cirill betűs „а"…).
// Szándékosan szigorú: bulin inkább egy ártatlan név akadjon fenn, mint hogy egy trágár kikerüljön
// a kivetítőre. Kiegészíthető a BLOCKED_NAMES beállítással (vesszővel elválasztott szavak).

// Bárhol a szóban tiltott tövek (ékezet nélkül, kisbetűvel)
const ROOTS = [
  // magyar
  'fasz', 'kurva', 'kurvany', 'picsa', 'geci', 'kocsog', 'buzi', 'buzer', 'ribanc', 'ringyo', 'lotyo',
  'luvnya', 'cafka', 'csicska', 'nyomorek', 'retard', 'punci', 'csocs', 'hugy', 'segg', 'anyad',
  'basz', 'szopj', 'szopo', 'szopas', 'szopik', 'szopni', 'szoptam', 'szarhazi', 'szarfej', 'szarzsak',
  'szaros', 'rohadek', 'bunzli', 'neger', 'cigo', 'hitler', 'maszturb', 'porno',
  'kibasz', 'elbasz', 'megbasz', 'leszop', 'kurvul', 'faszkalap', 'gecis',
  // angol
  'fuck', 'fuk', 'fck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'pussy', 'penis', 'vagina', 'nigger',
  'nigga', 'fagot', 'faggot', 'porn', 'asshole', 'wank', 'twat', 'dildo', 'boob', 'motherf',
];

// Csak önálló szóként (vagy felsorolt toldalékkal) tiltott, mert ártatlan szavakban is előfordul
// (szarvas, foszfor, pocsolya, Dickens, koktél, nacionális…)
const WORDS = [
  /^szar(ok|os|osok|t|ra|ral|ba|ban|bol|nak|ni|ik|ja|om|unk|fej|zsak|hazi)?$/,
  /^fos(ok|os|osok|t|ni|ik|sz|kasz)?$/,
  /^pin(a|ak|as|at|aja|aba|ad|am)$/,
  /^pocs(ok|os|ot|fej)?$/,
  /^(nazi|naci)(k|s|sta|stak|zmus)?$/,
  /^heil$/,
  /^(sex|sexy|szex|szexi|szexy)$/,
  /^dick(s|head|ek)?$/,
  /^cock(s)?$/,
  /^(ass|arse|tits?|kuki|dug(j|ni|ok|unk|tam)|kur(j|ni|tam|om))$/,
  /^(ondo|ondot|rape|raper|rapist)$/,
];

// Kifejezések szóközök nélkül (pl. „kapd be", „nyald ki")
const PHRASES = ['kapdbe', 'kapjabe', 'kapjatokbe', 'nyaldki', 'nyaljaki', 'szopdle', 'anyadat', 'siegheil', 'heilhitler', 'whitepower'];

// Ártatlan szavak, amelyek egy tiltott tövet tartalmaznak: ezeket a vizsgálat előtt kivesszük
const ALLOW = ['basszus', 'basszgitar', 'nagybasszus', 'szarvas', 'szarny', 'csaszar', 'bazsarozsa'];

// Számok és jelek, amelyekkel betűt szoktak helyettesíteni; a több jelentésűeknél minden változatot nézünk
const LEET = {
  '@': ['a'], '4': ['a'], '^': ['a'], '3': ['e'], '€': ['e'], '&': ['e'], '0': ['o'], '1': ['i', 'l'],
  '!': ['i', 'l'], '|': ['i', 'l'], '¡': ['i'], '5': ['s'], '$': ['s'], '§': ['s'], '7': ['t'], '+': ['t'],
  '8': ['b'], '9': ['g'], '6': ['g'], '2': ['z'], '(': ['c'], '<': ['c'], '¢': ['c'],
};
// Cirill és görög „hasonmás" betűk
const HOMO = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', к: 'k', м: 'm', т: 't', в: 'b', н: 'h', і: 'i',
  ј: 'j', ѕ: 's', α: 'a', ο: 'o', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ß: 'ss',
};
const WILDCARD = /[*#?%_~]/;
const VOWELS = ['a', 'e', 'i', 'o', 'u'];

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Egy (szóközök nélküli) szóból az összes értelmezés: jelek → betűk, „*" → magánhangzó
function readings(token) {
  let out = [''];
  for (const ch of token) {
    let opts;
    if (/[a-z]/.test(ch)) opts = [ch];
    else if (LEET[ch]) opts = LEET[ch];
    else if (WILDCARD.test(ch)) opts = VOWELS;
    else opts = ['']; // pont, kötőjel, egyéb jel: kimarad
    const next = [];
    for (const prefix of out) for (const o of opts) next.push(prefix + o);
    out = next.slice(0, 200);
  }
  return [...new Set(out)];
}

// Írásmód-változatok: w→v, ph→f, q→k, y→i, c→k, ismétlődő betűk összevonása (faaasz → fasz)
function variants(word) {
  const base = word;
  const alt = base.replace(/w/g, 'v').replace(/ph/g, 'f').replace(/q/g, 'k').replace(/y/g, 'i');
  const list = [base, alt, alt.replace(/c(?!s)/g, 'k'), base.replace(/x/g, 'ksz')];
  const out = new Set();
  for (const v of list) {
    out.add(v);
    out.add(v.replace(/(.)\1+/g, '$1'));
  }
  return [...out];
}

function prepare(name) {
  let s = String(name).normalize('NFKC').toLowerCase();
  s = [...s].map((ch) => HOMO[ch] ?? ch).join('');
  s = strip(s).replace(/[​-‏⁠﻿]/g, '');
  for (const w of ALLOW) s = s.split(w).join(' ');
  return s;
}

function tokensOf(s) {
  const raw = s.split(/\s+/).filter(Boolean);
  // az egybetűs (vagy két betűs) darabokat összefűzzük: „f a s z", „fa sz"
  const merged = [];
  for (let i = 0; i < raw.length; i++) {
    const clean = raw[i].replace(/[^a-z0-9@$€!|*#]/g, '');
    if (clean.length <= 2) {
      let j = i;
      let joined = '';
      while (j < raw.length && raw[j].replace(/[^a-z0-9@$€!|*#]/g, '').length <= 2) joined += raw[j++];
      if (j - i > 1) merged.push(joined);
    }
  }
  // két szomszédos szó, ha az egyik rövid (pl. „fa szoszok" → nem, de „fa sz" → igen)
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i].length <= 2 || raw[i + 1].length <= 2) merged.push(raw[i] + raw[i + 1]);
  }
  return { raw, merged };
}

let extra = [];
function setExtraBlocked(list) {
  extra = (Array.isArray(list) ? list : String(list || '').split(','))
    .map((w) => strip(String(w).trim().toLowerCase()).replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3);
}

function wordHit(word) {
  for (const v of variants(word)) {
    if (ROOTS.some((r) => v.includes(r))) return true;
    if (extra.some((r) => v.includes(r))) return true;
  }
  return false;
}

/** true, ha a név trágár / sértő */
function isOffensive(name) {
  const s = prepare(name);
  const { raw, merged } = tokensOf(s);
  for (const t of [...raw, ...merged]) {
    for (const r of readings(t)) {
      if (!r) continue;
      if (wordHit(r)) return true;
    }
  }
  // önálló szavak (ezeknél a szóhatár számít)
  for (const t of raw) {
    for (const r of readings(t)) {
      for (const v of variants(r)) if (WORDS.some((re) => re.test(v))) return true;
    }
  }
  // kifejezések és a teljes név szóközök nélkül (csak a hosszabb tövekre, hogy ne legyen téves találat)
  const all = readings(raw.join('').slice(0, 60));
  for (const r of all) {
    for (const v of variants(r)) {
      if (PHRASES.some((p) => v.includes(p))) return true;
      if (ROOTS.some((root) => root.length >= 5 && v.includes(root))) return true;
    }
  }
  if (/1488/.test(s.replace(/\s+/g, ''))) return true;
  return false;
}

/**
 * Ellenőrzi és megtisztítja a csapatnevet.
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
function checkTeamName(input) {
  const name = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  if (!name) return { ok: true, name: 'Kalandor csapat' };
  const letters = (strip(name.normalize('NFKC')).match(/[a-z]/gi) || []).length;
  if (letters < 2) return { ok: false, error: 'A csapatnévben legyen legalább két betű!' };
  if (/https?:|www\.|\.(hu|com|net|org)\b/i.test(name)) return { ok: false, error: 'A csapatnév ne legyen webcím!' };
  if (isOffensive(name)) {
    return { ok: false, error: 'Ez a csapatnév nem megfelelő. Válasszatok egy kulturált nevet, ami kiírható a kivetítőre!' };
  }
  return { ok: true, name };
}

module.exports = { checkTeamName, isOffensive, setExtraBlocked };

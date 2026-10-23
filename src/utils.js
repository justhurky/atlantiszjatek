'use strict';

// Ékezet- és kisbetű-érzéketlen normalizálás: "Platón" == "platon", "Poszeidón" == "POSZEIDON"
function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// expected lehet egy szöveg vagy elfogadott alternatívák tömbje
function sameAnswer(value, expected) {
  const v = normalize(value);
  if (!v) return false;
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((e) => normalize(e) === v);
}

module.exports = { normalize, sameAnswer };

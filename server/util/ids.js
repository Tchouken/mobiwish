'use strict';

const crypto = require('crypto');

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Identifiant court, non sequentiel, sur pour une URL. */
function newId(prefix = '') {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

module.exports = { newId };

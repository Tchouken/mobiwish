'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => {
  throw new HttpError(status, code, message);
};

function cleanText(value, { field, min = 1, max = 500 }) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < min) fail(400, 'invalid_field', `Le champ « ${field} » est obligatoire.`);
  if (text.length > max) fail(400, 'invalid_field', `Le champ « ${field} » est trop long (max ${max} caracteres).`);
  return text;
}

function cleanMultiline(value, { field, min = 1, max = 1200 }) {
  const text = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < min) fail(400, 'invalid_field', `Le champ « ${field} » doit contenir au moins ${min} caracteres.`);
  if (text.length > max) fail(400, 'invalid_field', `Le champ « ${field} » est trop long (max ${max} caracteres).`);
  return text;
}

function cleanEmail(value) {
  const email = String(value ?? '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'invalid_email', 'Adresse e-mail invalide.');
  return email;
}

/** Cle d'unicite : une seule identite par adresse, quelle que soit la casse. */
const normalizeEmail = (email) => String(email).trim().toLowerCase();

module.exports = { HttpError, fail, cleanText, cleanMultiline, cleanEmail, normalizeEmail, EMAIL_RE };

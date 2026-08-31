'use strict';

const crypto = require('crypto');
const config = require('../config');

const DEFAULT_TTL_MS = 16 * 60 * 60 * 1000; // une journee evenementielle

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

/** Jeton de session participant : <id>.<expiration>.<signature> */
function issueToken(participantId, ttlMs = DEFAULT_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = `${participantId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, signature] = parts;
  const expected = sign(`${id}.${exp}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return null;
  return id;
}

function bearer(req) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/** Compare deux codes d'acces sans fuite de temps. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { issueToken, verifyToken, bearer, safeEqual };

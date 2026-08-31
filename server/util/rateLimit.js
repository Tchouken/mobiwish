'use strict';

const { HttpError } = require('./validate');

/**
 * Limiteur en memoire (fenetre glissante), suffisant pour un evenement
 * mono-instance : protege la borne et l'API de vote des envois en rafale.
 */
function rateLimit({ windowMs = 60000, max = 20, keyFn = (req) => req.ip } = {}) {
  const hits = new Map();

  return function limiter(req, res, next) {
    const now = Date.now();
    const key = keyFn(req);
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);

    if (list.length >= max) {
      hits.set(key, list);
      return next(new HttpError(429, 'rate_limited', 'Trop de demandes, merci de patienter quelques instants.'));
    }

    list.push(now);
    hits.set(key, list);

    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return next();
  };
}

module.exports = { rateLimit };

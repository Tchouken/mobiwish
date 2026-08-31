'use strict';

const path = require('path');
require('dotenv').config();

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));
const int = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : fallback);

const dataDir = path.resolve(process.env.DATA_DIR || './data');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/$/, ''),

  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  adminToken: process.env.ADMIN_TOKEN || 'admin',
  kioskToken: process.env.KIOSK_TOKEN || '',

  dataDir,
  dbFile: path.join(dataDir, 'mobiwish.sqlite'),
  mediaDir: path.join(dataDir, 'media'),

  image: {
    provider: (process.env.IMAGE_PROVIDER || 'mock').toLowerCase(),
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    openaiSize: process.env.OPENAI_IMAGE_SIZE || '1024x1024',
    style:
      process.env.IMAGE_STYLE ||
      'illustration editoriale moderne, formes geometriques simples, aplats de couleurs vives dominante orange, fond clair, sans texte',
    timeoutMs: int(process.env.IMAGE_TIMEOUT_MS, 120000),
    // Repli sur le generateur local si le fournisseur distant echoue le jour J
    fallbackToMock: bool(process.env.IMAGE_FALLBACK_MOCK, true),
  },

  // Valeurs par defaut des reglages modifiables en cours de journee depuis /admin
  defaults: {
    event_name: 'leboncoin — L’entreprise de demain',
    question:
      'En 2035, quelle innovation aimeriez-vous voir naitre chez leboncoin pour changer le quotidien de nos utilisateurs ?',
    votes_per_participant: '3',
    voting_open: '1',
    kiosk_open: '1',
    allow_self_vote: '0',
    results_public: '1',
  },

  strictSecret: bool(process.env.STRICT_SECRET, process.env.NODE_ENV === 'production'),
};

if (config.strictSecret && config.sessionSecret === 'dev-secret-change-me') {
  throw new Error('SESSION_SECRET doit etre defini en production.');
}

module.exports = config;

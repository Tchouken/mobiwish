'use strict';

const path = require('path');
require('dotenv').config();

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));
const int = (v, fallback) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

const onVercel = Boolean(process.env.VERCEL);
const dataDir = path.resolve(process.env.DATA_DIR || './data');

// Sur une plateforme serverless, le disque est ephemere et l'application
// tourne sur plusieurs instances : base geree et stockage objet obligatoires.
// Les integrations d'hebergement exposent la chaine de connexion sous des noms
// differents : Neon/Vercel -> DATABASE_URL, Supabase -> POSTGRES_URL.
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const dbDriver = (process.env.DB_DRIVER || (databaseUrl ? 'postgres' : 'sqlite')).toLowerCase();
const storageDriver = (process.env.STORAGE_DRIVER || (onVercel ? 'blob' : 'disk')).toLowerCase();

const config = {
  env: process.env.NODE_ENV || 'development',
  onVercel,
  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${int(process.env.PORT, 3000)}`)).replace(/\/$/, ''),

  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  adminToken: process.env.ADMIN_TOKEN || 'admin',
  kioskToken: process.env.KIOSK_TOKEN || '',

  dataDir,
  dbFile: path.join(dataDir, 'mobiwish.sqlite'),
  mediaDir: path.join(dataDir, 'media'),

  database: {
    driver: dbDriver,
    url: databaseUrl,
    poolMax: int(process.env.DB_POOL_MAX, onVercel ? 1 : 5),
    autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  },

  storage: {
    driver: storageDriver,
    blobToken: process.env.BLOB_READ_WRITE_TOKEN || '',
  },

  // Serverless : pas de tache de fond apres la reponse, et pas de flux SSE
  // durable — la borne demande le rendu, les ecrans interrogent l'API.
  runtime: {
    renderMode: (process.env.RENDER_MODE || (onVercel ? 'request' : 'inline')).toLowerCase(),
    realtime: (process.env.REALTIME || (onVercel ? 'poll' : 'sse')).toLowerCase(),
    pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 5000),
    // Duree de cache CDN des reponses publiques : un pic de votants ne
    // declenche qu'une poignee de requetes vers la base.
    publicCacheSeconds: int(process.env.PUBLIC_CACHE_SECONDS, onVercel ? 3 : 0),
  },

  image: {
    provider: (process.env.IMAGE_PROVIDER || 'mock').toLowerCase(),
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
    openaiSize: process.env.OPENAI_IMAGE_SIZE || '1024x1024',
    openaiQuality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    style:
      process.env.IMAGE_STYLE ||
      'illustration editoriale moderne, formes geometriques simples, aplats de couleurs vives dominante orange, fond clair, sans texte',
    timeoutMs: int(process.env.IMAGE_TIMEOUT_MS, 90000),
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

// Garde-fou : en serverless, SQLite s'ecrirait dans un disque ephemere, non
// partage entre instances — les projets et les votes seraient perdus.
if (config.onVercel && config.database.driver === 'sqlite') {
  throw new Error(
    'Base non configuree : definissez DATABASE_URL (PostgreSQL) — SQLite ne peut pas etre utilise sur un hebergement serverless.'
  );
}
if (config.onVercel && config.storage.driver === 'blob' && !config.storage.blobToken) {
  throw new Error('Stockage non configure : BLOB_READ_WRITE_TOKEN est requis (Vercel Blob).');
}

module.exports = config;

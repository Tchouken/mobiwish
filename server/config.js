'use strict';

const path = require('path');
const crypto = require('crypto');
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

  // A defaut de secret fourni, on en derive un a partir d'une valeur secrete
  // deja presente et stable (chaine de connexion, jeton de stockage) : le meme
  // sur toutes les instances et d'un deploiement a l'autre. Une variable de
  // moins a saisir, sans revenir a un secret connu de tous.
  sessionSecret: process.env.SESSION_SECRET || derivedSecret(databaseUrl, process.env.BLOB_READ_WRITE_TOKEN),
  // Vide = aucun code fixe : le code est defini au premier acces a /admin.
  adminToken: process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== 'admin' ? process.env.ADMIN_TOKEN : '',
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
    // Un store Vercel Blob est cree public ou prive, et ne change pas ensuite.
    // En prive, les fichiers ne sont pas joignables directement par un
    // navigateur : l'application les sert elle-meme (voir /media).
    // `auto` : le mode est decouvert au premier depot puis memorise. Un store
    // prive et un store public s'utilisent alors sans rien declarer.
    blobAccess: ['public', 'private'].includes(String(process.env.BLOB_ACCESS || '').toLowerCase())
      ? String(process.env.BLOB_ACCESS).toLowerCase()
      : 'auto',
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
    // Fournisseur deduit de la cle d'API presente, sauf mention explicite.
    provider: (process.env.IMAGE_PROVIDER || inferredProvider()).toLowerCase(),
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
    openaiSize: process.env.OPENAI_IMAGE_SIZE || '1024x1024',
    openaiQuality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    geminiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    geminiModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    geminiAspect: process.env.GEMINI_IMAGE_ASPECT || '1:1',
    // Bloc « rendu impose » du prompt : c'est le levier de personnalisation
    // graphique cote client (charte, ambiance, technique d'illustration).
    style:
      process.env.IMAGE_STYLE ||
      'illustration vectorielle editoriale, formes geometriques simples et aplats de couleur, ' +
        'composition centree et aeree, fond clair creme. ' +
        'Palette imposee : orange vif dominant (#ff6e14) et ses nuances corail et sable, ' +
        'encre profonde pour les contours, au plus une couleur froide en accent discret.',
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

/**
 * Verifications de configuration. Sur un hebergement serverless, une base
 * SQLite s'ecrirait dans un disque ephemere et non partage : les projets et
 * les votes seraient perdus. Plutot que de planter au demarrage, on collecte
 * ce qui manque — l'application repond alors une page d'installation qui dit
 * exactement quoi ajouter (voir server/app.js).
 */
config.missing = [];

if (config.onVercel && config.database.driver === 'sqlite') {
  config.missing.push({
    key: 'DATABASE_URL',
    label: 'Base de donnees PostgreSQL',
    hint: 'Vercel → Storage → Create Database → Neon (ou Supabase). Utiliser la chaine avec pooling.',
  });
}
if (config.onVercel && config.storage.driver === 'blob' && !config.storage.blobToken) {
  config.missing.push({
    key: 'BLOB_READ_WRITE_TOKEN',
    label: 'Stockage des images',
    hint: 'Vercel → Storage → Create → Blob. Le jeton est injecte automatiquement.',
  });
}
// Le secret de session est derive a defaut d'etre fourni : il ne manque que
// s'il n'existe aucune valeur secrete stable dont le deriver.
if ((config.onVercel || config.strictSecret) && !config.sessionSecret) {
  config.missing.push({
    key: 'SESSION_SECRET',
    label: 'Secret de signature des sessions',
    hint: 'Une chaine aleatoire de 32 caracteres ou plus, propre a l’evenement.',
  });
}

// Hors serverless, une configuration incomplete reste une erreur bloquante :
// mieux vaut refuser de demarrer que servir un evenement mal configure.
if (!config.onVercel && config.missing.length) {
  throw new Error(`Configuration incomplete : ${config.missing.map((m) => m.key).join(', ')}.`);
}

/** Secret stable derive d'une valeur secrete deja fournie par l'hebergeur. */
function derivedSecret() {
  var material = Array.prototype.slice.call(arguments).filter(Boolean).join('|');
  if (!material) return '';
  return crypto.createHash('sha256').update('mobiwish|session|' + material).digest('base64url');
}

/** Fournisseur d'images deduit de la cle d'API presente. */
function inferredProvider() {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}

module.exports = config;

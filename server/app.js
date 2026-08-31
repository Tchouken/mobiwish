'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const { EventHub } = require('./events');
const { Store } = require('./services/store');
const { HttpError } = require('./util/validate');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ db, hub = new EventHub(), logger = console, generate } = {}) {
  const store = new Store(db);
  const app = express();

  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.use('/api/admin', adminRoutes({ store, hub }));
  app.use('/api', apiRoutes({ store, hub, logger, ...(generate ? { generate } : {}) }));

  // Images generees : immuables une fois ecrites (nom de fichier = id du projet)
  app.use(
    '/media',
    express.static(config.mediaDir, { immutable: true, maxAge: '7d', fallthrough: true, index: false })
  );

  // Interfaces
  // `redirect: false` : /kiosk, /vote… sont servis par les routes ci-dessous,
  // sans redirection vers le dossier du meme nom.
  app.use(express.static(PUBLIC_DIR, { index: false, redirect: false, extensions: ['html'] }));
  const page = (dir) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, dir, 'index.html'));
  app.get('/', (req, res) => res.redirect('/vote'));
  app.get('/kiosk', page('kiosk'));
  app.get('/vote', page('vote'));
  app.get('/display', page('display'));
  app.get('/admin', page('admin'));

  app.use((req, res, next) => next(new HttpError(404, 'not_found', 'Ressource introuvable.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error?.(err);
    res.status(status).json({
      error: {
        code: err.code || 'server_error',
        message: status >= 500 ? 'Une erreur inattendue est survenue.' : err.message,
      },
    });
  });

  app.locals.store = store;
  app.locals.hub = hub;
  return app;
}

module.exports = { createApp };

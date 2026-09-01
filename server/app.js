'use strict';

const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const config = require('./config');
const { EventHub } = require('./events');
const { HttpError } = require('./util/validate');
const { setupPage } = require('./services/setupPage');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const { readPrivateBlob } = require('./services/media');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ store, hub = new EventHub(), logger = console, generate } = {}) {
  const app = express();

  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/healthz', (req, res) =>
    res.status(config.missing.length ? 503 : 200).json({
      ok: config.missing.length === 0,
      uptime: process.uptime(),
      database: config.database.driver,
      storage: config.storage.driver,
      missing: config.missing.map((item) => item.key),
    })
  );

  // Ressource obligatoire absente : on l'annonce clairement au lieu de servir
  // une application qui perdrait les projets et les votes.
  if (config.missing.length) {
    app.use((req, res) => {
      res.status(503).set('Cache-Control', 'no-store');
      if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
        return res.json({
          error: {
            code: 'setup_required',
            message: 'Configuration incomplete de l’hebergement.',
            missing: config.missing,
          },
        });
      }
      return res.type('html').send(setupPage(config.missing));
    });
    return app;
  }

  app.use('/api/admin', adminRoutes({ store, hub }));
  app.use('/api', apiRoutes({ store, hub, logger, ...(generate ? { generate } : {}) }));

  // Images generees. Trois cas :
  //  - disque            : servies par l'application ;
  //  - store Blob public : servies directement par le CDN, rien a faire ici ;
  //  - store Blob prive  : relayees ici, car leur URL exige un jeton.
  if (config.storage.driver === 'disk') {
    app.use('/media', express.static(config.mediaDir, { immutable: true, maxAge: '7d', index: false }));
  } else {
    app.get('/media/:file', async (req, res, next) => {
      try {
        const found = await readPrivateBlob(req.params.file);
        if (!found) return next(new HttpError(404, 'not_found', 'Image introuvable.'));

        // Le nom de fichier porte l'identifiant du projet : le contenu ne
        // change jamais. Le CDN garde donc chaque image et ne redemande au
        // stockage qu'une seule fois par region.
        res.set('Content-Type', found.mime);
        res.set('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
        return Readable.fromWeb(found.stream).pipe(res);
      } catch (err) {
        return next(err);
      }
    });
  }

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

'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { safeEqual } = require('../util/auth');
const { HttpError, cleanText, cleanMultiline } = require('../util/validate');
const { adminProject } = require('../services/serialize');
const { rankedLeaderboard } = require('./api');

const BOOLEAN_SETTINGS = ['voting_open', 'kiosk_open', 'allow_self_vote', 'results_public'];
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** Empreinte du code d'acces : le code lui-meme n'est jamais stocke. */
function hashCode(code) {
  return crypto.createHash('sha256').update(`${config.sessionSecret}|admin|${code}`).digest('hex');
}

module.exports = function adminRoutes({ store, hub }) {
  const router = express.Router();

  /**
   * Definition du code d'acces au premier lancement, quand aucun ADMIN_TOKEN
   * n'est fourni par la configuration. Possible seulement tant que
   * l'evenement n'a pas commence : une fois qu'un participant existe, le code
   * ne peut plus etre revendique par un visiteur de passage.
   */
  router.post(
    '/claim',
    route(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (config.adminToken) {
        throw new HttpError(409, 'admin_fixed', 'Le code est fixe par la configuration (ADMIN_TOKEN).');
      }
      if (await store.setting('admin_token_hash', '')) {
        throw new HttpError(409, 'admin_defined', 'Un code d’acces a deja ete defini pour cet evenement.');
      }
      if ((await store.stats()).participants > 0) {
        throw new HttpError(
          409,
          'event_started',
          'L’evenement a deja commence : definissez ADMIN_TOKEN dans la configuration de l’hebergement.'
        );
      }

      const code = cleanText(req.body?.code, { field: 'Code d’acces', min: 6, max: 80 });
      await store.setSettings({ admin_token_hash: hashCode(code) });
      res.status(201).json({ ok: true });
    })
  );

  router.use(
    route(async (req, res, next) => {
      const provided = String(req.get('x-admin-token') || req.query.token || '');
      res.set('Cache-Control', 'no-store');

      const stored = await store.setting('admin_token_hash', '');
      const accepted =
        (config.adminToken && safeEqual(provided, config.adminToken)) ||
        (stored && provided && safeEqual(hashCode(provided), stored));

      if (!accepted) {
        return next(new HttpError(401, 'admin_unauthorized', 'Code d’acces administrateur invalide.'));
      }
      return next();
    })
  );

  router.get(
    '/state',
    route(async (req, res) => {
      const [settings, stats, leaderboard, projects] = await Promise.all([
        store.settings(),
        store.stats(),
        rankedLeaderboard(store, { includeHidden: true }),
        store.gallery({ includeHidden: true, includePending: true }),
      ]);
      res.json({
        settings,
        stats,
        leaderboard,
        projects: projects.map(adminProject),
        voteUrl: `${config.publicUrl}/vote`,
        imageProvider: config.image.provider,
        hosting: {
          database: config.database.driver,
          storage: config.storage.driver,
          realtime: config.runtime.realtime,
          renderMode: config.runtime.renderMode,
        },
      });
    })
  );

  router.put(
    '/settings',
    route(async (req, res) => {
      const patch = {};
      const body = req.body || {};

      if (body.event_name !== undefined) {
        patch.event_name = cleanText(body.event_name, { field: 'Nom de l’evenement', max: 120 });
      }
      if (body.question !== undefined) {
        patch.question = cleanMultiline(body.question, { field: 'Question', min: 10, max: 400 });
      }
      if (body.votes_per_participant !== undefined) {
        const n = Number(body.votes_per_participant);
        if (!Number.isInteger(n) || n < 1 || n > 10) {
          throw new HttpError(400, 'invalid_field', 'Le nombre de votes doit etre compris entre 1 et 10.');
        }
        patch.votes_per_participant = String(n);
      }
      for (const key of BOOLEAN_SETTINGS) {
        if (body[key] !== undefined) patch[key] = body[key] === true || body[key] === '1' || body[key] === 1 ? '1' : '0';
      }

      const settings = await store.setSettings(patch);
      hub.emit('settings:updated', {
        votingOpen: settings.voting_open === '1',
        kioskOpen: settings.kiosk_open === '1',
        resultsPublic: settings.results_public === '1',
        question: settings.question,
      });
      res.json({ settings });
    })
  );

  router.post(
    '/projects/:id/visibility',
    route(async (req, res) => {
      const hidden = req.body?.hidden === true || req.body?.hidden === '1';
      if (!(await store.setProjectHidden(req.params.id, hidden))) {
        throw new HttpError(404, 'not_found', 'Projet introuvable.');
      }
      hub.emit('project:updated', { id: req.params.id, hidden });
      res.json({ ok: true, hidden });
    })
  );

  router.delete(
    '/projects/:id',
    route(async (req, res) => {
      if (!(await store.deleteProject(req.params.id))) {
        throw new HttpError(404, 'not_found', 'Projet introuvable.');
      }
      hub.emit('project:deleted', { id: req.params.id });
      res.json({ ok: true });
    })
  );

  /** Export CSV : projets, auteurs (nom complet + e-mail) et votes obtenus. */
  router.get(
    '/export.csv',
    route(async (req, res) => {
      const rows = await store.exportRows();
      const header = ['id', 'date', 'prenom', 'nom', 'email', 'titre', 'reponse', 'votes', 'statut', 'masque', 'fournisseur', 'image'];
      const csv = [header.join(';')]
        .concat(
          rows.map((r) =>
            [
              r.id,
              r.created_at,
              r.first_name,
              r.last_name,
              r.email,
              r.title,
              r.answer,
              Number(r.votes || 0),
              r.status,
              Number(r.hidden) ? 'oui' : 'non',
              r.provider || '',
              r.image_url || '',
            ]
              .map(csvCell)
              .join(';')
          )
        )
        .join('\r\n');

      res
        .type('text/csv; charset=utf-8')
        .set('Content-Disposition', 'attachment; filename="mobiwish-projets.csv"')
        .send(`﻿${csv}`);
    })
  );

  router.post(
    '/reset',
    route(async (req, res) => {
      if (req.body?.confirm !== 'RESET') {
        throw new HttpError(400, 'confirm_required', 'Confirmation manquante : envoyez { "confirm": "RESET" }.');
      }
      await store.reset({ keepParticipants: req.body?.keepParticipants === true });
      hub.emit('event:reset', {});
      res.json({ ok: true, stats: await store.stats() });
    })
  );

  return router;
};

/** Echappement CSV + neutralisation des formules (protection tableur). */
function csvCell(value) {
  let text = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

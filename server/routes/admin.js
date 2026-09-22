'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { safeEqual } = require('../util/auth');
const { HttpError, cleanText, cleanMultiline } = require('../util/validate');
const { adminProject } = require('../services/serialize');
const { rankedLeaderboard, PAGE_SIZE, intParam } = require('./api');

const BOOLEAN_SETTINGS = ['voting_open', 'kiosk_open', 'allow_self_vote', 'results_public'];
/** Textes des ecrans, modifiables sans redeploiement. */
const COPY_SETTINGS = {
  kiosk_headline: { field: 'Titre de la borne', max: 120 },
  kiosk_intro: { field: 'Introduction de la borne', max: 400 },
  kiosk_cta: { field: 'Bouton de la borne', max: 40 },
  kiosk_footnote: { field: 'Mention sous le bouton', max: 200 },
  vote_headline: { field: 'Titre de la page de vote', max: 120 },
  vote_intro: { field: 'Introduction de la page de vote', max: 400 },
  display_headline: { field: 'Titre de l’ecran', max: 120 },
  display_intro: { field: 'Introduction de l’ecran', max: 400 },
};
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
      // Tableau des projets pagine et filtre par le serveur : a plusieurs
      // centaines de visions, la console ne recoit que la page affichee, et
      // la recherche porte sur l'evenement entier — pas sur la page en cours.
      const perPage = intParam(req.query.perPage, { fallback: PAGE_SIZE, min: 1, max: 100 });
      const search = String(req.query.q || '').slice(0, 120);
      const scope = { includeHidden: true, includePending: true, search };
      const total = await store.galleryTotal(scope);
      const pages = Math.max(1, Math.ceil(total / perPage));
      // Une page devenue vide (suppressions, recherche affinee) ramene a la
      // derniere page existante plutot qu'a un tableau vide sans explication.
      const page = Math.min(intParam(req.query.page, { fallback: 1, min: 1, max: 100000 }), pages);

      const [settings, stats, leaderboard, projects] = await Promise.all([
        store.settings(),
        store.stats(),
        rankedLeaderboard(store, { includeHidden: true }),
        store.gallery({ ...scope, limit: perPage, offset: (page - 1) * perPage }),
      ]);
      res.json({
        settings,
        stats,
        leaderboard,
        projects: projects.map(adminProject),
        projectsTotal: total,
        page,
        pages,
        perPage,
        search,
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
      for (const [key, rule] of Object.entries(COPY_SETTINGS)) {
        if (body[key] !== undefined) patch[key] = cleanMultiline(body[key], { field: rule.field, min: 2, max: rule.max });
      }
      if (body.max_renders !== undefined) {
        const n = Number(body.max_renders);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          throw new HttpError(400, 'invalid_field', 'Le nombre d’images par vision doit etre compris entre 1 et 5.');
        }
        patch.max_renders = String(n);
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
      const header = [
        'id', 'date', 'prenom', 'nom', 'email', 'titre', 'texte_auteur', 'reformulation_ia',
        'votes', 'statut', 'publie', 'masque', 'fournisseur', 'image',
      ];
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
              r.summary || '',
              Number(r.votes || 0),
              r.status,
              Number(r.published) ? 'oui' : 'non',
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

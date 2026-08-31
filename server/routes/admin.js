'use strict';

const express = require('express');
const config = require('../config');
const { safeEqual } = require('../util/auth');
const { HttpError, cleanText, cleanMultiline } = require('../util/validate');
const { adminProject } = require('../services/serialize');
const { rankedLeaderboard } = require('./api');

const BOOLEAN_SETTINGS = ['voting_open', 'kiosk_open', 'allow_self_vote', 'results_public'];

module.exports = function adminRoutes({ store, hub }) {
  const router = express.Router();

  router.use((req, res, next) => {
    const provided = req.get('x-admin-token') || (req.query.token ?? '');
    if (!safeEqual(provided, config.adminToken)) {
      return next(new HttpError(401, 'admin_unauthorized', 'Code d’acces administrateur invalide.'));
    }
    return next();
  });

  router.get('/state', (req, res) => {
    res.json({
      settings: store.settings(),
      stats: store.stats(),
      leaderboard: rankedLeaderboard(store, { includeHidden: true }),
      projects: store.gallery({ includeHidden: true, includePending: true }).map(adminProject),
      voteUrl: `${config.publicUrl}/vote`,
      imageProvider: config.image.provider,
    });
  });

  router.put('/settings', (req, res, next) => {
    const patch = {};
    const body = req.body || {};

    if (body.event_name !== undefined) patch.event_name = cleanText(body.event_name, { field: 'Nom de l’evenement', max: 120 });
    if (body.question !== undefined) patch.question = cleanMultiline(body.question, { field: 'Question', min: 10, max: 400 });
    if (body.votes_per_participant !== undefined) {
      const n = Number(body.votes_per_participant);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        return next(new HttpError(400, 'invalid_field', 'Le nombre de votes doit etre compris entre 1 et 10.'));
      }
      patch.votes_per_participant = String(n);
    }
    for (const key of BOOLEAN_SETTINGS) {
      if (body[key] !== undefined) patch[key] = body[key] === true || body[key] === '1' || body[key] === 1 ? '1' : '0';
    }

    const settings = store.setSettings(patch);
    hub.emit('settings:updated', {
      votingOpen: settings.voting_open === '1',
      kioskOpen: settings.kiosk_open === '1',
      resultsPublic: settings.results_public === '1',
      question: settings.question,
    });
    return res.json({ settings });
  });

  router.post('/projects/:id/visibility', (req, res, next) => {
    const hidden = req.body?.hidden === true || req.body?.hidden === '1';
    if (!store.setProjectHidden(req.params.id, hidden)) {
      return next(new HttpError(404, 'not_found', 'Projet introuvable.'));
    }
    hub.emit('project:updated', { id: req.params.id, hidden });
    return res.json({ ok: true, hidden });
  });

  router.delete('/projects/:id', (req, res, next) => {
    if (!store.deleteProject(req.params.id)) {
      return next(new HttpError(404, 'not_found', 'Projet introuvable.'));
    }
    hub.emit('project:deleted', { id: req.params.id });
    return res.json({ ok: true });
  });

  /** Export CSV : projets, auteurs (nom complet + e-mail) et votes obtenus. */
  router.get('/export.csv', (req, res) => {
    const rows = store.db
      .prepare(
        `SELECT pr.id, pr.created_at, pr.title, pr.answer, pr.status, pr.hidden, pr.provider,
                pa.first_name, pa.last_name, pa.email,
                (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
         FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
         ORDER BY votes DESC, pr.created_at ASC`
      )
      .all();

    const header = ['id', 'date', 'prenom', 'nom', 'email', 'titre', 'reponse', 'votes', 'statut', 'masque', 'fournisseur'];
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
            r.votes,
            r.status,
            r.hidden ? 'oui' : 'non',
            r.provider || '',
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
  });

  router.post('/reset', (req, res, next) => {
    if (req.body?.confirm !== 'RESET') {
      return next(new HttpError(400, 'confirm_required', 'Confirmation manquante : envoyez { "confirm": "RESET" }.'));
    }
    store.reset({ keepParticipants: req.body?.keepParticipants === true });
    hub.emit('event:reset', {});
    return res.json({ ok: true, stats: store.stats() });
  });

  return router;
};

/** Echappement CSV + neutralisation des formules (protection tableur). */
function csvCell(value) {
  let text = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

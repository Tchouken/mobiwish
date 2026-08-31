'use strict';

const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const { issueToken, verifyToken, bearer, safeEqual } = require('../util/auth');
const { HttpError, cleanText, cleanMultiline, cleanEmail } = require('../util/validate');
const { rateLimit } = require('../util/rateLimit');
const { buildPrompt, buildTitle } = require('../services/prompt');
const { runGeneration } = require('../services/generation');
const { publicProject, ownProject, publicParticipant } = require('../services/serialize');

module.exports = function apiRoutes({ store, hub, generate = runGeneration, logger = console }) {
  const router = express.Router();

  // --- Middlewares --------------------------------------------------------
  function requireParticipant(req, res, next) {
    const id = verifyToken(bearer(req));
    const participant = id && store.participant(id);
    if (!participant) return next(new HttpError(401, 'unauthenticated', 'Merci de vous identifier a nouveau.'));
    req.participant = participant;
    return next();
  }

  function requireKioskAccess(req, res, next) {
    if (!config.kioskToken) return next();
    const provided = req.get('x-kiosk-token') || req.query.kiosk || '';
    if (!safeEqual(provided, config.kioskToken)) {
      return next(new HttpError(403, 'kiosk_forbidden', 'Code borne invalide.'));
    }
    return next();
  }

  // --- Contexte public ----------------------------------------------------
  router.get('/config', (req, res) => {
    const settings = store.settings();
    res.json({
      eventName: settings.event_name,
      question: settings.question,
      votesPerParticipant: store.votesPerParticipant(),
      votingOpen: settings.voting_open === '1',
      kioskOpen: settings.kiosk_open === '1',
      allowSelfVote: settings.allow_self_vote === '1',
      resultsPublic: settings.results_public === '1',
      voteUrl: `${config.publicUrl}/vote`,
      stats: store.stats(),
    });
  });

  // --- Identification simple (borne et mobile) ----------------------------
  router.post(
    '/session',
    rateLimit({ windowMs: 60000, max: 30 }),
    (req, res) => {
      const firstName = cleanText(req.body.firstName, { field: 'Prenom', max: 60 });
      const lastName = cleanText(req.body.lastName, { field: 'Nom', max: 60 });
      const email = cleanEmail(req.body.email);

      const participant = store.upsertParticipant({ firstName, lastName, email });
      const token = issueToken(participant.id);
      const ballot = store.ballotOf(participant.id);

      res.status(participant.created ? 201 : 200).json({
        token,
        participant: publicParticipant(participant),
        hasVoted: Boolean(ballot),
        projects: store.projectsOfParticipant(participant.id).map(ownProject),
      });
    }
  );

  router.get('/me', requireParticipant, (req, res) => {
    res.json({
      participant: publicParticipant(req.participant),
      hasVoted: Boolean(store.ballotOf(req.participant.id)),
      votes: store.votesOf(req.participant.id),
      projects: store.projectsOfParticipant(req.participant.id).map(ownProject),
    });
  });

  // --- Borne IA : creation d'un projet ------------------------------------
  router.post(
    '/projects',
    requireKioskAccess,
    requireParticipant,
    rateLimit({ windowMs: 60000, max: 10 }),
    (req, res, next) => {
      if (!store.flag('kiosk_open')) {
        return next(new HttpError(409, 'kiosk_closed', 'La borne est fermee pour le moment.'));
      }

      const answer = cleanMultiline(req.body.answer, { field: 'Reponse', min: 10, max: 1200 });
      const question = store.setting('question', '');
      const project = store.createProject({
        participantId: req.participant.id,
        question,
        answer,
        title: cleanText(req.body.title || buildTitle(answer), { field: 'Titre', max: 90 }),
        prompt: buildPrompt(answer, { question }),
      });

      hub.emit('project:created', { id: project.id, title: project.title });
      // Generation asynchrone : la borne affiche l'ecran d'attente sans bloquer.
      Promise.resolve(generate({ store, hub, project, logger })).catch((err) =>
        logger.error?.(`[image] erreur non geree: ${err.message}`)
      );

      return res.status(201).json({ project: ownProject(project) });
    }
  );

  router.get('/projects/:id', (req, res, next) => {
    const project = store.project(req.params.id);
    if (!project) return next(new HttpError(404, 'not_found', 'Projet introuvable.'));
    const isOwner = verifyToken(bearer(req)) === project.participant_id;
    if (!isOwner && (project.hidden || project.status !== 'ready')) {
      return next(new HttpError(404, 'not_found', 'Projet introuvable.'));
    }
    return res.json({ project: isOwner ? ownProject(project) : publicProject(project, { showVotes: store.flag('results_public') }) });
  });

  // --- Galerie ------------------------------------------------------------
  router.get('/projects', (req, res) => {
    const showVotes = store.flag('results_public');
    res.json({
      projects: store.gallery().map((row) => publicProject(row, { showVotes })),
      votesPerParticipant: store.votesPerParticipant(),
      votingOpen: store.flag('voting_open'),
    });
  });

  // --- Vote ---------------------------------------------------------------
  router.post('/votes', requireParticipant, rateLimit({ windowMs: 60000, max: 15 }), (req, res, next) => {
    if (!store.flag('voting_open')) {
      return next(new HttpError(409, 'voting_closed', 'Les votes sont fermes.'));
    }
    if (store.ballotOf(req.participant.id)) {
      return next(new HttpError(409, 'already_voted', 'Vous avez deja vote : un seul vote par participant.'));
    }

    const raw = Array.isArray(req.body.projectIds) ? req.body.projectIds : [];
    const projectIds = [...new Set(raw.map((v) => String(v)))];
    const max = store.votesPerParticipant();

    if (projectIds.length === 0) {
      return next(new HttpError(400, 'no_selection', 'Selectionnez au moins un projet.'));
    }
    if (projectIds.length > max) {
      return next(new HttpError(400, 'too_many_votes', `Vous pouvez selectionner ${max} projet(s) au maximum.`));
    }

    const allowSelfVote = store.flag('allow_self_vote');
    for (const id of projectIds) {
      const project = store.project(id);
      if (!project || project.hidden || project.status !== 'ready') {
        return next(new HttpError(400, 'invalid_project', 'Un des projets selectionnes n’est plus disponible.'));
      }
      if (!allowSelfVote && project.participant_id === req.participant.id) {
        return next(new HttpError(400, 'self_vote', 'Vous ne pouvez pas voter pour votre propre projet.'));
      }
    }

    const ballot = store.castBallot(req.participant.id, projectIds);
    hub.emit('vote:cast', { projectIds, voters: store.stats().voters });
    return res.status(201).json({ ballot, hasVoted: true });
  });

  // --- Classement ---------------------------------------------------------
  router.get('/leaderboard', (req, res, next) => {
    if (!store.flag('results_public')) {
      return next(new HttpError(403, 'results_hidden', 'Les resultats seront reveles en fin de journee.'));
    }
    res.json({ leaderboard: rankedLeaderboard(store), stats: store.stats() });
  });

  // --- Temps reel ---------------------------------------------------------
  router.get('/events', (req, res) => {
    hub.subscribe(res);
  });

  // --- QR code du vote mobile --------------------------------------------
  router.get('/qr.svg', async (req, res, next) => {
    try {
      const target = typeof req.query.url === 'string' && /^https?:\/\//.test(req.query.url)
        ? req.query.url
        : `${config.publicUrl}/vote`;
      const svg = await QRCode.toString(target, { type: 'svg', margin: 1, width: 512 });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      next(err);
    }
  });

  return router;
};

/** Classement avec rangs ex aequo (1, 1, 3, …). */
function rankedLeaderboard(store, options = {}) {
  const rows = store.leaderboard(options);
  let rank = 0;
  let previousVotes = null;
  return rows.map((row, index) => {
    const votes = Number(row.votes || 0);
    if (votes !== previousVotes) {
      rank = index + 1;
      previousVotes = votes;
    }
    return {
      rank,
      id: row.id,
      title: row.title,
      answer: row.answer,
      author: `${row.first_name} ${String(row.last_name || '').charAt(0).toUpperCase()}.`.trim(),
      imageUrl: row.image_file ? `/media/${row.image_file}` : null,
      votes,
    };
  });
}

module.exports.rankedLeaderboard = rankedLeaderboard;

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

/** Petit utilitaire : renvoie les erreurs asynchrones a Express. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** Cache CDN des reponses publiques : absorbe les pics de consultation. */
function publicCache(res) {
  const seconds = config.runtime.publicCacheSeconds;
  if (seconds > 0) {
    res.set('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`);
  } else {
    res.set('Cache-Control', 'no-store');
  }
}

module.exports = function apiRoutes({ store, hub, generate = runGeneration, logger = console }) {
  const router = express.Router();

  // --- Middlewares --------------------------------------------------------
  const requireParticipant = route(async (req, res, next) => {
    const id = verifyToken(bearer(req));
    const participant = id && (await store.participant(id));
    if (!participant) throw new HttpError(401, 'unauthenticated', 'Merci de vous identifier a nouveau.');
    req.participant = participant;
    return next();
  });

  function requireKioskAccess(req, res, next) {
    if (!config.kioskToken) return next();
    const provided = req.get('x-kiosk-token') || req.query.kiosk || '';
    if (!safeEqual(provided, config.kioskToken)) {
      return next(new HttpError(403, 'kiosk_forbidden', 'Code borne invalide.'));
    }
    return next();
  }

  // --- Contexte public ----------------------------------------------------
  router.get(
    '/config',
    route(async (req, res) => {
      const [settings, stats, votesPerParticipant] = await Promise.all([
        store.settings(),
        store.stats(),
        store.votesPerParticipant(),
      ]);
      publicCache(res);
      res.json({
        eventName: settings.event_name,
        question: settings.question,
        votesPerParticipant,
        votingOpen: settings.voting_open === '1',
        kioskOpen: settings.kiosk_open === '1',
        allowSelfVote: settings.allow_self_vote === '1',
        resultsPublic: settings.results_public === '1',
        voteUrl: `${config.publicUrl}/vote`,
        realtime: config.runtime.realtime,
        renderMode: config.runtime.renderMode,
        pollIntervalMs: config.runtime.pollIntervalMs,
        stats,
      });
    })
  );

  // --- Identification simple (borne et mobile) ----------------------------
  router.post(
    '/session',
    rateLimit({ windowMs: 60000, max: 30 }),
    route(async (req, res) => {
      const firstName = cleanText(req.body.firstName, { field: 'Prenom', max: 60 });
      const lastName = cleanText(req.body.lastName, { field: 'Nom', max: 60 });
      const email = cleanEmail(req.body.email);

      const participant = await store.upsertParticipant({ firstName, lastName, email });
      const [ballot, projects] = await Promise.all([
        store.ballotOf(participant.id),
        store.projectsOfParticipant(participant.id),
      ]);

      res.set('Cache-Control', 'no-store');
      res.status(participant.created ? 201 : 200).json({
        token: issueToken(participant.id),
        participant: publicParticipant(participant),
        hasVoted: Boolean(ballot),
        projects: projects.map(ownProject),
      });
    })
  );

  router.get(
    '/me',
    requireParticipant,
    route(async (req, res) => {
      const [ballot, votes, projects] = await Promise.all([
        store.ballotOf(req.participant.id),
        store.votesOf(req.participant.id),
        store.projectsOfParticipant(req.participant.id),
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        participant: publicParticipant(req.participant),
        hasVoted: Boolean(ballot),
        votes,
        projects: projects.map(ownProject),
      });
    })
  );

  // --- Borne IA : creation d'un projet ------------------------------------
  router.post(
    '/projects',
    requireKioskAccess,
    requireParticipant,
    rateLimit({ windowMs: 60000, max: 10 }),
    route(async (req, res) => {
      if (!(await store.flag('kiosk_open'))) {
        throw new HttpError(409, 'kiosk_closed', 'La borne est fermee pour le moment.');
      }

      const answer = cleanMultiline(req.body.answer, { field: 'Reponse', min: 10, max: 1200 });
      const question = await store.setting('question', '');
      const inline = config.runtime.renderMode === 'inline';

      const project = await store.createProject({
        participantId: req.participant.id,
        question,
        answer,
        title: cleanText(req.body.title || buildTitle(answer), { field: 'Titre', max: 90 }),
        prompt: buildPrompt(answer, { question }),
        // En mode `inline` le projet est deja pris en charge par ce processus :
        // il ne doit pas etre reclame par un appel a /render.
        status: inline ? 'rendering' : 'generating',
      });

      hub.emit('project:created', { id: project.id, title: project.title });

      if (inline) {
        Promise.resolve(generate({ store, hub, project, logger })).catch((err) =>
          logger.error?.(`[image] erreur non geree: ${err.message}`)
        );
      }

      res.set('Cache-Control', 'no-store');
      res.status(201).json({ project: ownProject(project), renderMode: config.runtime.renderMode });
    })
  );

  /**
   * Rendu de l'image a la demande (hebergement serverless). Idempotent :
   * seul le premier appelant obtient le verrou, les suivants recoivent
   * simplement l'etat courant du projet.
   */
  router.post(
    '/projects/:id/render',
    requireKioskAccess,
    requireParticipant,
    route(async (req, res) => {
      const project = await store.project(req.params.id);
      if (!project) throw new HttpError(404, 'not_found', 'Projet introuvable.');
      if (project.participant_id !== req.participant.id) {
        throw new HttpError(403, 'forbidden', 'Ce projet ne vous appartient pas.');
      }

      res.set('Cache-Control', 'no-store');
      if (project.status === 'ready' || project.status === 'failed') {
        return res.json({ project: ownProject(project) });
      }

      const claimed = await store.claimProjectForRender(project.id);
      if (!claimed) {
        // Un autre appel s'en occupe deja : la borne continue d'interroger.
        return res.status(202).json({ project: ownProject(await store.project(project.id)) });
      }

      const rendered = await generate({ store, hub, project, logger });
      return res.json({ project: ownProject(rendered) });
    })
  );

  router.get(
    '/projects/:id',
    route(async (req, res) => {
      const project = await store.project(req.params.id);
      if (!project) throw new HttpError(404, 'not_found', 'Projet introuvable.');

      const isOwner = verifyToken(bearer(req)) === project.participant_id;
      if (!isOwner && (project.hidden || project.status !== 'ready')) {
        throw new HttpError(404, 'not_found', 'Projet introuvable.');
      }

      res.set('Cache-Control', 'no-store');
      const showVotes = await store.flag('results_public');
      res.json({ project: isOwner ? ownProject(project) : publicProject(project, { showVotes }) });
    })
  );

  // --- Galerie ------------------------------------------------------------
  router.get(
    '/projects',
    route(async (req, res) => {
      const [showVotes, projects, votesPerParticipant, votingOpen] = await Promise.all([
        store.flag('results_public'),
        store.gallery(),
        store.votesPerParticipant(),
        store.flag('voting_open'),
      ]);
      publicCache(res);
      res.json({
        projects: projects.map((row) => publicProject(row, { showVotes })),
        votesPerParticipant,
        votingOpen,
      });
    })
  );

  // --- Vote ---------------------------------------------------------------
  router.post(
    '/votes',
    requireParticipant,
    rateLimit({ windowMs: 60000, max: 15 }),
    route(async (req, res) => {
      if (!(await store.flag('voting_open'))) {
        throw new HttpError(409, 'voting_closed', 'Les votes sont fermes.');
      }
      if (await store.ballotOf(req.participant.id)) {
        throw new HttpError(409, 'already_voted', 'Vous avez deja vote : un seul vote par participant.');
      }

      const raw = Array.isArray(req.body.projectIds) ? req.body.projectIds : [];
      const projectIds = [...new Set(raw.map((v) => String(v)))];
      const max = await store.votesPerParticipant();

      if (projectIds.length === 0) throw new HttpError(400, 'no_selection', 'Selectionnez au moins un projet.');
      if (projectIds.length > max) {
        throw new HttpError(400, 'too_many_votes', `Vous pouvez selectionner ${max} projet(s) au maximum.`);
      }

      const allowSelfVote = await store.flag('allow_self_vote');
      for (const id of projectIds) {
        const project = await store.project(id);
        if (!project || project.hidden || project.status !== 'ready') {
          throw new HttpError(400, 'invalid_project', 'Un des projets selectionnes n’est plus disponible.');
        }
        if (!allowSelfVote && project.participant_id === req.participant.id) {
          throw new HttpError(400, 'self_vote', 'Vous ne pouvez pas voter pour votre propre projet.');
        }
      }

      let ballot;
      try {
        ballot = await store.castBallot(req.participant.id, projectIds);
      } catch (err) {
        // Deux bulletins envoyes en meme temps : la cle primaire tranche.
        if (/unique|duplicate/i.test(err.message)) {
          throw new HttpError(409, 'already_voted', 'Vous avez deja vote : un seul vote par participant.');
        }
        throw err;
      }

      const stats = await store.stats();
      hub.emit('vote:cast', { projectIds, voters: stats.voters });
      res.set('Cache-Control', 'no-store');
      res.status(201).json({ ballot, hasVoted: true });
    })
  );

  // --- Classement ---------------------------------------------------------
  router.get(
    '/leaderboard',
    route(async (req, res) => {
      if (!(await store.flag('results_public'))) {
        throw new HttpError(403, 'results_hidden', 'Les resultats seront reveles en fin de journee.');
      }
      const [leaderboard, stats] = await Promise.all([rankedLeaderboard(store), store.stats()]);
      publicCache(res);
      res.json({ leaderboard, stats });
    })
  );

  // --- Temps reel (hebergement durable uniquement) ------------------------
  router.get('/events', (req, res, next) => {
    if (config.runtime.realtime !== 'sse') {
      return next(new HttpError(404, 'sse_disabled', 'Flux temps reel indisponible : les clients interrogent l’API.'));
    }
    return hub.subscribe(res);
  });

  // --- QR code du vote mobile --------------------------------------------
  router.get(
    '/qr.svg',
    route(async (req, res) => {
      const target =
        typeof req.query.url === 'string' && /^https?:\/\//.test(req.query.url)
          ? req.query.url
          : `${config.publicUrl}/vote`;
      const svg = await QRCode.toString(target, { type: 'svg', margin: 1, width: 512 });
      res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(svg);
    })
  );

  return router;
};

/** Classement avec rangs ex aequo (1, 1, 3, …). */
async function rankedLeaderboard(store, options = {}) {
  const rows = await store.leaderboard(options);
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
      imageUrl: row.image_url || null,
      votes,
    };
  });
}

module.exports.rankedLeaderboard = rankedLeaderboard;

'use strict';

const config = require('../config');
const { generateImage } = require('./imageProvider');
const { saveImage } = require('./media');

/**
 * Genere l'image d'un projet puis met a jour son statut.
 *
 * Deux declenchements possibles selon l'hebergement :
 *   inline  — lance en tache de fond juste apres la creation (serveur durable) ;
 *   request — declenche par un appel a POST /api/projects/:id/render, car une
 *             fonction serverless est interrompue des qu'elle a repondu.
 * Dans les deux cas la borne interroge /api/projects/:id jusqu'au statut `ready`.
 */
async function runGeneration({ store, hub, project, logger = console }) {
  const start = Date.now();
  try {
    let result;
    try {
      result = await generateImage(project.prompt, { seed: project.id });
    } catch (err) {
      if (config.image.provider !== 'mock' && config.image.fallbackToMock) {
        logger.warn?.(`[image] echec ${config.image.provider} (${err.message}) — repli sur le generateur local`);
        result = await generateImage(project.prompt, { seed: project.id, provider: 'mock' });
      } else {
        throw err;
      }
    }

    const stored = await saveImage({
      id: project.id,
      buffer: result.buffer,
      ext: result.ext,
      mime: result.mime,
    });

    const updated = await store.markProjectReady(project.id, {
      imageUrl: stored.url,
      imageMime: stored.mime,
      provider: result.provider,
    });

    logger.log?.(`[image] projet ${project.id} pret en ${Date.now() - start} ms (${result.provider})`);
    hub?.emit('project:ready', { id: updated.id, title: updated.title, imageUrl: updated.image_url });
    return updated;
  } catch (err) {
    logger.error?.(`[image] echec definitif pour ${project.id}: ${err.message}`);
    const failed = await store.markProjectFailed(project.id, err.message);
    hub?.emit('project:failed', { id: project.id });
    return failed;
  }
}

module.exports = { runGeneration };

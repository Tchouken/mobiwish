'use strict';

const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const { generateImage } = require('./imageProvider');

/**
 * Genere l'image d'un projet en tache de fond puis met a jour son statut.
 * La borne reste reactive : elle affiche un ecran d'attente et interroge
 * /api/projects/:id jusqu'au statut `ready`.
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

    const file = `${project.id}.${result.ext}`;
    await fs.mkdir(config.mediaDir, { recursive: true });
    await fs.writeFile(path.join(config.mediaDir, file), result.buffer);

    const updated = store.markProjectReady(project.id, {
      imageFile: file,
      imageMime: result.mime,
      provider: result.provider,
    });

    logger.log?.(`[image] projet ${project.id} pret en ${Date.now() - start} ms (${result.provider})`);
    hub?.emit('project:ready', {
      id: updated.id,
      title: updated.title,
      author: `${updated.first_name} ${String(updated.last_name || '').charAt(0)}.`,
      imageUrl: `/media/${file}`,
    });
    return updated;
  } catch (err) {
    logger.error?.(`[image] echec definitif pour ${project.id}: ${err.message}`);
    const failed = store.markProjectFailed(project.id, err.message);
    hub?.emit('project:failed', { id: project.id });
    return failed;
  }
}

module.exports = { runGeneration };

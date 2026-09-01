'use strict';

/**
 * Verifie que TOUTES les requetes de l'application s'executent sur PostgreSQL
 * et pas seulement sur SQLite. Le moteur utilise ici est PGlite (PostgreSQL
 * compile en WebAssembly) : meme analyseur syntaxique et memes types que la
 * base geree utilisee en production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

const config = require('../server/config');
const { ensureSchema, toPgPlaceholders } = require('../server/db/driver');
const { Store } = require('../server/services/store');

const isRead = (sql) => /^\s*(select|with)\b/i.test(sql);

/** Meme traduction de requetes que le pilote `pg`, sur un moteur embarque. */
async function pgliteDriver() {
  const pg = await PGlite.create();
  const run = async (sql, params = []) => {
    const res = await pg.query(toPgPlaceholders(sql), params);
    return isRead(sql) ? res.rows : { rowCount: res.affectedRows ?? 0 };
  };
  const api = {
    dialect: 'postgres',
    query: run,
    run,
    async tx(fn) {
      await pg.exec('BEGIN');
      try {
        const result = await fn(api);
        await pg.exec('COMMIT');
        return result;
      } catch (err) {
        await pg.exec('ROLLBACK');
        throw err;
      }
    },
    async close() { await pg.close(); },
  };
  return api;
}

test('postgres : schema, projets, votes, classement et export', async (t) => {
  const driver = await pgliteDriver();
  t.after(() => driver.close());

  await ensureSchema(driver);
  const store = new Store(driver, config.defaults);
  await store.seedSettings();

  // Reglages
  assert.equal((await store.settings()).votes_per_participant, '3');
  await store.setSettings({ votes_per_participant: '2', results_public: '1' });
  assert.equal(await store.votesPerParticipant(), 2);
  assert.equal(await store.flag('results_public'), true);

  // Participants : l'e-mail est la cle d'identite
  const first = await store.upsertParticipant({ firstName: 'Lea', lastName: 'Durand', email: 'lea@leboncoin.fr' });
  assert.equal(first.created, true);
  const again = await store.upsertParticipant({ firstName: 'Lea', lastName: 'Durand', email: 'lea@leboncoin.fr' });
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);

  // Projets
  const author = await store.upsertParticipant({ firstName: 'Yanis', lastName: 'Moreau', email: 'yanis@leboncoin.fr' });
  const project = await store.createProject({
    participantId: author.id,
    question: 'Question du jour ?',
    answer: 'Une idee suffisamment longue pour etre acceptee.',
    title: 'Une idee',
    prompt: 'prompt',
  });
  assert.equal(project.status, 'generating');
  assert.equal(project.votes, 0);

  assert.equal(await store.claimProjectForRender(project.id), true);
  assert.equal(await store.claimProjectForRender(project.id), false, 'le verrou ne doit etre pris qu’une fois');

  const ready = await store.markProjectReady(project.id, {
    imageUrl: 'https://blob.example/projets/1.png',
    imageMime: 'image/png',
    provider: 'openai',
  });
  assert.equal(ready.status, 'ready');
  assert.equal((await store.gallery()).length, 1);
  assert.equal((await store.projectsOfParticipant(author.id)).length, 1);

  // Votes : un bulletin par participant, transaction atomique
  await store.castBallot(first.id, [project.id]);
  assert.ok(await store.ballotOf(first.id));
  assert.deepEqual(await store.votesOf(first.id), [project.id]);
  await assert.rejects(() => store.castBallot(first.id, [project.id]), /duplicate|unique/i);

  const board = await store.leaderboard();
  assert.equal(board[0].votes, 1);
  assert.equal(typeof board[0].votes, 'number', 'les compteurs bigint doivent revenir en nombre');

  const stats = await store.stats();
  assert.deepEqual(stats, {
    participants: 2, projects: 1, projectsPending: 0, projectsFailed: 0, projectsHidden: 0, voters: 1, votes: 1,
  });

  // Moderation et export
  assert.equal(await store.setProjectHidden(project.id, true), true);
  assert.equal((await store.gallery()).length, 0);
  assert.equal((await store.gallery({ includeHidden: true })).length, 1);
  await store.setProjectHidden(project.id, false);

  const rows = await store.exportRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'yanis@leboncoin.fr');
  assert.equal(Number(rows[0].votes), 1);

  // Echecs de generation et remise a zero
  const failing = await store.createProject({
    participantId: author.id, question: 'q', answer: 'une autre idee assez longue', title: 't', prompt: 'p',
  });
  await store.markProjectFailed(failing.id, 'fournisseur indisponible');
  assert.equal((await store.project(failing.id)).status, 'failed');
  assert.equal((await store.stats()).projectsFailed, 1);

  assert.equal(await store.deleteProject(failing.id), true);
  await store.reset();
  assert.deepEqual(await store.stats(), {
    participants: 0, projects: 0, projectsPending: 0, projectsFailed: 0, projectsHidden: 0, voters: 0, votes: 0,
  });
});

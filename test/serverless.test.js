'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, identify } = require('./helpers');
const { toPgPlaceholders } = require('../server/db/driver');

const IDEA = 'Une place de marche interne des competences, ouverte a toutes les equipes de l’entreprise.';

test('serverless : le projet attend l’appel de rendu de la borne', async (t) => {
  const server = await startServer({ renderMode: 'request', realtime: 'poll' });
  t.after(() => server.close());

  const { token } = await identify(server);
  const created = await server.request('/api/projects', { method: 'POST', token, body: { answer: IDEA } });
  assert.equal(created.status, 201);
  assert.equal(created.body.project.status, 'generating');
  assert.equal(created.body.renderMode, 'request');

  // Aucune generation tant que /render n'a pas ete appele.
  const before = await server.request(`/api/projects/${created.body.project.id}`, { token });
  assert.equal(before.body.project.status, 'generating');

  const rendered = await server.request(`/api/projects/${created.body.project.id}/render`, { method: 'POST', token });
  assert.equal(rendered.status, 200);
  assert.equal(rendered.body.project.status, 'ready');
  assert.ok(rendered.body.project.imageUrl);

  // Idempotent : un second appel renvoie simplement l'etat courant.
  const again = await server.request(`/api/projects/${created.body.project.id}/render`, { method: 'POST', token });
  assert.equal(again.status, 200);
  assert.equal(again.body.project.status, 'ready');

  const gallery = await server.request('/api/projects');
  assert.equal(gallery.body.projects.length, 1);
});

test('serverless : le rendu est reserve au proprietaire du projet', async (t) => {
  const server = await startServer({ renderMode: 'request', realtime: 'poll' });
  t.after(() => server.close());

  const owner = await identify(server);
  const other = await identify(server);
  const created = await server.request('/api/projects', { method: 'POST', token: owner.token, body: { answer: IDEA } });

  const forbidden = await server.request(`/api/projects/${created.body.project.id}/render`, {
    method: 'POST',
    token: other.token,
  });
  assert.equal(forbidden.status, 403);

  const anonymous = await server.request(`/api/projects/${created.body.project.id}/render`, { method: 'POST' });
  assert.equal(anonymous.status, 401);
});

test('serverless : un seul rendu meme si la borne relance en parallele', async (t) => {
  let calls = 0;
  const server = await startServer({
    renderMode: 'request',
    realtime: 'poll',
    generate: async ({ store, project }) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return store.markProjectReady(project.id, {
        imageUrl: `/media/${project.id}.svg`,
        imageMime: 'image/svg+xml',
        provider: 'mock',
      });
    },
  });
  t.after(() => server.close());

  const { token } = await identify(server);
  const created = await server.request('/api/projects', { method: 'POST', token, body: { answer: IDEA } });
  const id = created.body.project.id;

  const [first, second] = await Promise.all([
    server.request(`/api/projects/${id}/render`, { method: 'POST', token }),
    server.request(`/api/projects/${id}/render`, { method: 'POST', token }),
  ]);

  assert.equal(calls, 1, 'la generation ne doit etre lancee qu’une fois');
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 202]);
});

test('serverless : le flux SSE est desactive, les clients interrogent l’API', async (t) => {
  const server = await startServer({ renderMode: 'request', realtime: 'poll' });
  t.after(() => server.close());

  const config = await server.request('/api/config');
  assert.equal(config.body.realtime, 'poll');
  assert.equal(config.body.renderMode, 'request');
  assert.ok(config.body.pollIntervalMs > 0);

  const sse = await server.request('/api/events');
  assert.equal(sse.status, 404);
  assert.equal(sse.body.error.code, 'sse_disabled');
});

test('dialecte : les marqueurs ? deviennent $1, $2… pour PostgreSQL', () => {
  assert.equal(
    toPgPlaceholders('INSERT INTO votes (id, participant_id, project_id) VALUES (?, ?, ?)'),
    'INSERT INTO votes (id, participant_id, project_id) VALUES ($1, $2, $3)'
  );
  assert.equal(toPgPlaceholders('SELECT * FROM projects WHERE id = ?'), 'SELECT * FROM projects WHERE id = $1');
  assert.equal(toPgPlaceholders('SELECT 1'), 'SELECT 1');
});

test('hebergement incomplet : page d’installation au lieu d’un plantage', async (t) => {
  const config = require('../server/config');
  const { createApp } = require('../server/app');

  const previous = config.missing;
  config.missing = [{ key: 'DATABASE_URL', label: 'Base de donnees', hint: 'Vercel → Storage' }];
  const app = createApp({ store: null, logger: { log() {}, warn() {}, error() {} } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    config.missing = previous;
  });

  const page = await fetch(`${base}/vote`, { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Configuration requise/);

  const api = await fetch(`${base}/api/config`);
  assert.equal(api.status, 503);
  const payload = await api.json();
  assert.equal(payload.error.code, 'setup_required');
  assert.deepEqual(payload.error.missing.map((m) => m.key), ['DATABASE_URL']);

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 503);
  assert.deepEqual((await health.json()).missing, ['DATABASE_URL']);
});

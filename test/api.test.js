'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, identify, createProject } = require('./helpers');

test('identification : cree puis reutilise le participant selon l’e-mail', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const first = await server.request('/api/session', {
    method: 'POST',
    body: { firstName: 'Lea', lastName: 'Durand', email: 'Lea.Durand@leboncoin.fr' },
  });
  assert.equal(first.status, 201);
  assert.ok(first.body.token);
  assert.equal(first.body.participant.displayName, 'Lea D.');

  // Meme adresse, casse differente : meme identite, pas de doublon.
  const second = await server.request('/api/session', {
    method: 'POST',
    body: { firstName: 'Lea', lastName: 'Durand', email: 'lea.durand@leboncoin.fr' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.participant.id, first.body.participant.id);
  assert.equal(server.store.stats().participants, 1);
});

test('identification : refuse un e-mail invalide et un prenom vide', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const badEmail = await server.request('/api/session', {
    method: 'POST',
    body: { firstName: 'Lea', lastName: 'Durand', email: 'pas-un-email' },
  });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.body.error.code, 'invalid_email');

  const noName = await server.request('/api/session', {
    method: 'POST',
    body: { firstName: '   ', lastName: 'Durand', email: 'ok@leboncoin.fr' },
  });
  assert.equal(noName.status, 400);
});

test('borne : cree un projet, genere l’image et l’ajoute a la galerie', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  const created = await createProject(server, token);
  assert.equal(created.status, 201);
  assert.equal(created.body.project.status, 'generating');

  const detail = await server.request(`/api/projects/${created.body.project.id}`);
  assert.equal(detail.body.project.status, 'ready');
  assert.match(detail.body.project.imageUrl, /^\/media\//);

  const media = await fetch(`${server.base}${detail.body.project.imageUrl}`);
  assert.equal(media.status, 200);

  const gallery = await server.request('/api/projects');
  assert.equal(gallery.body.projects.length, 1);
  assert.equal(gallery.body.projects[0].votes, 0);
});

test('borne : refuse une reponse trop courte et exige une session', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  const short = await server.request('/api/projects', { method: 'POST', token, body: { answer: 'court' } });
  assert.equal(short.status, 400);

  const anonymous = await server.request('/api/projects', { method: 'POST', body: { answer: 'Une idee suffisamment longue pour passer.' } });
  assert.equal(anonymous.status, 401);
});

test('borne fermee : la creation de projet est refusee', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  server.store.setSettings({ kiosk_open: '0' });
  const { token } = await identify(server);
  const res = await server.request('/api/projects', {
    method: 'POST',
    token,
    body: { answer: 'Une idee suffisamment longue pour etre acceptee par la borne.' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'kiosk_closed');
});

test('generation en echec : le projet est marque failed et absent de la galerie', async (t) => {
  const server = await startServer({
    generate: ({ store, project }) => store.markProjectFailed(project.id, 'fournisseur indisponible'),
  });
  t.after(() => server.close());

  const { token } = await identify(server);
  const created = await server.request('/api/projects', {
    method: 'POST',
    token,
    body: { answer: 'Une idee suffisamment longue pour declencher la generation.' },
  });
  assert.equal(created.status, 201);

  const own = await server.request(`/api/projects/${created.body.project.id}`, { token });
  assert.equal(own.body.project.status, 'failed');

  const gallery = await server.request('/api/projects');
  assert.equal(gallery.body.projects.length, 0);
});

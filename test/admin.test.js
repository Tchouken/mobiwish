'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, identify, createProject } = require('./helpers');

const ADMIN = process.env.ADMIN_TOKEN || 'test-admin';

test('admin : acces refuse sans code valide', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  assert.equal((await server.request('/api/admin/state')).status, 401);
  assert.equal((await server.request('/api/admin/state', { admin: 'mauvais-code' })).status, 401);
  assert.equal((await server.request('/api/admin/state', { admin: ADMIN })).status, 200);
});

test('admin : met a jour les reglages et valide les bornes', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const ok = await server.request('/api/admin/settings', {
    method: 'PUT',
    admin: ADMIN,
    body: { question: 'Quelle innovation imaginez-vous pour 2035 ?', votes_per_participant: 5, voting_open: false },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.votes_per_participant, '5');
  assert.equal(ok.body.settings.voting_open, '0');

  const config = await server.request('/api/config');
  assert.equal(config.body.question, 'Quelle innovation imaginez-vous pour 2035 ?');
  assert.equal(config.body.votingOpen, false);

  const bad = await server.request('/api/admin/settings', {
    method: 'PUT',
    admin: ADMIN,
    body: { votes_per_participant: 99 },
  });
  assert.equal(bad.status, 400);
});

test('admin : masque puis supprime un projet', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  const created = await createProject(server, token);
  const id = created.body.project.id;

  await server.request(`/api/admin/projects/${id}/visibility`, { method: 'POST', admin: ADMIN, body: { hidden: true } });
  assert.equal((await server.request('/api/projects')).body.projects.length, 0);
  // Le projet masque reste visible dans la console.
  assert.equal((await server.request('/api/admin/state', { admin: ADMIN })).body.projects.length, 1);

  await server.request(`/api/admin/projects/${id}/visibility`, { method: 'POST', admin: ADMIN, body: { hidden: false } });
  assert.equal((await server.request('/api/projects')).body.projects.length, 1);

  const removed = await server.request(`/api/admin/projects/${id}`, { method: 'DELETE', admin: ADMIN });
  assert.equal(removed.status, 200);
  assert.equal((await server.request('/api/projects')).body.projects.length, 0);
  assert.equal((await server.request(`/api/admin/projects/${id}`, { method: 'DELETE', admin: ADMIN })).status, 404);
});

test('admin : export CSV echappe les separateurs et neutralise les formules', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server, { firstName: '=SUM(A1)', lastName: 'Dupont; Test', email: 'export@leboncoin.fr' });
  await createProject(server, token, 'Une idee avec un point-virgule ; et des "guillemets" pour tester l’export.');

  const csv = await server.request('/api/admin/export.csv', { admin: ADMIN, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /"'=SUM\(A1\)"/);
  assert.match(csv.body, /"Dupont; Test"/);
  assert.match(csv.body, /""guillemets""/);
  assert.match(csv.body, /export@leboncoin\.fr/);
});

test('admin : reinitialisation exige une confirmation puis vide l’evenement', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  await createProject(server, token);
  const voter = await identify(server);
  const projectId = (await server.request('/api/projects')).body.projects[0].id;
  await server.request('/api/votes', { method: 'POST', token: voter.token, body: { projectIds: [projectId] } });

  assert.equal((await server.request('/api/admin/reset', { method: 'POST', admin: ADMIN, body: {} })).status, 400);

  const reset = await server.request('/api/admin/reset', { method: 'POST', admin: ADMIN, body: { confirm: 'RESET' } });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body.stats, {
    participants: 0, projects: 0, projectsPending: 0, projectsFailed: 0, projectsHidden: 0, voters: 0, votes: 0,
  });
});

test('QR code : renvoie un SVG pointant vers la page de vote', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const res = await server.request('/api/qr.svg', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(res.body, /<svg/);
});

test('flux temps reel : diffuse la creation de projet et les votes', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const received = [];
  const controller = new AbortController();
  const stream = await fetch(`${server.base}/api/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received.push(decoder.decode(value));
      }
    } catch { /* flux ferme */ }
  })();

  const { token } = await identify(server);
  await createProject(server, token);
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.abort();
  await pump;

  const text = received.join('');
  assert.match(text, /event: project:created/);
  assert.match(text, /event: project:ready/);
});

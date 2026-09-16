'use strict';

/**
 * Titre saisi par l'auteur, validation avant publication, et reprise plafonnee.
 * Ces regles protegent la galerie : rien n'y entre sans qu'un humain l'ait vu.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, identify, createProject } = require('./helpers');

const IDEE = 'Un potager partage sur le toit du siege, cultive et recolte par les equipes elles-memes.';

test('titre : saisi par l’auteur, c’est lui qui s’affiche dans la galerie', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  const created = await createProject(server, token, IDEE, { title: 'Le toit nourricier' });

  const [project] = (await server.request('/api/projects')).body.projects;
  assert.equal(project.title, 'Le toit nourricier');
  assert.ok(project.summary, 'la galerie expose une description');
  assert.equal(project.answer, undefined, 'le texte brut n’est pas expose dans la galerie');
  assert.equal(created.body.project.answer, IDEE, 'l’auteur retrouve son texte d’origine');
});

test('titre : refuse un titre vide ou trop long', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  const empty = await server.request('/api/projects', { method: 'POST', token, body: { answer: IDEE, title: ' ' } });
  assert.equal(empty.status, 400);

  const long = await server.request('/api/projects', {
    method: 'POST',
    token,
    body: { answer: IDEE, title: 'x'.repeat(120) },
  });
  assert.equal(long.status, 400);
});

test('publication : reservee a l’auteur et refusee avant que l’image soit prete', async (t) => {
  const server = await startServer({ renderMode: 'request', realtime: 'poll' });
  t.after(() => server.close());

  const owner = await identify(server);
  const other = await identify(server);
  const created = await server.request('/api/projects', {
    method: 'POST',
    token: owner.token,
    body: { answer: IDEE, title: 'Le toit nourricier' },
  });
  const id = created.body.project.id;

  // L'image n'est pas encore generee en mode « request ».
  const tooEarly = await server.request(`/api/projects/${id}/publish`, { method: 'POST', token: owner.token });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error.code, 'not_ready');

  await server.request(`/api/projects/${id}/render`, { method: 'POST', token: owner.token });

  const stranger = await server.request(`/api/projects/${id}/publish`, { method: 'POST', token: other.token });
  assert.equal(stranger.status, 403);
  assert.equal((await server.request('/api/projects')).body.projects.length, 0);

  const published = await server.request(`/api/projects/${id}/publish`, { method: 'POST', token: owner.token });
  assert.equal(published.status, 200);
  assert.equal((await server.request('/api/projects')).body.projects.length, 1);
});

test('publication : une vision non publiee ne peut pas recevoir de vote', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const author = await identify(server);
  const pending = await createProject(server, author.token, IDEE, { publish: false, title: 'En attente' });

  const voter = await identify(server);
  const res = await server.request('/api/votes', {
    method: 'POST',
    token: voter.token,
    body: { projectIds: [pending.body.project.id] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_project');
});

test('reprise : nouvelle image possible tant que la vision n’est pas publiee', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  const created = await createProject(server, token, IDEE, { publish: false, title: 'Le toit nourricier' });
  const id = created.body.project.id;

  const again = await server.request(`/api/projects/${id}/regenerate`, { method: 'POST', token });
  assert.equal(again.status, 202);
  await server.settled();
  assert.equal((await server.request(`/api/projects/${id}`, { token })).body.project.status, 'ready');

  await server.request(`/api/projects/${id}/publish`, { method: 'POST', token });
  const afterPublish = await server.request(`/api/projects/${id}/regenerate`, { method: 'POST', token });
  assert.equal(afterPublish.status, 409);
  assert.equal(afterPublish.body.error.code, 'already_published');
});

test('reprise : plafonnee par le reglage de l’evenement', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await server.store.setSettings({ max_renders: '2' });
  const { token } = await identify(server);
  const created = await createProject(server, token, IDEE, { publish: false, title: 'Le toit nourricier' });
  const id = created.body.project.id;

  // Une generation a deja eu lieu a la creation : il en reste une.
  const second = await server.request(`/api/projects/${id}/regenerate`, { method: 'POST', token });
  assert.equal(second.status, 202);
  await server.settled();

  const third = await server.request(`/api/projects/${id}/regenerate`, { method: 'POST', token });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'render_limit');
});

test('textes des ecrans : exposes aux interfaces et modifiables depuis la console', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const config = await server.request('/api/config');
  assert.equal(config.body.copy.kioskHeadline, 'Imaginez leboncoin en 2035');
  assert.equal(config.body.copy.kioskCta, 'Créer ma vision');
  assert.equal(config.body.copy.voteHeadline, 'Votez pour leboncoin en 2035');
  assert.ok(config.body.copy.displayIntro.length > 10);

  const updated = await server.request('/api/admin/settings', {
    method: 'PUT',
    admin: process.env.ADMIN_TOKEN || 'test-admin',
    body: { kiosk_cta: 'Imaginer ma vision', vote_headline: 'Votez pour 2035' },
  });
  assert.equal(updated.status, 200);

  const after = await server.request('/api/config');
  assert.equal(after.body.copy.kioskCta, 'Imaginer ma vision');
  assert.equal(after.body.copy.voteHeadline, 'Votez pour 2035');
});

test('QR code : livre avec la configuration, sans dependre d’une requete d’image', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { body } = await server.request('/api/config');
  assert.match(body.voteQr, /^data:image\/svg\+xml;base64,/, 'le QR voyage dans la configuration');

  const svg = Buffer.from(body.voteQr.split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /<svg/);
  assert.ok(svg.length > 500, 'le dessin doit etre complet');

  // La route dediee reste disponible pour l'impression des chevalets.
  const direct = await server.request('/api/qr.svg', { raw: true });
  assert.equal(direct.status, 200);
  assert.match(direct.headers.get('content-type'), /image\/svg\+xml/);
});

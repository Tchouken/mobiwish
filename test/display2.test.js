'use strict';

/**
 * Ecran evenement v2 : diaporama des dernieres visions a gauche, podium a
 * droite. Deux choses peuvent casser silencieusement en production :
 * la page n'est pas servie (route oubliee), ou la galerie ne renvoie plus
 * les visions de la plus recente a la plus ancienne — le diaporama montrerait
 * alors les plus vieilles idees de la journee.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, identify, createProject } = require('./helpers');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('ecran v2 : les cinq interfaces sont servies par l’application', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  for (const page of ['/kiosk', '/vote', '/display', '/display2', '/admin']) {
    const res = await fetch(`${server.base}${page}`, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 200, `${page} doit etre servie`);
    assert.match(res.headers.get('content-type') || '', /text\/html/, `${page} doit renvoyer une page`);
  }
});

test('ecran v2 : la page charge bien ses propres feuilles et scripts', async () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'display2', 'index.html'), 'utf8');
  for (const asset of ['/shared/app.js', '/display2/display2.css', '/display2/display2.js']) {
    assert.ok(html.includes(asset), `la page doit charger ${asset}`);
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, asset)), `fichier manquant : ${asset}`);
  }

  // Les identifiants lus par le script doivent exister dans la page, sans
  // quoi l'ecran reste muet sans lever la moindre erreur.
  const script = fs.readFileSync(path.join(PUBLIC_DIR, 'display2', 'display2.js'), 'utf8');
  for (const match of script.matchAll(/\bel\('([a-z0-9-]+)'\)/g)) {
    assert.ok(html.includes(`id="${match[1]}"`), `identifiant absent de la page : ${match[1]}`);
  }
});

test('ecran v2 : le diaporama recoit les visions de la plus recente a la plus ancienne', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const attendu = [];
  for (const titre of ['La premiere', 'La deuxieme', 'La troisieme']) {
    const { token } = await identify(server);
    const created = await createProject(server, token, `Une idee pour l’entreprise de demain : ${titre}.`, { title: titre });
    attendu.unshift(created.body.project.id);
    await pause(5); // horodatage a la milliseconde : on evite l'egalite parfaite
  }

  const { projects } = (await server.request('/api/projects')).body;
  assert.deepEqual(projects.map((p) => p.id), attendu, 'la plus recente doit ouvrir le diaporama');
});

test('ecran v2 : une vision non validee par son auteur n’apparait pas au diaporama', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { token } = await identify(server);
  const publiee = await createProject(server, token, 'Une idee validee par son auteur, donc publiee.', { title: 'Validee' });
  const other = await identify(server);
  await createProject(server, other.token, 'Une idee dont l’auteur a quitte la borne avant de valider.', {
    title: 'Abandonnee',
    publish: false,
  });

  const { projects } = (await server.request('/api/projects')).body;
  assert.deepEqual(projects.map((p) => p.id), [publiee.body.project.id]);
});

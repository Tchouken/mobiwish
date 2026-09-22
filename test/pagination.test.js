'use strict';

/**
 * Pagination de la galerie et du tableau de la console. A plusieurs
 * centaines de visions, tout envoyer d'un coup rendait la page de vote
 * inutilisable au telephone. Deux pieges sont verrouilles ici : une
 * tranche qui ne correspond pas au total annonce, et une recherche qui ne
 * porterait que sur la page affichee au lieu de l'evenement entier.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const ADMIN = process.env.ADMIN_TOKEN || 'test-admin';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let compteur = 0;

/**
 * Ajoute une vision publiee. On passe par le magasin plutot que par la
 * borne : creer vingt-cinq visions en quelques millisecondes declencherait
 * le limiteur de debit, qui protege justement la borne contre cela.
 */
async function addVision(server, { title, answer = 'Une idee pour l’entreprise de demain.', firstName = 'Camille', lastName = 'Bernard' } = {}) {
  compteur += 1;
  const participant = await server.store.upsertParticipant({
    firstName,
    lastName,
    email: `participant${compteur}@demo.local`,
  });
  const project = await server.store.createProject({
    participantId: participant.id,
    question: 'A quoi ressemblera leboncoin demain ?',
    answer,
    title,
    prompt: answer,
  });
  await server.store.markProjectReady(project.id, {
    imageUrl: `/media/${project.id}.svg`,
    imageMime: 'image/svg+xml',
    provider: 'mock',
  });
  await server.store.publishProject(project.id);
  await pause(3); // horodatage a la milliseconde : on garde un ordre certain
  return project.id;
}

/** `n` visions publiees, de la plus ancienne a la plus recente. */
async function seed(server, n) {
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    ids.push(await addVision(server, { title: `Vision ${String(i).padStart(2, '0')}` }));
  }
  return ids;
}

test('galerie : vingt visions par defaut, avec le total de l’evenement', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await seed(server, 25);

  const { body } = await server.request('/api/projects');
  assert.equal(body.projects.length, 20, 'une tranche par defaut, pas toute la journee');
  assert.equal(body.total, 25, 'le total annonce reste celui de l’evenement');
  assert.equal(body.limit, 20);
  assert.equal(body.offset, 0);
});

test('galerie : les tranches se suivent sans trou ni doublon', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const crees = await seed(server, 25);
  const attendus = [...crees].reverse(); // la galerie va de la plus recente a la plus ancienne

  const premiere = (await server.request('/api/projects?limit=20&offset=0')).body;
  const seconde = (await server.request('/api/projects?limit=20&offset=20')).body;

  assert.equal(seconde.projects.length, 5, 'la derniere tranche ne contient que le reste');
  const tout = [...premiere.projects, ...seconde.projects].map((p) => p.id);
  assert.deepEqual(tout, attendus);
  assert.equal(new Set(tout).size, 25, 'aucun projet n’apparait deux fois');
});

test('galerie : une tranche demesuree ou absurde est ramenee a des bornes sures', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await seed(server, 3);

  assert.equal((await server.request('/api/projects?limit=99999')).body.limit, 500);
  assert.equal((await server.request('/api/projects?limit=0')).body.limit, 1);
  assert.equal((await server.request('/api/projects?limit=abc')).body.limit, 20, 'valeur illisible : tranche par defaut');
  assert.equal((await server.request('/api/projects?offset=-5')).body.offset, 0);
});

test('console : le tableau est pagine et annonce son nombre de pages', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await seed(server, 25);

  const page1 = (await server.request('/api/admin/state', { admin: ADMIN })).body;
  assert.equal(page1.projects.length, 20);
  assert.equal(page1.projectsTotal, 25);
  assert.equal(page1.pages, 2);
  assert.equal(page1.page, 1);

  const page2 = (await server.request('/api/admin/state?page=2', { admin: ADMIN })).body;
  assert.equal(page2.projects.length, 5);
  assert.equal(page2.page, 2);

  const ids = new Set([...page1.projects, ...page2.projects].map((p) => p.id));
  assert.equal(ids.size, 25, 'les deux pages couvrent l’evenement sans doublon');
});

test('console : une page au-dela du dernier projet ramene a la derniere page', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await seed(server, 25);

  const { body } = await server.request('/api/admin/state?page=99', { admin: ADMIN });
  assert.equal(body.page, 2, 'la console ne reste pas devant un tableau vide inexplique');
  assert.equal(body.projects.length, 5);
});

test('console : la recherche porte sur tout l’evenement, pas sur la page affichee', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // « Le toit nourricier » est cree en premier : il se retrouve en derniere page.
  const potager = await addVision(server, {
    title: 'Le toit nourricier',
    answer: 'Un potager partage sur le toit du siege, cultive par les equipes.',
  });
  await seed(server, 24);

  const sansRecherche = (await server.request('/api/admin/state', { admin: ADMIN })).body;
  assert.ok(
    !sansRecherche.projects.some((p) => p.id === potager),
    'le projet vise n’est pas sur la premiere page'
  );

  const trouve = (await server.request('/api/admin/state?q=nourricier', { admin: ADMIN })).body;
  assert.equal(trouve.projectsTotal, 1);
  assert.equal(trouve.pages, 1);
  assert.deepEqual(trouve.projects.map((p) => p.id), [potager]);
});

test('console : la recherche trouve aussi par auteur, sans tenir compte de la casse', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const sien = await addVision(server, {
    title: 'Sa vision',
    answer: 'Une idee portee par une collaboratrice identifiable.',
    firstName: 'Élodie',
    lastName: 'Marchand',
  });
  await seed(server, 5);

  const parNom = (await server.request('/api/admin/state?q=MARCHAND', { admin: ADMIN })).body;
  assert.deepEqual(parNom.projects.map((p) => p.id), [sien]);
});

test('console : une recherche sans resultat renvoie un tableau vide, pas la premiere page', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await seed(server, 5);

  const { body } = await server.request('/api/admin/state?q=zzz-introuvable', { admin: ADMIN });
  assert.equal(body.projectsTotal, 0);
  assert.deepEqual(body.projects, []);
  assert.equal(body.page, 1);
});

test('console : le joker d’une recherche est pris au pied de la lettre', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await seed(server, 3);

  // Sans echappement, « % » remonterait tous les projets de l'evenement.
  const { body } = await server.request('/api/admin/state?q=%25', { admin: ADMIN });
  assert.equal(body.projectsTotal, 0);
});

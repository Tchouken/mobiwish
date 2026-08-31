#!/usr/bin/env node
'use strict';

/**
 * Jeu de donnees de demonstration (repetition avant l'evenement).
 * Usage : npm run seed -- [nombre-de-projets]
 */

const { open } = require('../server/db');
const { Store } = require('../server/services/store');
const { buildPrompt, buildTitle } = require('../server/services/prompt');
const { runGeneration } = require('../server/services/generation');

const IDEAS = [
  'Un atelier de reparation ouvert a tous les collaborateurs, ou chaque objet du bureau reçoit une seconde vie avant d achat neuf.',
  'Une place de marche interne des competences : chacun propose deux heures par mois pour aider une autre equipe.',
  'Des bureaux modulables qui se reconfigurent selon les projets du jour grace a un plan partage en temps reel.',
  'Une IA de mise en relation locale qui rapproche vendeurs et acheteurs du meme quartier pour supprimer les livraisons longues.',
  'Un fonds interne qui finance chaque trimestre trois idees de collaborateurs testees en conditions reelles.',
  'Un tableau de bord de l impact carbone de chaque annonce publiee, visible par les utilisateurs avant l achat.',
  'Une journee par mois sans reunion, dediee a l exploration et au prototypage libre.',
  'Un parcours d integration ou chaque nouvel arrivant publie sa premiere annonce solidaire des la premiere semaine.',
  'Des assistants IA specialises par metier, entraines sur la documentation interne et corriges par les equipes.',
  'Un reseau de points de retrait chez les commercants de quartier pour rendre les echanges plus humains.',
];

const NAMES = [
  ['Camille', 'Bernard'], ['Yanis', 'Moreau'], ['Sofia', 'Petit'], ['Lucas', 'Girard'], ['Nina', 'Roux'],
  ['Adrien', 'Faure'], ['Ines', 'Lambert'], ['Hugo', 'Mercier'], ['Sarah', 'Blanc'], ['Theo', 'Dumas'],
];

async function main() {
  const count = Math.min(Number(process.argv[2]) || 6, IDEAS.length);
  const db = open();
  const store = new Store(db);
  const question = store.setting('question', '');
  const created = [];

  for (let i = 0; i < count; i += 1) {
    const [firstName, lastName] = NAMES[i % NAMES.length];
    const answer = IDEAS[i % IDEAS.length];
    const participant = store.upsertParticipant({
      firstName,
      lastName,
      email: `${firstName}.${lastName}${i}@demo.local`.toLowerCase(),
    });
    const project = store.createProject({
      participantId: participant.id,
      question,
      answer,
      title: buildTitle(answer),
      prompt: buildPrompt(answer, { question }),
    });
    await runGeneration({ store, hub: null, project });
    created.push({ project, participant });
  }

  // Quelques bulletins pour animer le classement.
  created.forEach((entry, index) => {
    const picks = created
      .filter((other) => other.project.id !== entry.project.id)
      .slice(0, ((index * 2) % 3) + 1)
      .map((other) => other.project.id);
    if (picks.length && !store.ballotOf(entry.participant.id)) {
      store.castBallot(entry.participant.id, picks);
    }
  });

  console.log(`${count} projets de demonstration crees.`);
  console.table(store.stats());
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

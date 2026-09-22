'use strict';

/**
 * Reformulation affichee sur l'ecran de validation de la borne : elle
 * s'adresse a l'auteur par son prenom, jamais par « ce collaborateur ».
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const config = require('../server/config');
const { summarizeVision } = require('../server/services/text');

const silent = { log() {}, warn() {}, error() {} };
const VISION = {
  title: 'Le toit nourricier',
  answer: 'Un potager partage sur le toit du siege, cultive par les equipes.',
  question: 'A quoi ressemblera leboncoin demain ?',
};

/** Rejoue un appel a Gemini : renvoie `reply` et capture la requete envoyee. */
async function withGemini(reply, run) {
  const previous = { provider: config.image.provider, key: config.image.geminiKey, fetch: global.fetch };
  config.image.provider = 'gemini';
  config.image.geminiKey = 'test-key';

  const sent = [];
  global.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body).contents[0].parts[0].text);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    return { result: await run(), sent };
  } finally {
    config.image.provider = previous.provider;
    config.image.geminiKey = previous.key;
    global.fetch = previous.fetch;
  }
}

test('reformulation : le prenom de l’auteur est transmis au modele', async () => {
  const { result, sent } = await withGemini('Thibaut imagine un potager sur le toit du siege.', () =>
    summarizeVision({ ...VISION, firstName: 'Thibaut' }, { logger: silent })
  );

  assert.equal(result, 'Thibaut imagine un potager sur le toit du siege.');
  assert.match(sent[0], /Prenom de l’auteur : Thibaut/);
  assert.match(sent[0], /par son prenom/);
});

test('reformulation : une formule impersonnelle est remplacee par le prenom', async () => {
  const { result } = await withGemini('Ce collaborateur imagine un potager sur le toit du siege.', () =>
    summarizeVision({ ...VISION, firstName: 'Camille' }, { logger: silent })
  );

  assert.equal(result, 'Camille imagine un potager sur le toit du siege.');
  assert.doesNotMatch(result, /collaborateur/i);
});

test('reformulation : sans prenom connu, le texte d’origine du modele est conserve', async () => {
  const { result, sent } = await withGemini('Ce collaborateur imagine un potager.', () =>
    summarizeVision(VISION, { logger: silent })
  );

  assert.equal(result, 'Ce collaborateur imagine un potager.');
  assert.doesNotMatch(sent[0], /Prenom de l’auteur/);
});

test('reformulation : sans cle Gemini, aucune reformulation et aucun blocage', async () => {
  const previous = { provider: config.image.provider, key: config.image.geminiKey };
  config.image.provider = 'mock';
  config.image.geminiKey = '';
  try {
    assert.equal(await summarizeVision(VISION, { logger: silent }), null);
  } finally {
    config.image.provider = previous.provider;
    config.image.geminiKey = previous.key;
  }
});

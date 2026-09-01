'use strict';

/**
 * Fournisseurs d'images. Les appels reseau sont simules : les tests
 * verifient la requete envoyee et la lecture de la reponse, en s'appuyant
 * sur la forme reelle observee de l'API (partie `inlineData` en base64).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const config = require('../server/config');
const { generateImage } = require('../server/services/imageProvider');
const { buildPrompt, buildTitle } = require('../server/services/prompt');

/** Remplace fetch le temps d'un test et retient la requete envoyee. */
function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: options?.body ? JSON.parse(options.body) : null });
    return handler(calls.length);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const IMAGE_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('gemini : envoie le prompt et lit l’image renvoyee', async (t) => {
  const previous = { ...config.image };
  config.image.geminiKey = 'cle-de-test';
  config.image.geminiModel = 'gemini-3.1-flash-image';
  config.image.geminiAspect = '1:1';

  const stub = stubFetch(() =>
    jsonResponse(200, {
      candidates: [
        {
          content: {
            parts: [
              { thoughtSignature: 'raisonnement du modele, a ignorer' },
              { inlineData: { mimeType: 'image/jpeg', data: IMAGE_1PX } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    })
  );
  t.after(() => { stub.restore(); Object.assign(config.image, previous); });

  const result = await generateImage('Illustration de test', { provider: 'gemini' });

  assert.equal(result.provider, 'gemini');
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.ext, 'jpg', 'l’extension doit suivre le type MIME renvoye');
  assert.ok(result.buffer.length > 0);

  const [call] = stub.calls;
  assert.match(call.url, /models\/gemini-3\.1-flash-image:generateContent$/);
  assert.equal(call.options.headers['x-goog-api-key'], 'cle-de-test');
  assert.doesNotMatch(call.url, /cle-de-test/, 'la cle ne doit jamais figurer dans l’URL');
  assert.equal(call.body.contents[0].parts[0].text, 'Illustration de test');
  assert.deepEqual(call.body.generationConfig.responseModalities, ['IMAGE']);
  assert.equal(call.body.generationConfig.imageConfig.aspectRatio, '1:1');
});

test('gemini : remonte une erreur exploitable', async (t) => {
  const previous = { ...config.image };
  config.image.geminiKey = 'cle-de-test';

  const cases = [
    { payload: jsonResponse(429, { error: { message: 'Quota depasse' } }), code: 'provider_error', match: /Quota depasse/ },
    { payload: jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }), code: 'provider_blocked', match: /SAFETY/ },
    { payload: jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), code: 'provider_empty', match: /MAX_TOKENS/ },
  ];

  for (const testCase of cases) {
    const stub = stubFetch(() => testCase.payload);
    await assert.rejects(
      () => generateImage('prompt', { provider: 'gemini' }),
      (err) => err.code === testCase.code && testCase.match.test(err.message),
      `code attendu : ${testCase.code}`
    );
    stub.restore();
  }

  config.image.geminiKey = '';
  await assert.rejects(() => generateImage('prompt', { provider: 'gemini' }), /GEMINI_API_KEY/);
  Object.assign(config.image, previous);
});

test('repli : le generateur local prend le relais si le fournisseur echoue', async (t) => {
  const previous = { ...config.image };
  config.image.provider = 'gemini';
  config.image.geminiKey = 'cle-de-test';
  config.image.fallbackToMock = true;

  const stub = stubFetch(() => jsonResponse(503, { error: { message: 'Service indisponible' } }));
  t.after(() => { stub.restore(); Object.assign(config.image, previous); });

  const { runGeneration } = require('../server/services/generation');
  const project = { id: 'prj_test', prompt: 'Illustration de test' };
  const updates = [];
  const store = {
    markProjectReady: async (id, payload) => { updates.push(payload); return { id, ...payload, status: 'ready' }; },
    markProjectFailed: async (id, message) => { updates.push({ failed: message }); return { id, status: 'failed' }; },
  };

  const result = await runGeneration({ store, hub: null, project, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(result.status, 'ready', 'la borne ne doit jamais rester bloquee sur une panne du fournisseur');
  assert.equal(updates[0].provider, 'mock');
});

test('prompt : sujet, interdits, puis rendu impose en dernier', () => {
  const prompt = buildPrompt('Une place de marche interne des competences.', { question: 'Quelle innovation pour 2035 ?' });
  const positions = ['Sujet :', 'Interdits absolus :', 'Rendu impose :'].map((marker) => prompt.indexOf(marker));
  assert.ok(positions.every((p) => p >= 0), 'les trois blocs doivent etre presents');
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, 'l’ordre des blocs conditionne le respect de la charte');
  assert.match(prompt, /aucun texte/);
  assert.match(prompt, /Quelle innovation pour 2035/);

  assert.equal(buildTitle('Une place de marche interne des competences ouverte a tous'), 'Une place de marche interne des competences…');
  assert.equal(buildTitle(''), 'Projet sans titre');
});

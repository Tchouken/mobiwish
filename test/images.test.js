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

/**
 * Stockage objet. Le module @vercel/blob est charge paresseusement par
 * l'application : on le remplace dans le cache de modules pour verifier le
 * comportement sans store reel.
 */
function stubBlobSdk(handlers) {
  const resolved = require.resolve('@vercel/blob');
  const previous = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: handlers };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

test('store Blob prive : l’image est relayee par l’application', async (t) => {
  const previous = { ...config.storage };
  config.storage.driver = 'blob';
  config.storage.blobAccess = 'private';
  config.storage.blobToken = 'jeton-de-test';

  const puts = [];
  const restore = stubBlobSdk({
    put: async (pathname, body, options) => {
      puts.push({ pathname, options });
      return { url: `https://store.private.blob.vercel-storage.com/${pathname}` };
    },
    get: async (pathname, options) => {
      if (!pathname.endsWith('prj_present.png')) return null;
      assert.equal(options.access, 'private');
      assert.equal(options.token, 'jeton-de-test');
      return {
        statusCode: 200,
        blob: { contentType: 'image/png' },
        stream: new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array([137, 80, 78, 71])); controller.close(); },
        }),
      };
    },
  });

  const { saveImage } = require('../server/services/media');
  const saved = await saveImage({ id: 'prj_present', buffer: Buffer.from('x'), ext: 'png', mime: 'image/png' });

  // L'URL privee exigerait un jeton : inutilisable dans une balise <img>.
  assert.equal(saved.url, '/media/prj_present.png');
  assert.equal(puts[0].pathname, 'projects/prj_present.png');
  assert.equal(puts[0].options.access, 'private');

  const { createApp } = require('../server/app');
  const app = createApp({ store: null, logger: { log() {}, warn() {}, error() {} } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    restore();
    Object.assign(config.storage, previous);
  });

  const res = await fetch(`${base}${saved.url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/, 'le CDN doit garder l’image');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, 4);

  const missing = await fetch(`${base}/media/prj_absent.png`);
  assert.equal(missing.status, 404);
});

test('store Blob public : l’URL du CDN est utilisee telle quelle', async (t) => {
  const previous = { ...config.storage };
  config.storage.driver = 'blob';
  config.storage.blobAccess = 'public';

  const restore = stubBlobSdk({
    put: async (pathname, body, options) => {
      assert.equal(options.access, 'public');
      return { url: `https://store.public.blob.vercel-storage.com/${pathname}` };
    },
  });
  t.after(() => { restore(); Object.assign(config.storage, previous); });

  const { saveImage } = require('../server/services/media');
  const saved = await saveImage({ id: 'prj_public', buffer: Buffer.from('x'), ext: 'jpg', mime: 'image/jpeg' });
  assert.match(saved.url, /^https:\/\/store\.public\.blob\.vercel-storage\.com\/projects\/prj_public\.jpg$/);
});

test('store Blob : un mode declare qui ne correspond pas ne bloque pas le depot', async (t) => {
  const previous = { ...config.storage };
  config.storage.driver = 'blob';
  // Le jour J, une variable mal renseignee ne doit pas empecher la borne de
  // publier : on essaie le mode declare, puis l'autre.
  config.storage.blobAccess = 'private';

  const attempts = [];
  const restore = stubBlobSdk({
    put: async (pathname, body, options) => {
      attempts.push(options.access);
      if (options.access === 'private') throw new Error('access must be "public"');
      return { url: `https://store.public.blob.vercel-storage.com/${pathname}` };
    },
  });
  t.after(() => { restore(); Object.assign(config.storage, previous); });

  const { saveImage } = require('../server/services/media');
  const saved = await saveImage({ id: 'prj_mismatch', buffer: Buffer.from('x'), ext: 'jpg', mime: 'image/jpeg' });

  assert.deepEqual(attempts, ['private', 'public'], 'le mode declare est tente en premier');
  assert.match(saved.url, /^https:\/\/store\.public\.blob\.vercel-storage\.com\//);
  assert.equal(saved.access, 'public');

  // Le mode retenu est memorise : le depot suivant n’essaie plus l’autre.
  attempts.length = 0;
  await saveImage({ id: 'prj_second', buffer: Buffer.from('x'), ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(attempts, ['public']);
});

test('store Blob : les deux modes en echec donnent une erreur explicite', async (t) => {
  const previous = { ...config.storage };
  config.storage.driver = 'blob';
  config.storage.blobAccess = 'auto';

  const restore = stubBlobSdk({
    put: async () => { throw new Error('jeton invalide'); },
  });
  t.after(() => { restore(); Object.assign(config.storage, previous); });

  const { saveImage } = require('../server/services/media');
  await assert.rejects(
    () => saveImage({ id: 'prj_ko', buffer: Buffer.from('x'), ext: 'jpg', mime: 'image/jpeg' }),
    (err) => err.code === 'storage_error' && /jeton invalide/.test(err.message)
  );
});

'use strict';

/**
 * Sur Vercel, seules les adresses declarees dans vercel.json atteignent la
 * fonction : tout le reste est cherche dans les fichiers statiques. Une route
 * servie par l'application mais absente de ce fichier renvoie donc un 404 en
 * production alors qu'elle fonctionne en local — c'est exactement ce qui est
 * arrive aux images. Ce test verrouille la correspondance.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const sources = vercel.rewrites.map((rule) => rule.source);

test('routage Vercel : toutes les routes servies par l’application y sont declarees', () => {
  const servedByTheApp = [
    { source: '/api/(.*)', role: 'API publique et console d’animation' },
    { source: '/healthz', role: 'diagnostic de configuration' },
    { source: '/media/(.*)', role: 'images relayees depuis le stockage prive' },
  ];

  for (const route of servedByTheApp) {
    const rule = vercel.rewrites.find((r) => r.source === route.source);
    assert.ok(rule, `route absente de vercel.json : ${route.source} (${route.role})`);
    assert.equal(rule.destination, '/api/index', `${route.source} doit pointer vers la fonction`);
  }
});

test('routage Vercel : les quatre interfaces sont servies en statique', () => {
  for (const page of ['/kiosk', '/vote', '/display', '/admin']) {
    const rule = vercel.rewrites.find((r) => r.source === page);
    assert.ok(rule, `interface absente de vercel.json : ${page}`);
    assert.equal(rule.destination, `${page}/index.html`);
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', 'public', page, 'index.html')),
      `fichier manquant pour ${page}`
    );
  }
  assert.ok(sources.includes('/'), 'la racine doit etre redirigee vers la page de vote');
});

test('routage Vercel : la duree maximale couvre la generation d’image', () => {
  const fn = vercel.functions['api/index.js'];
  assert.ok(fn, 'la fonction api/index.js doit etre declaree');
  assert.ok(fn.maxDuration >= 60, 'une generation d’image peut depasser une minute');
});

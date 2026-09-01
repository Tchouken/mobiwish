#!/usr/bin/env node
'use strict';

/**
 * Verification d'un deploiement, a lancer avant l'evenement.
 * Usage : npm run check -- https://mon-evenement.vercel.app
 */

const target = (process.argv[2] || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

const OK = '✓';
const KO = '✗';
const WARN = '!';
let failures = 0;

function line(mark, label, detail = '') {
  if (mark === KO) failures += 1;
  console.log(`  ${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function get(path, options = {}) {
  const res = await fetch(`${target}${path}`, { redirect: 'manual', ...options });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* page HTML */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function main() {
  console.log(`\nVerification de ${target}\n`);

  const health = await get('/healthz');
  if (health.status === 503 && health.json?.missing?.length) {
    line(KO, 'Configuration', `il manque ${health.json.missing.join(', ')}`);
    console.log('\n  L’application repond la page « Configuration requise » tant que ces');
    console.log('  variables ne sont pas definies dans le projet.\n');
    process.exit(1);
  }
  line(health.status === 200 ? OK : KO, 'Application en ligne', `HTTP ${health.status}`);
  line(OK, 'Base de donnees', health.json?.database || 'inconnue');
  line(OK, 'Stockage des images', health.json?.storage || 'inconnu');

  const config = await get('/api/config');
  if (config.status !== 200) {
    line(KO, 'API de configuration', `HTTP ${config.status}`);
  } else {
    const c = config.json;
    line(OK, 'Evenement', c.eventName);
    line(c.question?.length > 10 ? OK : KO, 'Question de la borne', `${c.question.slice(0, 60)}…`);
    line(OK, 'Votes par participant', String(c.votesPerParticipant));
    line(c.kioskOpen ? OK : WARN, 'Borne', c.kioskOpen ? 'ouverte' : 'fermee');
    line(c.votingOpen ? OK : WARN, 'Votes', c.votingOpen ? 'ouverts' : 'fermes');
    line(OK, 'Mise a jour des ecrans', c.realtime === 'sse' ? 'flux temps reel' : `interrogation ${c.pollIntervalMs} ms`);
    line(OK, 'Generation d’image', c.renderMode === 'request' ? 'a la demande (serverless)' : 'en tache de fond');
    line(
      c.voteUrl.startsWith(target) ? OK : KO,
      'URL du QR code',
      c.voteUrl.startsWith(target) ? c.voteUrl : `${c.voteUrl} — definissez PUBLIC_URL sur ${target}`
    );

    const cache = config.headers.get('cache-control') || '';
    line(
      c.realtime === 'poll' && !/s-maxage=[1-9]/.test(cache) ? WARN : OK,
      'Cache CDN des reponses publiques',
      cache || 'aucun'
    );
  }

  for (const page of ['/kiosk', '/vote', '/display', '/admin']) {
    const res = await get(page);
    line(res.status === 200 ? OK : KO, `Interface ${page}`, `HTTP ${res.status}`);
  }

  const qr = await get('/api/qr.svg');
  line(qr.status === 200 && qr.text.includes('<svg') ? OK : KO, 'QR code du vote mobile');

  const admin = await get('/api/admin/state');
  line(admin.status === 401 ? OK : KO, 'Console d’animation protegee', `HTTP ${admin.status}`);

  console.log(
    failures === 0
      ? '\n  Deploiement pret pour l’evenement.\n'
      : `\n  ${failures} point(s) a corriger avant l’evenement.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  Impossible de joindre ${target} : ${err.message}\n`);
  process.exit(1);
});

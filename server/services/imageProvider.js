'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Fournisseurs d'images.
 * Chaque fournisseur expose : generate(prompt, { seed }) -> { buffer, mime, ext, provider }
 * Ajouter un fournisseur = ajouter une entree dans PROVIDERS.
 */

const PALETTES = [
  ['#ff6e14', '#ffb27a', '#2b1b3d', '#fff3e9'],
  ['#ff6e14', '#ffd166', '#14304a', '#fff8f2'],
  ['#f4511e', '#ff9d6b', '#123f5c', '#fdf1e7'],
  ['#ff6e14', '#7ad0c4', '#20223b', '#f7f4ef'],
  ['#ff8a3d', '#c94f7c', '#241d47', '#fef4ee'],
];

/**
 * Fournisseur local : compose une illustration abstraite deterministe a partir
 * du prompt. Aucune cle d'API requise — sert de mode demo et de repli si le
 * fournisseur distant est indisponible le jour J.
 */
async function mockGenerate(prompt, { seed } = {}) {
  const digest = crypto.createHash('sha256').update(`${seed || ''}${prompt}`).digest();
  let cursor = 0;
  const next = (max) => {
    const value = digest[cursor % digest.length];
    cursor += 1;
    return value % max;
  };

  const palette = PALETTES[next(PALETTES.length)];
  const [primary, secondary, ink, paper] = palette;
  const shapes = [];
  const count = 5 + next(4);

  for (let i = 0; i < count; i += 1) {
    const x = 80 + next(760);
    const y = 80 + next(760);
    const size = 90 + next(320);
    const fill = [primary, secondary, ink][next(3)];
    const opacity = (0.35 + next(50) / 100).toFixed(2);
    const kind = next(3);
    if (kind === 0) {
      shapes.push(`<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${fill}" opacity="${opacity}"/>`);
    } else if (kind === 1) {
      const rot = next(90);
      shapes.push(
        `<rect x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" rx="${next(40)}" fill="${fill}" opacity="${opacity}" transform="rotate(${rot} ${x} ${y})"/>`
      );
    } else {
      shapes.push(
        `<path d="M${x} ${y - size / 2} L${x + size / 2} ${y + size / 2} L${x - size / 2} ${y + size / 2} Z" fill="${fill}" opacity="${opacity}"/>`
      );
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Illustration generee">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${paper}"/>
      <stop offset="100%" stop-color="${secondary}" stop-opacity="0.45"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  ${shapes.join('\n  ')}
  <circle cx="512" cy="512" r="300" fill="none" stroke="${ink}" stroke-width="6" opacity="0.35"/>
</svg>`;

  return { buffer: Buffer.from(svg, 'utf8'), mime: 'image/svg+xml', ext: 'svg', provider: 'mock' };
}

/** Fournisseur OpenAI Images (gpt-image-1). */
async function openaiGenerate(prompt) {
  if (!config.image.openaiKey) {
    const err = new Error('OPENAI_API_KEY absent : impossible de generer l’image.');
    err.code = 'provider_not_configured';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.image.timeoutMs);

  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.image.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.image.openaiModel,
        prompt,
        n: 1,
        size: config.image.openaiSize,
        quality: config.image.openaiQuality,
      }),
      signal: controller.signal,
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(payload?.error?.message || `Erreur fournisseur d’images (HTTP ${res.status}).`);
      err.code = 'provider_error';
      throw err;
    }

    const item = payload?.data?.[0];
    if (item?.b64_json) {
      return { buffer: Buffer.from(item.b64_json, 'base64'), mime: 'image/png', ext: 'png', provider: 'openai' };
    }
    if (item?.url) {
      const img = await fetch(item.url, { signal: controller.signal });
      if (!img.ok) throw new Error('Telechargement de l’image genere impossible.');
      const buffer = Buffer.from(await img.arrayBuffer());
      return { buffer, mime: 'image/png', ext: 'png', provider: 'openai' };
    }
    throw new Error('Reponse inattendue du fournisseur d’images.');
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDERS = { mock: mockGenerate, openai: openaiGenerate };

async function generateImage(prompt, options = {}) {
  const name = (options.provider || config.image.provider || 'mock').toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Fournisseur d’images inconnu : ${name}`);
  return provider(prompt, options);
}

module.exports = { generateImage, PROVIDERS };

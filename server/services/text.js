'use strict';

const config = require('../config');

/**
 * Reformulation de la vision d'un collaborateur : deux phrases claires,
 * affichees dans le detail d'un projet a cote de l'illustration. Le texte
 * d'origine reste conserve tel quel en base et dans l'export.
 *
 * L'echec n'est jamais bloquant : sans reformulation, c'est la reponse
 * d'origine qui s'affiche.
 */
const BRIEF = [
  'Tu reformules la vision d’un collaborateur pour une galerie d’entreprise.',
  'Ecris deux phrases maximum, a la troisieme personne, sans introduction ni guillemets.',
  'Reste fidele a l’idee : n’ajoute aucun element qui n’y figure pas.',
  'Ton neutre et concret, en francais, 320 caracteres maximum.',
].join(' ');

async function summarizeVision({ title, answer, question }, { logger = console } = {}) {
  if (config.image.provider !== 'gemini' || !config.image.geminiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.text.timeoutMs);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.text.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': config.image.geminiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    `${BRIEF}\n\n` +
                    (question ? `Question posee : ${question}\n` : '') +
                    `Titre donne par l’auteur : ${title}\n` +
                    `Texte de l’auteur : ${answer}`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
        }),
        signal: controller.signal,
      }
    );

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn?.(`[texte] reformulation indisponible (HTTP ${res.status})`);
      return null;
    }

    const parts = payload?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((part) => part.text || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text ? text.slice(0, 400) : null;
  } catch (err) {
    logger.warn?.(`[texte] reformulation indisponible (${err.message})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { summarizeVision };

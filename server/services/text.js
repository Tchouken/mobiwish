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
];
/**
 * L'auteur relit ce texte sur la borne avant de publier : on l'appelle par
 * son prenom plutot que par « ce collaborateur ».
 */
const NAMED = 'Designe l’auteur par son prenom, tel quel, sans nom de famille, sans titre et sans le mot « collaborateur ».';
/** Formules impersonnelles a remplacer si le modele les emploie quand meme. */
const IMPERSONAL = /^(ce|cette|le|la)\s+(collaborateur|collaboratrice|salari[ée]e?|employ[ée]e?|auteur|autrice|participante?)\b/i;

async function summarizeVision({ title, answer, question, firstName = '' }, { logger = console } = {}) {
  if (config.image.provider !== 'gemini' || !config.image.geminiKey) return null;

  const author = String(firstName || '').trim();
  const brief = (author ? [...BRIEF, NAMED] : BRIEF).join(' ');
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
                    `${brief}\n\n` +
                    (question ? `Question posee : ${question}\n` : '') +
                    (author ? `Prenom de l’auteur : ${author}\n` : '') +
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

    return text ? withAuthorName(text, author).slice(0, 400) : null;
  } catch (err) {
    logger.warn?.(`[texte] reformulation indisponible (${err.message})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Filet de securite : le prenom prime sur une formule impersonnelle. */
function withAuthorName(text, author) {
  if (!author) return text;
  return text.replace(IMPERSONAL, author);
}

module.exports = { summarizeVision };

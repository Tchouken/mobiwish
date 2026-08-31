'use strict';

const config = require('../config');

const NEGATIVE = 'sans texte, sans logo, sans visage reconnaissable, sans marque deposee';

/** Construit le prompt image a partir de la reponse du collaborateur. */
function buildPrompt(answer, { question, style = config.image.style } = {}) {
  const idea = String(answer).replace(/\s+/g, ' ').trim().slice(0, 700);
  const theme = question ? ` Theme de la journee : ${String(question).replace(/\s+/g, ' ').trim().slice(0, 200)}` : '';
  return [
    `Illustration conceptuelle de l'entreprise de demain representant cette idee : « ${idea} ».`,
    theme,
    ` Style : ${style}.`,
    ` Contraintes : ${NEGATIVE}.`,
  ]
    .join('')
    .trim();
}

/** Titre court derive de la reponse, utilise dans la galerie et le classement. */
function buildTitle(answer) {
  const words = String(answer).replace(/\s+/g, ' ').trim().split(' ');
  let title = words.slice(0, 7).join(' ');
  if (words.length > 7) title += '…';
  title = title.replace(/^[«"'\s]+/, '').replace(/[.,;:!?\s]+$/, '');
  if (!title) title = 'Projet sans titre';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

module.exports = { buildPrompt, buildTitle };

'use strict';

const config = require('../config');

const FORBIDDEN =
  'Interdits absolus : aucun texte, aucun mot, aucune lettre, aucun chiffre, aucune etiquette, ' +
  'aucun logo ni marque deposee, aucun visage de personne reelle.';

/**
 * Construit le prompt image a partir de la reponse du collaborateur.
 *
 * L'ordre des blocs a ete valide sur les modeles d'images actuels : sujet,
 * puis interdits, puis rendu et palette EN DERNIER. Enoncer le style avant
 * les contraintes le diluait — les images derivaient hors de la charte.
 */
function buildPrompt(answer, { question, style = config.image.style } = {}) {
  const idea = String(answer).replace(/\s+/g, ' ').trim().slice(0, 700);
  const theme = question ? String(question).replace(/\s+/g, ' ').trim().slice(0, 200) : '';

  return [
    'Illustration conceptuelle pour une journee creative d’entreprise.',
    theme ? `Theme de la journee : ${theme}` : '',
    `Sujet : ${idea}`,
    FORBIDDEN,
    `Rendu impose : ${style}`,
  ]
    .filter(Boolean)
    .join('\n\n');
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

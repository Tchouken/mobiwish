'use strict';

const fs = require('fs/promises');
const path = require('path');
const config = require('../config');

/**
 * Stockage des images generees.
 *
 *   disk — dossier local, servi par l'application (installation sur place).
 *   blob — Vercel Blob : obligatoire en serverless, ou le disque est
 *          ephemere et non partage entre instances.
 */

async function saveToDisk({ id, buffer, ext, mime }) {
  const file = `${id}.${ext}`;
  await fs.mkdir(config.mediaDir, { recursive: true });
  await fs.writeFile(path.join(config.mediaDir, file), buffer);
  return { url: `/media/${file}`, mime };
}

/** Chemin du fichier dans le store : stable, derive de l'identifiant du projet. */
const blobPath = (file) => `projects/${file}`;

/**
 * Mode d'acces du store, decouvert au premier depot puis retenu : un store
 * Vercel Blob est cree public ou prive, et refuse les depots dans l'autre
 * mode. Plutot que d'imposer une variable de configuration exacte, on essaie
 * et on garde ce qui marche.
 */
let resolved = { declared: null, access: null };

/** La memorisation ne vaut que pour la valeur declaree qui l'a produite. */
function rememberedAccess() {
  return resolved.declared === config.storage.blobAccess ? resolved.access : null;
}

function accessCandidates() {
  const remembered = rememberedAccess();
  if (remembered) return [remembered];
  // Le mode declare est essaye en premier, l'autre ensuite : une declaration
  // qui ne correspond pas au store ne doit pas bloquer la borne le jour J.
  return config.storage.blobAccess === 'private' ? ['private', 'public'] : ['public', 'private'];
}

async function saveToBlob({ id, buffer, ext, mime }) {
  const { put } = require('@vercel/blob');
  const token = config.storage.blobToken;
  const file = `${id}.${ext}`;
  const candidates = accessCandidates();
  let lastError = null;

  for (const access of candidates) {
    try {
      const result = await put(blobPath(file), buffer, {
        access,
        contentType: mime,
        addRandomSuffix: false,
        cacheControlMaxAge: 31536000,
        ...(token ? { token } : {}),
      });

      resolved = { declared: config.storage.blobAccess, access };
      // Store public : l'URL renvoyee est servie directement par le CDN de
      // Vercel. Store prive : elle exige un jeton, donc inutilisable dans une
      // balise <img> — l'application relaie le fichier derriere son adresse.
      return { url: access === 'private' ? `/media/${file}` : result.url, mime, access };
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError ? ` (${lastError.message})` : '';
  const err = new Error(`Depot de l’image impossible dans le stockage objet${detail}.`);
  err.code = 'storage_error';
  err.cause = lastError;
  throw err;
}

/** Mode d'acces retenu pour ce processus (utilise par la route /media). */
const blobAccessInUse = () =>
  rememberedAccess() || (config.storage.blobAccess === 'auto' ? null : config.storage.blobAccess);

/** Lit un fichier du store prive et le renvoie sous forme de flux. */
async function readPrivateBlob(file) {
  const { get } = require('@vercel/blob');
  const token = config.storage.blobToken;
  const result = await get(blobPath(file), { access: 'private', ...(token ? { token } : {}) });
  if (!result || result.statusCode !== 200) return null;
  return { stream: result.stream, mime: result.blob?.contentType || 'application/octet-stream' };
}

async function saveImage(payload) {
  return config.storage.driver === 'blob' ? saveToBlob(payload) : saveToDisk(payload);
}

module.exports = { saveImage, readPrivateBlob, blobAccessInUse };

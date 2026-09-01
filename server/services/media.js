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

async function saveToBlob({ id, buffer, ext, mime }) {
  const { put } = require('@vercel/blob');
  const token = config.storage.blobToken;
  const access = config.storage.blobAccess;
  const file = `${id}.${ext}`;

  const result = await put(blobPath(file), buffer, {
    access,
    contentType: mime,
    addRandomSuffix: false,
    cacheControlMaxAge: 31536000,
    ...(token ? { token } : {}),
  });

  // Store public : l'URL renvoyee est servie directement par le CDN de Vercel.
  // Store prive : elle exige un jeton, donc inutilisable dans une balise
  // <img> — l'application relaie le fichier derriere sa propre adresse.
  return { url: access === 'private' ? `/media/${file}` : result.url, mime };
}

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

module.exports = { saveImage, readPrivateBlob };

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

async function saveToBlob({ id, buffer, ext, mime }) {
  const { put } = require('@vercel/blob');
  const token = config.storage.blobToken;
  const result = await put(`projects/${id}.${ext}`, buffer, {
    access: 'public',
    contentType: mime,
    addRandomSuffix: false,
    ...(token ? { token } : {}),
  });
  return { url: result.url, mime };
}

async function saveImage(payload) {
  return config.storage.driver === 'blob' ? saveToBlob(payload) : saveToDisk(payload);
}

module.exports = { saveImage };

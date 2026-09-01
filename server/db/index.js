'use strict';

const config = require('../config');
const { createDriver, ensureSchema } = require('./driver');
const { Store } = require('../services/store');

/**
 * Point d'entree unique de la couche donnees.
 * Le driver et le store sont memorises au niveau du module : une fonction
 * serverless reutilise la meme connexion entre deux requetes a chaud.
 */
let cached = null;

async function getStore(options = {}) {
  if (!cached) {
    const driver = options.driver || createDriver(config);
    cached = { driver, store: new Store(driver, config.defaults), ready: null };
  }

  if (!cached.ready) {
    cached.ready = (async () => {
      if (config.database.autoMigrate) await ensureSchema(cached.driver);
      await cached.store.seedSettings();
    })();
  }

  await cached.ready;
  return cached.store;
}

async function closeStore() {
  if (cached) {
    await cached.driver.close();
    cached = null;
  }
}

module.exports = { getStore, closeStore, createDriver, ensureSchema };

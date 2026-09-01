'use strict';

/**
 * Point d'entree serverless (Vercel).
 * Le store et l'application sont construits une seule fois par instance :
 * les invocations suivantes reutilisent la connexion a la base.
 */
const { getStore } = require('../server/db');
const { createApp } = require('../server/app');
const { EventHub } = require('../server/events');

let appPromise = null;

function boot() {
  if (!appPromise) {
    appPromise = getStore().then((store) => createApp({ store, hub: new EventHub() }));
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const app = await boot();
  return app(req, res);
};

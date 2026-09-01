'use strict';

/**
 * Point d'entree serverless (Vercel).
 * Le store et l'application sont construits une seule fois par instance :
 * les invocations suivantes reutilisent la connexion a la base.
 */
const config = require('../server/config');
const { getStore } = require('../server/db');
const { createApp } = require('../server/app');
const { EventHub } = require('../server/events');

let appPromise = null;

function boot() {
  if (!appPromise) {
    // Tant qu'une ressource obligatoire manque, l'application sert la page
    // d'installation : inutile — et impossible — d'ouvrir une base.
    appPromise = config.missing.length
      ? Promise.resolve(createApp({ store: null, hub: new EventHub() }))
      : getStore().then((store) => createApp({ store, hub: new EventHub() }));
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const app = await boot();
  return app(req, res);
};

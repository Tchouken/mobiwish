'use strict';

const config = require('./config');
const { open } = require('./db');
const { createApp } = require('./app');
const { EventHub } = require('./events');

const db = open();
const hub = new EventHub();
const app = createApp({ db, hub });

const server = app.listen(config.port, () => {
  console.log(`\n  MobiWish — borne IA & vote mobile`);
  console.log(`  Serveur      : http://localhost:${config.port}`);
  console.log(`  Borne iPad   : ${config.publicUrl}/kiosk`);
  console.log(`  Vote mobile  : ${config.publicUrl}/vote`);
  console.log(`  Ecran        : ${config.publicUrl}/display`);
  console.log(`  Admin        : ${config.publicUrl}/admin`);
  console.log(`  Images       : fournisseur « ${config.image.provider} »\n`);
});

function shutdown(signal) {
  console.log(`\n${signal} recu — arret en cours...`);
  hub.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

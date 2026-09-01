'use strict';

const config = require('./config');
const { getStore, closeStore } = require('./db');
const { createApp } = require('./app');
const { EventHub } = require('./events');

async function main() {
  const store = await getStore();
  const hub = new EventHub();
  const app = createApp({ store, hub });

  const server = app.listen(config.port, () => {
    console.log(`\n  MobiWish — borne IA & vote mobile`);
    console.log(`  Serveur      : http://localhost:${config.port}`);
    console.log(`  Borne iPad   : ${config.publicUrl}/kiosk`);
    console.log(`  Vote mobile  : ${config.publicUrl}/vote`);
    console.log(`  Ecran        : ${config.publicUrl}/display`);
    console.log(`  Admin        : ${config.publicUrl}/admin`);
    console.log(`  Base         : ${config.database.driver}   Images : ${config.storage.driver} / « ${config.image.provider} »\n`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} recu — arret en cours...`);
    hub.close();
    server.close(async () => {
      await closeStore();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

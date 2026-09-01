#!/usr/bin/env node
'use strict';

/**
 * Cree (ou met a jour) le schema de la base cible.
 * Usage : npm run migrate      — utilise DB_DRIVER / DATABASE_URL de l'environnement.
 */
const config = require('../server/config');
const { createDriver, ensureSchema } = require('../server/db/driver');
const { Store } = require('../server/services/store');

async function main() {
  const driver = createDriver(config);
  console.log(`Migration sur ${driver.dialect}${config.database.url ? ' (DATABASE_URL)' : ` (${config.dbFile})`}…`);
  await ensureSchema(driver);
  await new Store(driver, config.defaults).seedSettings();
  await driver.close();
  console.log('Schema a jour.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

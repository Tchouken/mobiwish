'use strict';

/**
 * Migration d'une base deja en service. Les tests qui partent d'une base
 * vierge ne voient pas ce cas : le schema y contient deja toutes les
 * colonnes. C'est pourtant celui de la production, et c'est la qu'un
 * demarrage echoue.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

const config = require('../server/config');
const { ensureSchema, toPgPlaceholders, columnsOf } = require('../server/db/driver');
const { Store } = require('../server/services/store');

const isRead = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);

/** Schema tel qu'il etait avant le titre saisi et la validation humaine. */
const SCHEMA_PRECEDENT = [
  `CREATE TABLE participants (
     id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL,
     email_norm TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`,
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
     question TEXT NOT NULL, answer TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT, provider TEXT,
     image_url TEXT, image_mime TEXT, status TEXT NOT NULL DEFAULT 'generating', error TEXT,
     hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE ballots (participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE, created_at TEXT NOT NULL)`,
  `CREATE TABLE votes (id TEXT PRIMARY KEY,
     participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL, UNIQUE (participant_id, project_id))`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

async function basePrecedente() {
  const pg = await PGlite.create();
  const run = async (sql, params = []) => {
    const res = await pg.query(toPgPlaceholders(sql), params);
    return isRead(sql) ? res.rows : { rowCount: res.affectedRows ?? 0 };
  };
  const driver = { dialect: 'postgres', query: run, run, tx: (fn) => fn(driver), close: () => pg.close() };

  for (const statement of SCHEMA_PRECEDENT) await run(statement);
  await run(`INSERT INTO settings (key, value) VALUES ('event_name', 'Ancien nom conserve')`);
  await run(`INSERT INTO participants (id, first_name, last_name, email, email_norm, created_at, last_seen_at)
             VALUES ('p1', 'Lea', 'Durand', 'lea@leboncoin.fr', 'lea@leboncoin.fr', '2026-09-01', '2026-09-01')`);
  await run(`INSERT INTO projects (id, participant_id, question, answer, title, status, image_url, created_at, updated_at)
             VALUES ('prj1', 'p1', 'q', 'une idee deja publiee', 'Une idee', 'ready', '/media/prj1.jpg', '2026-09-01', '2026-09-01')`);
  await run(`INSERT INTO projects (id, participant_id, question, answer, title, status, created_at, updated_at)
             VALUES ('prj2', 'p1', 'q', 'une idee dont l image a echoue', 'Ratee', 'failed', '2026-09-01', '2026-09-01')`);
  return driver;
}

test('migration : une base deja en service demarre et gagne les nouvelles colonnes', async (t) => {
  const driver = await basePrecedente();
  t.after(() => driver.close());

  await ensureSchema(driver);

  const colonnes = await columnsOf(driver, 'projects');
  for (const attendue of ['summary', 'published', 'render_count']) {
    assert.ok(colonnes.includes(attendue), `colonne manquante apres migration : ${attendue}`);
  }

  const store = new Store(driver, config.defaults);
  await store.seedSettings();

  // Les reglages deja choisis par le client ne sont pas ecrases.
  const settings = await store.settings();
  assert.equal(settings.event_name, 'Ancien nom conserve');
  // Les nouveaux textes arrivent avec leurs valeurs par defaut.
  assert.equal(settings.kiosk_cta, 'Créer ma vision');

  // Les visions deja en ligne le restent ; celle qui a echoue, non.
  const galerie = await store.gallery();
  assert.equal(galerie.length, 1, 'une vision deja publiee ne doit pas disparaitre');
  assert.equal(galerie[0].id, 'prj1');
  assert.equal((await store.stats()).projects, 1);
  assert.equal((await store.stats()).projectsFailed, 1);
});

test('migration : rejouee sans effet sur une base deja a jour', async (t) => {
  const driver = await basePrecedente();
  t.after(() => driver.close());

  await ensureSchema(driver);
  delete driver.__schemaReady; // simule un nouveau demarrage
  await ensureSchema(driver);

  const store = new Store(driver, config.defaults);
  assert.equal((await store.gallery()).length, 1, 'la reprise des donnees ne doit pas etre rejouee');
});

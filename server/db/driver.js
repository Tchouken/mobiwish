'use strict';

const fs = require('fs');
const path = require('path');
const { TABLES, INDEXES, ADDED_COLUMNS } = require('./schema');

/**
 * Acces base de donnees, deux moteurs derriere la meme interface :
 *
 *   sqlite   — un fichier local, pour l'installation sur place (mini-PC, VPS).
 *   postgres — base geree, obligatoire des que l'app tourne en serverless
 *              (Vercel) ou sur plusieurs instances.
 *
 * Les requetes sont ecrites une seule fois avec des marqueurs `?` ;
 * le pilote PostgreSQL les convertit en `$1, $2, …`.
 */

// `pragma` sert a lire la structure d'une table SQLite : c'est une lecture.
const isRead = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);

function toPgPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/** Les compteurs PostgreSQL reviennent en chaine (bigint) : on normalise. */
function numeric(rows, fields) {
  if (!fields || !fields.length) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const field of fields) if (copy[field] !== undefined && copy[field] !== null) copy[field] = Number(copy[field]);
    return copy;
  });
}

function createSqliteDriver({ file }) {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const exec = (sql, params = []) => {
    const stmt = db.prepare(sql);
    if (isRead(sql)) return stmt.all(params);
    const info = stmt.run(params);
    return { rowCount: info.changes };
  };

  const api = {
    dialect: 'sqlite',
    async query(sql, params) { return exec(sql, params); },
    async run(sql, params) { return exec(sql, params); },
    async tx(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn(api);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async close() { db.close(); },
  };

  return api;
}

function createPostgresDriver({ connectionString, max = 3 }) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    // Les bases gerees (Neon, Supabase, RDS) exigent TLS ; leur chaine de
    // certificats n'est pas toujours dans le magasin du runtime serverless.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
  });

  const runOn = async (client, sql, params = []) => {
    const res = await client.query(toPgPlaceholders(sql), params);
    return isRead(sql) ? res.rows : { rowCount: res.rowCount };
  };

  const api = {
    dialect: 'postgres',
    async query(sql, params) { return runOn(pool, sql, params); },
    async run(sql, params) { return runOn(pool, sql, params); },
    async tx(fn) {
      const client = await pool.connect();
      const scoped = {
        dialect: 'postgres',
        query: (sql, params) => runOn(client, sql, params),
        run: (sql, params) => runOn(client, sql, params),
        tx: (inner) => inner(scoped),
      };
      try {
        await client.query('BEGIN');
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };

  return api;
}

function createDriver(config) {
  if (config.database.driver === 'postgres') {
    if (!config.database.url) throw new Error('DATABASE_URL est requis avec DB_DRIVER=postgres.');
    return createPostgresDriver({ connectionString: config.database.url, max: config.database.poolMax });
  }
  return createSqliteDriver({ file: config.dbFile });
}

/** Colonnes existantes d'une table, quel que soit le moteur. */
async function columnsOf(driver, table) {
  if (driver.dialect === 'postgres') {
    const rows = await driver.query('SELECT column_name FROM information_schema.columns WHERE table_name = ?', [table]);
    return rows.map((r) => r.column_name);
  }
  const rows = await driver.query(`PRAGMA table_info(${table})`, []);
  return rows.map((r) => r.name);
}

/**
 * Ajoute les colonnes apparues apres la mise en service. Sans cela, une base
 * deja remplie resterait sur l'ancienne structure et l'application echouerait
 * sur des colonnes inconnues.
 */
async function ensureColumns(driver) {
  const byTable = new Map();
  for (const entry of ADDED_COLUMNS) {
    if (!byTable.has(entry.table)) byTable.set(entry.table, await columnsOf(driver, entry.table));
    if (byTable.get(entry.table).includes(entry.column)) continue;
    await driver.run(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.definition}`);
    // Reprise des donnees existantes, une seule fois : au moment ou la
    // colonne apparait.
    if (entry.backfill) await driver.run(entry.backfill);
  }
}

/** Cree les tables si besoin. Memoise : une seule fois par processus. */
function ensureSchema(driver) {
  if (!driver.__schemaReady) {
    driver.__schemaReady = (async () => {
      // Ordre impose : tables, puis colonnes ajoutees apres coup, puis index.
      // Un index peut porter sur une colonne absente d'une base existante.
      for (const statement of TABLES) await driver.run(statement);
      await ensureColumns(driver);
      for (const statement of INDEXES) await driver.run(statement);
    })();
  }
  return driver.__schemaReady;
}

module.exports = { createDriver, ensureSchema, ensureColumns, columnsOf, toPgPlaceholders, numeric };

'use strict';

/**
 * Schema unique, exprime dans le sous-ensemble SQL commun a SQLite et
 * PostgreSQL. Les horodatages sont des chaines ISO 8601 : elles se trient
 * lexicographiquement de la meme facon sur les deux moteurs.
 */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS participants (
     id            TEXT PRIMARY KEY,
     first_name    TEXT NOT NULL,
     last_name     TEXT NOT NULL,
     email         TEXT NOT NULL,
     email_norm    TEXT NOT NULL UNIQUE,
     created_at    TEXT NOT NULL,
     last_seen_at  TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS projects (
     id             TEXT PRIMARY KEY,
     participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
     question       TEXT NOT NULL,
     answer         TEXT NOT NULL,
     title          TEXT NOT NULL,
     summary        TEXT,
     published      INTEGER NOT NULL DEFAULT 0,
     render_count   INTEGER NOT NULL DEFAULT 0,
     prompt         TEXT,
     provider       TEXT,
     image_url      TEXT,
     image_mime     TEXT,
     status         TEXT NOT NULL DEFAULT 'generating',
     error          TEXT,
     hidden         INTEGER NOT NULL DEFAULT 0,
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS ballots (
     participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
     created_at     TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS votes (
     id             TEXT PRIMARY KEY,
     participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
     project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     created_at     TEXT NOT NULL,
     UNIQUE (participant_id, project_id)
   )`,

  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/**
 * Colonnes ajoutees apres coup. Une base deja en service doit les recevoir
 * sans etre recreee : chaque entree est ajoutee si elle manque.
 */
const ADDED_COLUMNS = [
  { table: 'projects', column: 'summary', definition: 'TEXT' },
  {
    table: 'projects',
    column: 'published',
    definition: 'INTEGER NOT NULL DEFAULT 0',
    // Les visions creees avant l'ecran de validation etaient publiees des que
    // l'image etait prete : elles le restent, sans quoi elles disparaitraient
    // de la galerie au premier demarrage de cette version.
    backfill: "UPDATE projects SET published = 1 WHERE status = 'ready'",
  },
  { table: 'projects', column: 'render_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

/**
 * Index crees APRES l'ajout des colonnes manquantes : certains portent sur
 * des colonnes apparues apres la mise en service, absentes d'une base deja
 * existante au moment ou les tables sont declarees.
 */
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status, hidden, published)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_created ON projects (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_votes_project ON votes (project_id)`,
];

module.exports = { TABLES, INDEXES, ADDED_COLUMNS };

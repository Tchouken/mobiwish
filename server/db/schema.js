'use strict';

/**
 * Schema unique, exprime dans le sous-ensemble SQL commun a SQLite et
 * PostgreSQL. Les horodatages sont des chaines ISO 8601 : elles se trient
 * lexicographiquement de la meme facon sur les deux moteurs.
 */
const STATEMENTS = [
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
  `CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status, hidden)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_created ON projects (created_at)`,

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
  `CREATE INDEX IF NOT EXISTS idx_votes_project ON votes (project_id)`,

  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

module.exports = { STATEMENTS };

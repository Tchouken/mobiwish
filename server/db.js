'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

function open(file = config.dbFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(config.mediaDir, { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  seedSettings(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      id            TEXT PRIMARY KEY,
      first_name    TEXT NOT NULL,
      last_name     TEXT NOT NULL,
      email         TEXT NOT NULL,
      email_norm    TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id             TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      question       TEXT NOT NULL,
      answer         TEXT NOT NULL,
      title          TEXT NOT NULL,
      prompt         TEXT,
      provider       TEXT,
      image_file     TEXT,
      image_mime     TEXT,
      status         TEXT NOT NULL DEFAULT 'generating',
      error          TEXT,
      hidden         INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, hidden);

    CREATE TABLE IF NOT EXISTS ballots (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS votes (
      id             TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at     TEXT NOT NULL,
      UNIQUE (participant_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_votes_project ON votes(project_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function seedSettings(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) insert.run(key, String(value));
  });
  tx(Object.entries(config.defaults));
}

module.exports = { open };

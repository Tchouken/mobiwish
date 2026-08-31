'use strict';

const { newId } = require('../util/ids');
const { normalizeEmail } = require('../util/validate');

const nowIso = () => new Date().toISOString();

class Store {
  constructor(db) {
    this.db = db;
  }

  // --- Reglages -----------------------------------------------------------
  settings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  setting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setSettings(patch) {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    this.db.transaction((entries) => {
      for (const [key, value] of entries) stmt.run(key, String(value));
    })(Object.entries(patch));
    return this.settings();
  }

  flag(key) {
    return this.setting(key, '0') === '1';
  }

  votesPerParticipant() {
    const n = Number(this.setting('votes_per_participant', '3'));
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : 3;
  }

  // --- Participants -------------------------------------------------------
  /** Identification simple : l'e-mail fait office de cle d'identite unique. */
  upsertParticipant({ firstName, lastName, email }) {
    const emailNorm = normalizeEmail(email);
    const existing = this.db.prepare('SELECT * FROM participants WHERE email_norm = ?').get(emailNorm);
    const at = nowIso();

    if (existing) {
      this.db
        .prepare('UPDATE participants SET first_name = ?, last_name = ?, email = ?, last_seen_at = ? WHERE id = ?')
        .run(firstName, lastName, email, at, existing.id);
      return { ...existing, first_name: firstName, last_name: lastName, email, last_seen_at: at, created: false };
    }

    const id = newId('p');
    this.db
      .prepare(
        `INSERT INTO participants (id, first_name, last_name, email, email_norm, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, firstName, lastName, email, emailNorm, at, at);
    return this.participant(id, { created: true });
  }

  participant(id, extra = {}) {
    const row = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
    return row ? { ...row, ...extra } : null;
  }

  // --- Projets ------------------------------------------------------------
  createProject({ participantId, question, answer, title, prompt }) {
    const id = newId('prj');
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (id, participant_id, question, answer, title, prompt, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'generating', ?, ?)`
      )
      .run(id, participantId, question, answer, title, prompt, at, at);
    return this.project(id);
  }

  markProjectReady(id, { imageFile, imageMime, provider }) {
    this.db
      .prepare(
        `UPDATE projects SET status = 'ready', image_file = ?, image_mime = ?, provider = ?, error = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(imageFile, imageMime, provider, nowIso(), id);
    return this.project(id);
  }

  markProjectFailed(id, message) {
    this.db
      .prepare(`UPDATE projects SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(String(message).slice(0, 500), nowIso(), id);
    return this.project(id);
  }

  project(id) {
    return this.db
      .prepare(
        `SELECT pr.*, pa.first_name, pa.last_name,
                (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
         FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
         WHERE pr.id = ?`
      )
      .get(id);
  }

  /** Galerie : projets prets et non masques, du plus recent au plus ancien. */
  gallery({ includeHidden = false, includePending = false } = {}) {
    const statuses = includePending ? "('ready','generating','failed')" : "('ready')";
    return this.db
      .prepare(
        `SELECT pr.*, pa.first_name, pa.last_name,
                (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
         FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
         WHERE pr.status IN ${statuses} ${includeHidden ? '' : 'AND pr.hidden = 0'}
         ORDER BY pr.created_at DESC`
      )
      .all();
  }

  projectsOfParticipant(participantId) {
    return this.db
      .prepare('SELECT * FROM projects WHERE participant_id = ? ORDER BY created_at DESC')
      .all(participantId);
  }

  setProjectHidden(id, hidden) {
    const res = this.db
      .prepare('UPDATE projects SET hidden = ?, updated_at = ? WHERE id = ?')
      .run(hidden ? 1 : 0, nowIso(), id);
    return res.changes > 0;
  }

  deleteProject(id) {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  // --- Votes --------------------------------------------------------------
  ballotOf(participantId) {
    return this.db.prepare('SELECT * FROM ballots WHERE participant_id = ?').get(participantId);
  }

  votesOf(participantId) {
    return this.db
      .prepare('SELECT project_id FROM votes WHERE participant_id = ?')
      .all(participantId)
      .map((r) => r.project_id);
  }

  /**
   * Enregistre le bulletin d'un participant : une seule soumission par
   * personne, dans une transaction unique (aucun vote partiel possible).
   */
  castBallot(participantId, projectIds) {
    const at = nowIso();
    const insertBallot = this.db.prepare('INSERT INTO ballots (participant_id, created_at) VALUES (?, ?)');
    const insertVote = this.db.prepare(
      'INSERT INTO votes (id, participant_id, project_id, created_at) VALUES (?, ?, ?, ?)'
    );
    this.db.transaction(() => {
      insertBallot.run(participantId, at);
      for (const projectId of projectIds) insertVote.run(newId('v'), participantId, projectId, at);
    })();
    return { participantId, projectIds, createdAt: at };
  }

  leaderboard({ limit = 100, includeHidden = false } = {}) {
    return this.db
      .prepare(
        `SELECT pr.id, pr.title, pr.answer, pr.image_file, pr.image_mime, pr.created_at,
                pa.first_name, pa.last_name,
                (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
         FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
         WHERE pr.status = 'ready' ${includeHidden ? '' : 'AND pr.hidden = 0'}
         ORDER BY votes DESC, pr.created_at ASC
         LIMIT ?`
      )
      .all(limit);
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get().n;
    return {
      participants: one('SELECT COUNT(*) AS n FROM participants'),
      projects: one("SELECT COUNT(*) AS n FROM projects WHERE status = 'ready' AND hidden = 0"),
      projectsPending: one("SELECT COUNT(*) AS n FROM projects WHERE status = 'generating'"),
      projectsFailed: one("SELECT COUNT(*) AS n FROM projects WHERE status = 'failed'"),
      projectsHidden: one('SELECT COUNT(*) AS n FROM projects WHERE hidden = 1'),
      voters: one('SELECT COUNT(*) AS n FROM ballots'),
      votes: one('SELECT COUNT(*) AS n FROM votes'),
    };
  }

  reset({ keepParticipants = false } = {}) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM votes').run();
      this.db.prepare('DELETE FROM ballots').run();
      this.db.prepare('DELETE FROM projects').run();
      if (!keepParticipants) this.db.prepare('DELETE FROM participants').run();
    })();
  }
}

module.exports = { Store, nowIso };

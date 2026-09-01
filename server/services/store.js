'use strict';

const { newId } = require('../util/ids');
const { normalizeEmail } = require('../util/validate');

const nowIso = () => new Date().toISOString();

/** Etats d'un projet dont l'image n'est pas encore disponible. */
const PENDING = ['generating', 'rendering'];

const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Toutes les requetes de l'application. Ecrites une seule fois, executees
 * indifferemment sur SQLite (installation sur place) ou PostgreSQL (Vercel).
 */
class Store {
  constructor(driver, defaults = {}) {
    this.db = driver;
    this.defaults = defaults;
  }

  // --- Reglages -----------------------------------------------------------
  async seedSettings() {
    for (const [key, value] of Object.entries(this.defaults)) {
      await this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [
        key,
        String(value),
      ]);
    }
  }

  async settings() {
    const rows = await this.db.query('SELECT key, value FROM settings', []);
    return { ...this.defaults, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  async setting(key, fallback = null) {
    const rows = await this.db.query('SELECT value FROM settings WHERE key = ?', [key]);
    if (rows.length) return rows[0].value;
    return this.defaults[key] !== undefined ? this.defaults[key] : fallback;
  }

  async setSettings(patch) {
    await this.db.tx(async (t) => {
      for (const [key, value] of Object.entries(patch)) {
        await t.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
          [key, String(value)]
        );
      }
    });
    return this.settings();
  }

  async flag(key) {
    return (await this.setting(key, '0')) === '1';
  }

  async votesPerParticipant() {
    const n = Number(await this.setting('votes_per_participant', '3'));
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : 3;
  }

  // --- Participants -------------------------------------------------------
  /** Identification simple : l'e-mail fait office de cle d'identite unique. */
  async upsertParticipant({ firstName, lastName, email }) {
    const emailNorm = normalizeEmail(email);
    const at = nowIso();
    const existing = (await this.db.query('SELECT * FROM participants WHERE email_norm = ?', [emailNorm]))[0];

    if (existing) {
      await this.db.run(
        'UPDATE participants SET first_name = ?, last_name = ?, email = ?, last_seen_at = ? WHERE id = ?',
        [firstName, lastName, email, at, existing.id]
      );
      return { ...existing, first_name: firstName, last_name: lastName, email, last_seen_at: at, created: false };
    }

    const id = newId('p');
    await this.db.run(
      `INSERT INTO participants (id, first_name, last_name, email, email_norm, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, firstName, lastName, email, emailNorm, at, at]
    );
    return { ...(await this.participant(id)), created: true };
  }

  async participant(id) {
    return (await this.db.query('SELECT * FROM participants WHERE id = ?', [id]))[0] || null;
  }

  // --- Projets ------------------------------------------------------------
  async createProject({ participantId, question, answer, title, prompt, status = 'generating' }) {
    const id = newId('prj');
    const at = nowIso();
    await this.db.run(
      `INSERT INTO projects (id, participant_id, question, answer, title, prompt, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, participantId, question, answer, title, prompt, status, at, at]
    );
    return this.project(id);
  }

  /**
   * Reserve un projet pour la generation d'image. Un seul appelant obtient
   * le verrou : indispensable quand plusieurs instances serverless peuvent
   * recevoir la meme demande de rendu.
   */
  async claimProjectForRender(id) {
    const res = await this.db.run(
      `UPDATE projects SET status = 'rendering', updated_at = ? WHERE id = ? AND status = 'generating'`,
      [nowIso(), id]
    );
    return res.rowCount > 0;
  }

  async markProjectReady(id, { imageUrl, imageMime, provider }) {
    await this.db.run(
      `UPDATE projects SET status = 'ready', image_url = ?, image_mime = ?, provider = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
      [imageUrl, imageMime, provider, nowIso(), id]
    );
    return this.project(id);
  }

  async markProjectFailed(id, message) {
    await this.db.run(`UPDATE projects SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [
      String(message).slice(0, 500),
      nowIso(),
      id,
    ]);
    return this.project(id);
  }

  async project(id) {
    const rows = await this.db.query(
      `SELECT pr.*, pa.first_name, pa.last_name,
              (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
       FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
       WHERE pr.id = ?`,
      [id]
    );
    if (!rows.length) return null;
    return { ...rows[0], votes: toInt(rows[0].votes), hidden: toInt(rows[0].hidden) };
  }

  /** Galerie : projets publies, du plus recent au plus ancien. */
  async gallery({ includeHidden = false, includePending = false, limit = 500 } = {}) {
    const statuses = includePending ? ['ready', ...PENDING, 'failed'] : ['ready'];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = await this.db.query(
      `SELECT pr.*, pa.first_name, pa.last_name,
              (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
       FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
       WHERE pr.status IN (${placeholders}) ${includeHidden ? '' : 'AND pr.hidden = 0'}
       ORDER BY pr.created_at DESC
       LIMIT ?`,
      [...statuses, limit]
    );
    return rows.map((row) => ({ ...row, votes: toInt(row.votes), hidden: toInt(row.hidden) }));
  }

  async projectsOfParticipant(participantId) {
    return this.db.query('SELECT * FROM projects WHERE participant_id = ? ORDER BY created_at DESC', [participantId]);
  }

  async setProjectHidden(id, hidden) {
    const res = await this.db.run('UPDATE projects SET hidden = ?, updated_at = ? WHERE id = ?', [
      hidden ? 1 : 0,
      nowIso(),
      id,
    ]);
    return res.rowCount > 0;
  }

  async deleteProject(id) {
    const res = await this.db.run('DELETE FROM projects WHERE id = ?', [id]);
    return res.rowCount > 0;
  }

  // --- Votes --------------------------------------------------------------
  async ballotOf(participantId) {
    return (await this.db.query('SELECT * FROM ballots WHERE participant_id = ?', [participantId]))[0] || null;
  }

  async votesOf(participantId) {
    const rows = await this.db.query('SELECT project_id FROM votes WHERE participant_id = ?', [participantId]);
    return rows.map((r) => r.project_id);
  }

  /**
   * Enregistre le bulletin d'un participant. Le bulletin et ses votes sont
   * ecrits dans une seule transaction : la cle primaire de `ballots` garantit
   * qu'un participant ne peut voter qu'une fois, meme si deux requetes
   * arrivent en parallele sur deux instances.
   */
  async castBallot(participantId, projectIds) {
    const at = nowIso();
    await this.db.tx(async (t) => {
      await t.run('INSERT INTO ballots (participant_id, created_at) VALUES (?, ?)', [participantId, at]);
      for (const projectId of projectIds) {
        await t.run('INSERT INTO votes (id, participant_id, project_id, created_at) VALUES (?, ?, ?, ?)', [
          newId('v'),
          participantId,
          projectId,
          at,
        ]);
      }
    });
    return { participantId, projectIds, createdAt: at };
  }

  async leaderboard({ limit = 100, includeHidden = false } = {}) {
    const rows = await this.db.query(
      `SELECT pr.id, pr.title, pr.answer, pr.image_url, pr.created_at, pa.first_name, pa.last_name,
              (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
       FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
       WHERE pr.status = 'ready' ${includeHidden ? '' : 'AND pr.hidden = 0'}
       ORDER BY votes DESC, pr.created_at ASC
       LIMIT ?`,
      [limit]
    );
    return rows.map((row) => ({ ...row, votes: toInt(row.votes) }));
  }

  async stats() {
    const one = async (sql, params = []) => toInt((await this.db.query(sql, params))[0].n);
    return {
      participants: await one('SELECT COUNT(*) AS n FROM participants'),
      projects: await one("SELECT COUNT(*) AS n FROM projects WHERE status = 'ready' AND hidden = 0"),
      projectsPending: await one("SELECT COUNT(*) AS n FROM projects WHERE status IN ('generating', 'rendering')"),
      projectsFailed: await one("SELECT COUNT(*) AS n FROM projects WHERE status = 'failed'"),
      projectsHidden: await one('SELECT COUNT(*) AS n FROM projects WHERE hidden = 1'),
      voters: await one('SELECT COUNT(*) AS n FROM ballots'),
      votes: await one('SELECT COUNT(*) AS n FROM votes'),
    };
  }

  async exportRows() {
    return this.db.query(
      `SELECT pr.id, pr.created_at, pr.title, pr.answer, pr.status, pr.hidden, pr.provider, pr.image_url,
              pa.first_name, pa.last_name, pa.email,
              (SELECT COUNT(*) FROM votes v WHERE v.project_id = pr.id) AS votes
       FROM projects pr JOIN participants pa ON pa.id = pr.participant_id
       ORDER BY votes DESC, pr.created_at ASC`,
      []
    );
  }

  async reset({ keepParticipants = false } = {}) {
    await this.db.tx(async (t) => {
      await t.run('DELETE FROM votes', []);
      await t.run('DELETE FROM ballots', []);
      await t.run('DELETE FROM projects', []);
      if (!keepParticipants) await t.run('DELETE FROM participants', []);
    });
  }
}

module.exports = { Store, nowIso, PENDING };

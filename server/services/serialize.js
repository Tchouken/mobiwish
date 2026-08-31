'use strict';

/** Nom d'affichage public : prenom + initiale du nom (RGPD : pas d'e-mail expose). */
function displayName(row) {
  const last = String(row.last_name || '').trim();
  const initial = last ? `${last.charAt(0).toUpperCase()}.` : '';
  return `${String(row.first_name || '').trim()} ${initial}`.trim();
}

function imageUrl(row) {
  return row.image_file ? `/media/${row.image_file}` : null;
}

function publicProject(row, { showVotes = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    answer: row.answer,
    author: displayName(row),
    imageUrl: imageUrl(row),
    status: row.status,
    createdAt: row.created_at,
    ...(showVotes ? { votes: Number(row.votes || 0) } : {}),
  };
}

function ownProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    answer: row.answer,
    question: row.question,
    imageUrl: imageUrl(row),
    status: row.status,
    error: row.error || null,
    createdAt: row.created_at,
  };
}

function adminProject(row) {
  if (!row) return null;
  return {
    ...publicProject(row),
    hidden: Boolean(row.hidden),
    provider: row.provider,
    error: row.error || null,
    participantId: row.participant_id,
    authorFullName: `${row.first_name} ${row.last_name}`.trim(),
  };
}

function publicParticipant(row) {
  return { id: row.id, firstName: row.first_name, lastName: row.last_name, displayName: displayName(row) };
}

module.exports = { displayName, imageUrl, publicProject, ownProject, adminProject, publicParticipant };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, identify, createProject } = require('./helpers');

/** Cree n projets, chacun par un participant distinct. */
async function seedProjects(server, n) {
  const projects = [];
  for (let i = 0; i < n; i += 1) {
    const { token } = await identify(server);
    const res = await createProject(server, token, `Idee numero ${i + 1} pour l'entreprise de demain, decrite avec assez de mots.`);
    projects.push({ id: res.body.project.id, token });
  }
  return projects;
}

test('vote : un bulletin unique par participant', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const projects = await seedProjects(server, 3);
  const { token } = await identify(server);

  const first = await server.request('/api/votes', { method: 'POST', token, body: { projectIds: [projects[0].id, projects[1].id] } });
  assert.equal(first.status, 201);

  const second = await server.request('/api/votes', { method: 'POST', token, body: { projectIds: [projects[2].id] } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'already_voted');

  assert.equal((await server.store.stats()).votes, 2);
  assert.equal((await server.store.stats()).voters, 1);
});

test('vote : la limite de selections est appliquee', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await server.store.setSettings({ votes_per_participant: '2' });
  const projects = await seedProjects(server, 3);
  const { token } = await identify(server);

  const tooMany = await server.request('/api/votes', {
    method: 'POST',
    token,
    body: { projectIds: projects.map((p) => p.id) },
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'too_many_votes');

  const none = await server.request('/api/votes', { method: 'POST', token, body: { projectIds: [] } });
  assert.equal(none.status, 400);
});

test('vote : les doublons dans un bulletin ne comptent qu’une fois', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const [project] = await seedProjects(server, 1);
  const { token } = await identify(server);

  const res = await server.request('/api/votes', {
    method: 'POST',
    token,
    body: { projectIds: [project.id, project.id, project.id] },
  });
  assert.equal(res.status, 201);
  assert.equal((await server.store.stats()).votes, 1);
});

test('vote : on ne peut pas voter pour son propre projet, sauf reglage contraire', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const [own] = await seedProjects(server, 1);

  const blocked = await server.request('/api/votes', { method: 'POST', token: own.token, body: { projectIds: [own.id] } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'self_vote');

  await server.store.setSettings({ allow_self_vote: '1' });
  const allowed = await server.request('/api/votes', { method: 'POST', token: own.token, body: { projectIds: [own.id] } });
  assert.equal(allowed.status, 201);
});

test('vote : refuse un projet masque ou inexistant, et les votes fermes', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const [project] = await seedProjects(server, 1);
  const { token } = await identify(server);

  const ghost = await server.request('/api/votes', { method: 'POST', token, body: { projectIds: ['prj_inconnu'] } });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.error.code, 'invalid_project');

  await server.store.setProjectHidden(project.id, true);
  const hidden = await server.request('/api/votes', { method: 'POST', token, body: { projectIds: [project.id] } });
  assert.equal(hidden.status, 400);

  await server.store.setProjectHidden(project.id, false);
  await server.store.setSettings({ voting_open: '0' });
  const closed = await server.request('/api/votes', { method: 'POST', token, body: { projectIds: [project.id] } });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'voting_closed');
});

test('classement : trie par votes et gere les ex aequo', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const [a, b, c] = await seedProjects(server, 3);
  for (let i = 0; i < 3; i += 1) {
    const { token } = await identify(server);
    // a recoit 3 votes, b et c en recoivent 1 chacun (ex aequo au 2e rang).
    const ids = i === 0 ? [a.id, b.id] : i === 1 ? [a.id, c.id] : [a.id];
    await server.request('/api/votes', { method: 'POST', token, body: { projectIds: ids } });
  }

  const { body } = await server.request('/api/leaderboard');
  assert.equal(body.leaderboard[0].id, a.id);
  assert.equal(body.leaderboard[0].votes, 3);
  assert.equal(body.leaderboard[0].rank, 1);
  assert.equal(body.leaderboard[1].rank, 2);
  assert.equal(body.leaderboard[2].rank, 2);
  assert.equal(body.stats.voters, 3);
});

test('classement : masque avant la reveal', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await server.store.setSettings({ results_public: '0' });
  const res = await server.request('/api/leaderboard');
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'results_hidden');

  await seedProjects(server, 1);
  const gallery = await server.request('/api/projects');
  assert.equal(gallery.body.projects[0].votes, undefined);
});

test('session : /me expose le bulletin deja depose', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const [project] = await seedProjects(server, 1);
  const { token } = await identify(server);
  await server.request('/api/votes', { method: 'POST', token, body: { projectIds: [project.id] } });

  const me = await server.request('/api/me', { token });
  assert.equal(me.body.hasVoted, true);
  assert.deepEqual(me.body.votes, [project.id]);

  const anonymous = await server.request('/api/me');
  assert.equal(anonymous.status, 401);
});

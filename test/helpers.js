'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mobiwish-data-'));
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin';
process.env.IMAGE_PROVIDER = 'mock';

const { open } = require('../server/db');
const { createApp } = require('../server/app');
const { EventHub } = require('../server/events');
const { runGeneration } = require('../server/services/generation');

const silent = { log() {}, warn() {}, error() {}, };

/** Demarre une instance isolee (base temporaire) et renvoie un client HTTP. */
async function startServer({ generate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobiwish-test-'));
  const db = open(path.join(dir, 'test.sqlite'));
  const hub = new EventHub();
  const pending = [];

  // Par defaut : generation synchrone attendable, pour des tests deterministes.
  const generator =
    generate ||
    ((args) => {
      const promise = runGeneration({ ...args, logger: silent });
      pending.push(promise);
      return promise;
    });

  const app = createApp({ db, hub, logger: silent, generate: generator });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(pathname, { method = 'GET', body, token, admin, headers = {}, raw = false } = {}) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(admin ? { 'x-admin-token': admin } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = raw ? await res.text() : await res.json().catch(() => ({}));
    return { status: res.status, body: payload, headers: res.headers };
  }

  return {
    base,
    request,
    store: app.locals.store,
    hub,
    settled: () => Promise.allSettled(pending),
    async close() {
      await Promise.allSettled(pending);
      hub.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let counter = 0;
async function identify(server, overrides = {}) {
  counter += 1;
  const res = await server.request('/api/session', {
    method: 'POST',
    body: {
      firstName: 'Camille',
      lastName: `Martin${counter}`,
      email: `camille${counter}@leboncoin.fr`,
      ...overrides,
    },
  });
  return res.body;
}

async function createProject(server, token, answer = 'Une plateforme interne qui recycle les objets du bureau entre collaborateurs.') {
  const res = await server.request('/api/projects', { method: 'POST', token, body: { answer } });
  await server.settled();
  return res;
}

module.exports = { startServer, identify, createProject };

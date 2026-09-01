/* Console d'administration : pilotage de la journee, moderation, export. */
(function () {
  'use strict';

  const { api, live, esc, el } = window.MW;
  const TOKEN_KEY = 'mobiwish.admin';

  let adminToken = sessionStorage.getItem(TOKEN_KEY) || '';
  let state = { settings: {}, projects: [], stats: {} };
  let filter = '';

  const admin = (path, options = {}) =>
    api(`/admin${path}`, { ...options, token: null, headers: { 'x-admin-token': adminToken, ...(options.headers || {}) } });

  // --- Connexion ----------------------------------------------------------
  // Sans ADMIN_TOKEN dans la configuration, le code est defini ici, au
  // premier acces : une variable de moins a renseigner chez l'hebergeur.
  let mustDefineCode = false;

  api('/config', { token: null })
    .then((config) => {
      mustDefineCode = config.adminConfigured === false;
      if (!mustDefineCode) return;
      el('login-title').textContent = 'Choisissez le code d’accès';
      el('login-help').hidden = false;
      el('login-label').textContent = 'Nouveau code d’accès (6 caractères minimum)';
      el('login-submit').textContent = 'Définir et entrer';
    })
    .catch(() => {});

  el('form-login').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    adminToken = el('admin-token').value;
    el('login-error').hidden = true;
    try {
      if (mustDefineCode) {
        await api('/admin/claim', { method: 'POST', token: null, body: { code: adminToken } });
        mustDefineCode = false;
      }
      await load();
      sessionStorage.setItem(TOKEN_KEY, adminToken);
      el('login').classList.add('hidden');
      el('console').classList.remove('hidden');
      el('btn-logout').classList.remove('hidden');
    } catch (err) {
      el('login-error').textContent = err.message;
      el('login-error').hidden = false;
    }
  });

  el('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
  });

  // --- Chargement ---------------------------------------------------------
  async function load() {
    const data = await admin('/state');
    state = data;
    el('provider-badge').textContent = `images : ${data.imageProvider}`;
    el('vote-link').textContent = data.voteUrl;
    el('vote-link').href = data.voteUrl;
    renderTiles();
    renderSettings();
    renderProjects();
  }

  function renderTiles() {
    const s = state.stats;
    const tiles = [
      ['Participants', s.participants],
      ['Projets publiés', s.projects],
      ['En génération', s.projectsPending],
      ['Échecs', s.projectsFailed],
      ['Votants', s.voters],
      ['Votes exprimés', s.votes],
    ];
    el('tiles').innerHTML = tiles
      .map(([label, value]) => `<div class="tile"><b>${value}</b><small>${label}</small></div>`)
      .join('');
  }

  function renderSettings() {
    const s = state.settings;
    el('event_name').value = s.event_name || '';
    el('question').value = s.question || '';
    el('votes_per_participant').value = s.votes_per_participant || '3';
    ['kiosk_open', 'voting_open', 'results_public', 'allow_self_vote'].forEach((key) => {
      el(key).checked = s[key] === '1';
    });
  }

  function renderProjects() {
    const needle = filter.trim().toLowerCase();
    const rows = state.projects.filter(
      (p) => !needle || `${p.title} ${p.authorFullName} ${p.answer}`.toLowerCase().includes(needle)
    );

    el('projects').innerHTML = rows.length
      ? rows
          .map(
            (p) => `
      <tr>
        <td>
          <div class="cell-project">
            ${p.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="" />` : '<div class="thumb"></div>'}
            <span>${esc(p.title)}</span>
          </div>
        </td>
        <td>${esc(p.authorFullName)}</td>
        <td>${statusBadge(p)}</td>
        <td class="num">${p.votes}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn--quiet btn--sm" data-toggle="${esc(p.id)}" data-hidden="${p.hidden ? '1' : '0'}">${p.hidden ? 'Réafficher' : 'Masquer'}</button>
            <button class="btn btn--danger btn--sm" data-delete="${esc(p.id)}">Supprimer</button>
          </div>
        </td>
      </tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="muted">Aucun projet.</td></tr>';
  }

  function statusBadge(p) {
    if (p.hidden) return '<span class="badge badge--off">masqué</span>';
    if (p.status === 'ready') return '<span class="badge badge--ok">publié</span>';
    if (p.status === 'generating') return '<span class="badge badge--warn">génération…</span>';
    return `<span class="badge badge--warn" title="${esc(p.error || '')}">échec</span>`;
  }

  // --- Actions ------------------------------------------------------------
  el('btn-save').addEventListener('click', async () => {
    el('settings-ok').hidden = true;
    el('settings-error').hidden = true;
    try {
      await admin('/settings', {
        method: 'PUT',
        body: {
          event_name: el('event_name').value,
          question: el('question').value,
          votes_per_participant: Number(el('votes_per_participant').value),
          kiosk_open: el('kiosk_open').checked,
          voting_open: el('voting_open').checked,
          results_public: el('results_public').checked,
          allow_self_vote: el('allow_self_vote').checked,
        },
      });
      el('settings-ok').hidden = false;
      await load();
    } catch (err) {
      el('settings-error').textContent = err.message;
      el('settings-error').hidden = false;
    }
  });

  el('projects').addEventListener('click', async (evt) => {
    const toggle = evt.target.closest('[data-toggle]');
    const remove = evt.target.closest('[data-delete]');
    try {
      if (toggle) {
        await admin(`/projects/${toggle.dataset.toggle}/visibility`, {
          method: 'POST',
          body: { hidden: toggle.dataset.hidden !== '1' },
        });
        await load();
      } else if (remove) {
        if (!confirm('Supprimer définitivement ce projet et ses votes ?')) return;
        await admin(`/projects/${remove.dataset.delete}`, { method: 'DELETE' });
        await load();
      }
    } catch (err) {
      alert(err.message);
    }
  });

  el('search').addEventListener('input', (evt) => {
    filter = evt.target.value;
    renderProjects();
  });

  el('btn-export').addEventListener('click', () => {
    window.open(`/api/admin/export.csv?token=${encodeURIComponent(adminToken)}`, '_blank', 'noopener');
  });

  el('btn-reset').addEventListener('click', async () => {
    if (!confirm('Réinitialiser l’événement ? Projets, votes et participants seront supprimés.')) return;
    try {
      await admin('/reset', { method: 'POST', body: { confirm: 'RESET' } });
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  // --- Temps reel ---------------------------------------------------------
  api('/config', { token: null })
    .then((config) => {
      live(() => { if (adminToken) load().catch(() => {}); }, {
        mode: config.realtime,
        intervalMs: Math.max(config.pollIntervalMs || 5000, 8000),
      });
    })
    .catch(() => {});

  // Session deja ouverte dans cet onglet
  if (adminToken) {
    load()
      .then(() => {
        el('login').classList.add('hidden');
        el('console').classList.remove('hidden');
        el('btn-logout').classList.remove('hidden');
      })
      .catch(() => sessionStorage.removeItem(TOKEN_KEY));
  }
})();

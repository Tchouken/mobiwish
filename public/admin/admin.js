/* Console d'administration : pilotage de la journee, moderation, export. */
(function () {
  'use strict';

  const { api, live, esc, el, thumb, images } = window.MW;
  const TOKEN_KEY = 'mobiwish.admin';

  let adminToken = sessionStorage.getItem(TOKEN_KEY) || '';
  let state = { settings: {}, projects: [], stats: {}, page: 1, pages: 1, projectsTotal: 0 };
  // Page et recherche sont envoyees au serveur : la recherche porte sur
  // l'evenement entier, pas sur les vingt lignes affichees.
  let filter = '';
  let page = 1;

  const admin = (path, options = {}) =>
    api(`/admin${path}`, { ...options, token: null, headers: { 'x-admin-token': adminToken, ...(options.headers || {}) } });

  // --- Connexion ----------------------------------------------------------
  // Sans ADMIN_TOKEN dans la configuration, le code est defini ici, au
  // premier acces : une variable de moins a renseigner chez l'hebergeur.
  let mustDefineCode = false;

  api('/config', { token: null })
    .then((config) => {
      mustDefineCode = config.adminConfigured === false;
      images.optimize = config.imageOptimization === true;
      if (config.voteQr) el('admin-qr').src = config.voteQr;
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
    const query = `?page=${page}&q=${encodeURIComponent(filter.trim())}`;
    const data = await admin(`/state${query}`);
    state = data;
    page = data.page;
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
      ['En attente de publication', s.projectsAwaitingPublication],
      ['En génération', s.projectsPending],
      ['Échecs', s.projectsFailed],
      ['Votants', s.voters],
      ['Votes exprimés', s.votes],
    ];
    el('tiles').innerHTML = tiles
      .map(([label, value]) => `<div class="tile"><b>${value}</b><small>${label}</small></div>`)
      .join('');
  }

  // Champs texte pilotables depuis la console, sans redeploiement.
  const COPY_FIELDS = [
    'kiosk_headline', 'kiosk_intro', 'kiosk_cta', 'kiosk_footnote',
    'vote_headline', 'vote_intro', 'display_headline', 'display_intro',
  ];

  function renderSettings() {
    const s = state.settings;
    el('event_name').value = s.event_name || '';
    el('question').value = s.question || '';
    el('votes_per_participant').value = s.votes_per_participant || '3';
    el('max_renders').value = s.max_renders || '3';
    COPY_FIELDS.forEach((key) => { el(key).value = s[key] || ''; });
    ['kiosk_open', 'voting_open', 'results_public', 'allow_self_vote'].forEach((key) => {
      el(key).checked = s[key] === '1';
    });
  }

  function renderProjects() {
    const rows = state.projects;

    el('projects').innerHTML = rows.length
      ? rows
          .map(
            (p) => `
      <tr>
        <td>
          <div class="cell-project">
            ${p.imageUrl ? `<img class="thumb" src="${esc(thumb(p.imageUrl, 96))}" alt="" loading="lazy" />` : '<div class="thumb"></div>'}
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
      : `<tr><td colspan="5" class="muted">${filter.trim() ? 'Aucun projet pour cette recherche.' : 'Aucun projet.'}</td></tr>`;

    renderPager();
  }

  function renderPager() {
    const total = state.projectsTotal || 0;
    const premier = total === 0 ? 0 : (state.page - 1) * state.perPage + 1;
    const dernier = Math.min(state.page * state.perPage, total);

    el('pager').hidden = total === 0;
    el('page-prev').disabled = state.page <= 1;
    el('page-next').disabled = state.page >= state.pages;
    el('page-label').textContent = total
      ? `${premier}–${dernier} sur ${total} projet${total > 1 ? 's' : ''} · page ${state.page}/${state.pages}`
      : '';
  }

  function goToPage(n) {
    const cible = Math.min(Math.max(n, 1), state.pages || 1);
    if (cible === state.page) return;
    page = cible;
    load().catch((err) => alert(err.message));
  }

  el('page-prev').addEventListener('click', () => goToPage(state.page - 1));
  el('page-next').addEventListener('click', () => goToPage(state.page + 1));

  function statusBadge(p) {
    if (p.hidden) return '<span class="badge badge--off">masqué</span>';
    if (p.status === 'ready' && !p.published) return '<span class="badge badge--warn">non validé</span>';
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
          max_renders: Number(el('max_renders').value),
          ...Object.fromEntries(COPY_FIELDS.map((key) => [key, el(key).value])),
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

  let searchTimer;
  el('search').addEventListener('input', (evt) => {
    filter = evt.target.value;
    page = 1;
    clearTimeout(searchTimer);
    // Une requete par frappe inonderait la base : on attend la fin du mot.
    searchTimer = setTimeout(() => load().catch(() => {}), 250);
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

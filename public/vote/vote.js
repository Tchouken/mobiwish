/* WebApp de vote mobile : galerie, selection, identification, classement temps reel. */
(function () {
  'use strict';

  const { api, store, live, esc, el, plural, thumb, images } = window.MW;

  // Taille d'une tranche de galerie. `loaded` est la fenetre actuellement
  // affichee : a chaque rafraichissement temps reel on redemande cette meme
  // fenetre depuis le debut, ce qui evite les doublons quand de nouvelles
  // visions arrivent en tete pendant la consultation.
  const PAGE_SIZE = 20;

  const state = {
    config: null,
    projects: [],
    selected: new Set(),
    hasVoted: false,
    max: 3,
    detailId: null,
    loaded: PAGE_SIZE,
    total: 0,
    eventTotal: 0,
    search: '',
  };

  // --- Chargement ---------------------------------------------------------
  async function refreshConfig() {
    state.config = await api('/config', { token: null });
    state.max = state.config.votesPerParticipant;
    images.optimize = state.config.imageOptimization === true;
    const copy = state.config.copy || {};
    el('event-name').textContent = state.config.eventName;
    el('intro-headline').textContent = copy.voteHeadline || 'Votez pour vos projets préférés';
    el('intro-text').textContent = copy.voteIntro || '';
    document.title = state.config.eventName;
    el('intro-help').textContent = state.config.votingOpen
      ? `Sélectionnez jusqu’à ${plural(state.max, 'projet', 'projets')}, puis validez votre vote. Un seul vote par participant.`
      : 'Les votes sont fermés. Vous pouvez parcourir la galerie et consulter le classement.';
  }

  const query = (params) =>
    `/projects?${params}${state.search ? `&q=${encodeURIComponent(state.search)}` : ''}`;

  async function refreshProjects() {
    const data = await api(query(`limit=${state.loaded}&offset=0`), { token: null });
    state.projects = data.projects;
    state.total = data.total;
    state.eventTotal = data.eventTotal;
    state.max = data.votesPerParticipant;
    render();
  }

  /** Tranche suivante, ajoutee a la suite sans recharger ce qui est deja la. */
  async function loadMore() {
    const btn = el('btn-more');
    btn.disabled = true;
    try {
      const data = await api(query(`limit=${PAGE_SIZE}&offset=${state.projects.length}`), { token: null });
      const known = new Set(state.projects.map((p) => p.id));
      state.projects = state.projects.concat(data.projects.filter((p) => !known.has(p.id)));
      state.total = data.total;
      state.eventTotal = data.eventTotal;
      state.loaded = state.projects.length;
      render();
    } finally {
      btn.disabled = false;
    }
  }

  el('btn-more').addEventListener('click', () => loadMore().catch(() => {}));

  /**
   * Recherche : la galerie repart d'une tranche, la selection deja faite
   * n'est pas touchee — elle vit en memoire, pas dans les cartes affichees.
   */
  let searchTimer;
  el('search').addEventListener('input', (evt) => {
    const value = evt.target.value;
    el('search-clear').classList.toggle('hidden', value === '');
    clearTimeout(searchTimer);
    // Une requete par frappe inonderait le serveur : on attend la fin du mot.
    searchTimer = setTimeout(() => {
      state.search = value.trim();
      state.loaded = PAGE_SIZE;
      refreshProjects().catch(() => {});
    }, 250);
  });

  el('search-clear').addEventListener('click', () => {
    el('search').value = '';
    el('search-clear').classList.add('hidden');
    state.search = '';
    state.loaded = PAGE_SIZE;
    refreshProjects().catch(() => {});
    el('search').focus();
  });

  async function refreshMe() {
    if (!store.token) return;
    try {
      const me = await api('/me');
      state.hasVoted = me.hasVoted;
      if (me.hasVoted) {
        state.selected = new Set(me.votes);
        banner(`Merci ${me.participant.firstName}, votre vote est enregistré.`);
      }
    } catch (err) {
      if (err.status === 401) store.token = null;
    }
  }

  function banner(message) {
    const node = el('banner');
    node.textContent = message;
    node.classList.remove('hidden');
  }

  // --- Rendu --------------------------------------------------------------
  function render() {
    const gallery = el('gallery');
    const showVotes = state.config?.resultsPublic !== false;

    el('empty').classList.toggle('hidden', state.projects.length > 0);
    el('empty').textContent = state.search
      ? `Aucune vision ne correspond à « ${state.search} ».`
      : 'Aucun projet pour le moment. Les premières créations arrivent bientôt !';
    gallery.innerHTML = state.projects
      .map((p) => {
        const selected = state.selected.has(p.id);
        return `
        <div class="project" role="button" tabindex="0" aria-pressed="${selected}" data-id="${esc(p.id)}">
          <span class="tick" aria-hidden="true">✓</span>
          <img src="${esc(thumb(p.imageUrl, 480))}" alt="Illustration du projet ${esc(p.title)}" loading="lazy" decoding="async" />
          <div class="project-body">
            <span class="project-title">${esc(p.title)}</span>
            <span class="project-author">${esc(p.author)}</span>
            <div class="project-foot">
              <button class="project-info" type="button" data-info="${esc(p.id)}">Voir l’idée</button>
              ${showVotes && p.votes !== undefined ? `<span class="project-votes">${plural(p.votes, 'vote', 'votes')}</span>` : ''}
            </div>
          </div>
        </div>`;
      })
      .join('');

    renderMore();
    renderVotebar();
  }

  function renderMore() {
    const reste = Math.max(0, state.total - state.projects.length);
    el('more').classList.toggle('hidden', state.projects.length === 0);
    el('btn-more').hidden = reste === 0;
    el('btn-more').textContent = `Voir ${Math.min(PAGE_SIZE, reste)} ${reste > 1 ? 'projets' : 'projet'} de plus`;

    if (!state.total) {
      el('more-count').textContent = '';
    } else if (state.search) {
      el('more-count').textContent =
        `${state.projects.length} sur ${plural(state.total, 'résultat', 'résultats')} · ${state.eventTotal} projets au total`;
    } else {
      el('more-count').textContent = `${state.projects.length} sur ${plural(state.total, 'projet', 'projets')}`;
    }
  }

  function renderVotebar() {
    const bar = el('votebar');
    const votingOpen = state.config?.votingOpen !== false;
    if (state.hasVoted || !votingOpen || state.projects.length === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.toggle('hidden', state.selected.size === 0);
    el('votebar-count').textContent = `${state.selected.size}/${state.max} sélectionné${state.selected.size > 1 ? 's' : ''}`;
  }

  function toggle(id) {
    if (state.hasVoted) return banner('Vous avez déjà voté : un seul vote par participant.');
    if (state.config && !state.config.votingOpen) return banner('Les votes sont fermés.');

    if (state.selected.has(id)) {
      state.selected.delete(id);
    } else {
      if (state.selected.size >= state.max) {
        return banner(`Vous pouvez sélectionner ${plural(state.max, 'projet', 'projets')} au maximum.`);
      }
      state.selected.add(id);
    }

    const card = document.querySelector(`.project[data-id="${CSS.escape(id)}"]`);
    if (card) card.setAttribute('aria-pressed', String(state.selected.has(id)));
    renderVotebar();
    return undefined;
  }

  // --- Interactions galerie ----------------------------------------------
  el('gallery').addEventListener('click', (evt) => {
    const info = evt.target.closest('[data-info]');
    if (info) {
      evt.stopPropagation();
      return openDetail(info.dataset.info);
    }
    const card = evt.target.closest('.project');
    if (card) toggle(card.dataset.id);
    return undefined;
  });

  el('gallery').addEventListener('keydown', (evt) => {
    const card = evt.target.closest('.project');
    if (card && (evt.key === 'Enter' || evt.key === ' ')) {
      evt.preventDefault();
      toggle(card.dataset.id);
    }
  });

  function openDetail(id) {
    const project = state.projects.find((p) => p.id === id);
    if (!project) return;
    state.detailId = id;
    el('detail-img').src = thumb(project.imageUrl, 768);
    el('detail-img').alt = `Illustration du projet ${project.title}`;
    el('detail-title').textContent = project.title;
    el('detail-author').textContent = `Par ${project.author}`;
    el('detail-answer').textContent = project.summary || '';
    el('detail-select').textContent = state.selected.has(id) ? 'Retirer de ma sélection' : 'Sélectionner';
    el('detail-select').hidden = state.hasVoted || state.config?.votingOpen === false;
    openSheet('sheet-detail');
  }

  el('detail-select').addEventListener('click', () => {
    toggle(state.detailId);
    closeSheets();
  });

  // --- Feuilles -----------------------------------------------------------
  const openSheet = (id) => el(id).classList.remove('hidden');
  const closeSheets = () => document.querySelectorAll('.sheet').forEach((s) => s.classList.add('hidden'));

  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeSheets));
  document.querySelectorAll('.sheet').forEach((sheet) =>
    sheet.addEventListener('click', (evt) => { if (evt.target === sheet) closeSheets(); })
  );
  document.addEventListener('keydown', (evt) => { if (evt.key === 'Escape') closeSheets(); });

  // --- Vote ---------------------------------------------------------------
  el('btn-vote').addEventListener('click', async () => {
    if (state.selected.size === 0) return;
    if (store.token) {
      await submitVote();
    } else {
      openSheet('sheet-identity');
      setTimeout(() => el('firstName').focus(), 150);
    }
  });

  el('form-identity').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    el('identity-error').hidden = true;
    const submit = el('identity-submit');
    submit.disabled = true;
    try {
      const { token, hasVoted } = await api('/session', {
        method: 'POST',
        token: null,
        body: { firstName: el('firstName').value, lastName: el('lastName').value, email: el('email').value },
      });
      store.token = token;
      if (hasVoted) {
        state.hasVoted = true;
        closeSheets();
        banner('Cette adresse a déjà voté : un seul vote par participant.');
        render();
        return;
      }
      closeSheets();
      await submitVote();
    } catch (err) {
      el('identity-error').textContent = err.message;
      el('identity-error').hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  async function submitVote() {
    const btn = el('btn-vote');
    btn.disabled = true;
    try {
      await api('/votes', { method: 'POST', body: { projectIds: [...state.selected] } });
      state.hasVoted = true;
      banner('Merci, votre vote est enregistré !');
      el('ranking-thanks').classList.remove('hidden');
      await refreshProjects();
      await openRanking();
    } catch (err) {
      if (err.code === 'already_voted') state.hasVoted = true;
      banner(err.message);
      render();
    } finally {
      btn.disabled = false;
    }
  }

  // --- Classement ---------------------------------------------------------
  async function openRanking() {
    openSheet('sheet-ranking');
    await refreshRanking();
  }

  async function refreshRanking() {
    const list = el('ranking');
    try {
      const { leaderboard } = await api('/leaderboard', { token: null });
      el('ranking-hidden').classList.add('hidden');
      list.innerHTML = leaderboard.length
        ? leaderboard
            .map(
              (row) => `
          <li>
            <span class="rank">${row.rank}</span>
            ${row.imageUrl ? `<img src="${esc(thumb(row.imageUrl, 96))}" alt="" loading="lazy" />` : ''}
            <span class="meta"><strong>${esc(row.title)}</strong><span class="faint">${esc(row.author)}</span></span>
            <span class="votes">${row.votes}</span>
          </li>`
            )
            .join('')
        : '<li class="faint">Aucun vote pour le moment.</li>';
    } catch (err) {
      list.innerHTML = '';
      el('ranking-hidden').textContent =
        err.code === 'results_hidden' ? 'Les résultats seront révélés en fin de journée.' : err.message;
      el('ranking-hidden').classList.remove('hidden');
    }
  }

  el('btn-ranking').addEventListener('click', openRanking);

  // --- Temps reel ---------------------------------------------------------
  async function onChange() {
    await refreshConfig();
    await refreshProjects();
    if (!el('sheet-ranking').classList.contains('hidden')) await refreshRanking();
  }

  (async function init() {
    await refreshConfig();
    await refreshMe();
    await refreshProjects();
    live(onChange, { mode: state.config.realtime, intervalMs: state.config.pollIntervalMs });
  })();
})();

/* WebApp de vote mobile : galerie, selection, identification, classement temps reel. */
(function () {
  'use strict';

  const { api, store, subscribe, esc, el, plural } = window.MW;

  const state = {
    config: null,
    projects: [],
    selected: new Set(),
    hasVoted: false,
    max: 3,
    detailId: null,
  };

  // --- Chargement ---------------------------------------------------------
  async function refreshConfig() {
    state.config = await api('/config', { token: null });
    state.max = state.config.votesPerParticipant;
    el('event-name').textContent = state.config.eventName;
    document.title = `Vote — ${state.config.eventName}`;
    el('intro-help').textContent = state.config.votingOpen
      ? `Sélectionnez jusqu’à ${plural(state.max, 'projet', 'projets')}, puis validez votre vote. Un seul vote par participant.`
      : 'Les votes sont fermés. Vous pouvez parcourir la galerie et consulter le classement.';
  }

  async function refreshProjects() {
    const data = await api('/projects', { token: null });
    state.projects = data.projects;
    state.max = data.votesPerParticipant;
    render();
  }

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
    gallery.innerHTML = state.projects
      .map((p) => {
        const selected = state.selected.has(p.id);
        return `
        <div class="project" role="button" tabindex="0" aria-pressed="${selected}" data-id="${esc(p.id)}">
          <span class="tick" aria-hidden="true">✓</span>
          <img src="${esc(p.imageUrl)}" alt="Illustration du projet ${esc(p.title)}" loading="lazy" />
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

    renderVotebar();
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
    el('detail-img').src = project.imageUrl;
    el('detail-img').alt = `Illustration du projet ${project.title}`;
    el('detail-title').textContent = project.title;
    el('detail-author').textContent = `Par ${project.author}`;
    el('detail-answer').textContent = project.answer;
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
            ${row.imageUrl ? `<img src="${esc(row.imageUrl)}" alt="" />` : ''}
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
  subscribe({
    'project:ready': refreshProjects,
    'project:updated': refreshProjects,
    'project:deleted': refreshProjects,
    'vote:cast': () => {
      refreshProjects();
      if (!el('sheet-ranking').classList.contains('hidden')) refreshRanking();
    },
    'settings:updated': async () => {
      await refreshConfig();
      render();
    },
    'event:reset': async () => {
      store.token = null;
      state.selected.clear();
      state.hasVoted = false;
      await refreshProjects();
    },
  });

  (async function init() {
    await refreshConfig();
    await refreshMe();
    await refreshProjects();
  })();
})();

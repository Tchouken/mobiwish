/* Ecran evenement : classement et compteurs en direct. */
(function () {
  'use strict';

  const { api, subscribe, esc, el } = window.MW;
  const MEDALS = ['🥇', '🥈', '🥉'];

  async function refresh() {
    try {
      const config = await api('/config', { token: null });
      el('event-name').textContent = config.eventName;
      el('vote-url').textContent = config.voteUrl.replace(/^https?:\/\//, '');
      el('c-projects').textContent = config.stats.projects;
      el('c-voters').textContent = config.stats.voters;
      el('c-votes').textContent = config.stats.votes;
      el('c-status').textContent = config.votingOpen ? 'ouverts' : 'clos';
    } catch {
      /* nouvelle tentative au prochain cycle */
    }

    try {
      const { leaderboard } = await api('/leaderboard', { token: null });
      el('veil').classList.add('hidden');
      renderBoard(leaderboard);
    } catch (err) {
      if (err.code === 'results_hidden') {
        el('podium').innerHTML = '';
        el('rest').innerHTML = '';
        el('veil').classList.remove('hidden');
      }
    }
  }

  function renderBoard(rows) {
    el('podium').innerHTML = rows
      .slice(0, 3)
      .map(
        (row, index) => `
      <div class="slot slot--${index + 1}">
        ${row.imageUrl ? `<img src="${esc(row.imageUrl)}" alt="Illustration du projet ${esc(row.title)}" />` : ''}
        <div class="slot-body">
          <span class="medal">${MEDALS[index]}</span>
          <span class="title">${esc(row.title)}</span>
          <span class="author">${esc(row.author)}</span>
          <span class="votes">${row.votes} vote${row.votes > 1 ? 's' : ''}</span>
        </div>
      </div>`
      )
      .join('');

    el('rest').innerHTML = rows
      .slice(3, 13)
      .map(
        (row) => `
      <li>
        <span class="rank">${row.rank}</span>
        ${row.imageUrl ? `<img src="${esc(row.imageUrl)}" alt="" />` : ''}
        <span class="meta"><strong>${esc(row.title)}</strong><span class="faint">${esc(row.author)}</span></span>
        <span class="votes">${row.votes}</span>
      </li>`
      )
      .join('');
  }

  const live = el('live');
  subscribe({
    open: () => { live.classList.remove('is-off'); live.lastChild.textContent = ' connecté'; },
    error: () => { live.classList.add('is-off'); live.lastChild.textContent = ' reconnexion…'; },
    'project:ready': refresh,
    'project:updated': refresh,
    'project:deleted': refresh,
    'vote:cast': refresh,
    'settings:updated': refresh,
    'event:reset': refresh,
  });

  refresh();
  setInterval(refresh, 20000); // filet de securite si le flux SSE est coupe
})();

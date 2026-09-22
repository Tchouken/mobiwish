/* ------------------------------------------------------------------
   Ecran evenement, version 2.
   Gauche  : diaporama en boucle des dix dernieres visions publiees,
             une toutes les cinq secondes.
   Droite  : le podium des trois premiers, mis a jour en direct.
   Bas     : les metriques de la journee et le QR code du vote.
------------------------------------------------------------------- */
(function () {
  'use strict';

  const { api, live, esc, el, thumb, images } = window.MW;

  const SLIDE_MS = 5000;
  const MAX_SLIDES = 10;
  const MEDALS = ['🥇', '🥈', '🥉'];

  const layers = [el('slide-a'), el('slide-b')];
  const frame = document.querySelector('.stage-frame');

  const show = {
    slides: [],
    index: 0,
    layer: 0,
    timer: null,
    newest: null,
  };
  const previous = { ranking: [], metrics: {} };

  // --- Diaporama ----------------------------------------------------

  /**
   * Remplace la liste des visions sans casser la rotation en cours : on
   * retrouve la vision affichee dans la nouvelle liste et on repart de la.
   * Une publication toute fraiche, elle, passe a l'ecran immediatement —
   * c'est le lien visible entre la borne et l'ecran de la salle.
   */
  function setSlides(projects) {
    const next = projects.slice(0, MAX_SLIDES);
    const current = show.slides[show.index];
    const firstLoad = show.slides.length === 0;
    const newest = next.length ? next[0].id : null;
    const isNew = !firstLoad && newest && newest !== show.newest;

    show.slides = next;
    show.newest = newest;
    frame.classList.toggle('is-empty', next.length === 0);
    renderDots();

    if (!next.length) {
      stop();
      return;
    }

    if (isNew) {
      show.index = 0;
      paint({ isNew: true });
      start();
      return;
    }

    const kept = current ? next.findIndex((row) => row.id === current.id) : -1;
    show.index = kept >= 0 ? kept : Math.min(show.index, next.length - 1);
    if (firstLoad) {
      paint();
      start();
    }
  }

  function paint({ isNew = false } = {}) {
    const row = show.slides[show.index];
    if (!row) return;

    const next = layers[show.layer ^ 1];
    const current = layers[show.layer];

    next.src = row.imageUrl ? thumb(row.imageUrl, 1024) : '';
    next.alt = `Illustration de la vision « ${row.title} »`;
    next.classList.add('is-on');
    current.classList.remove('is-on');
    show.layer ^= 1;

    el('slide-kicker').textContent = isNew ? 'Vision toute fraîche' : 'Dernières visions';
    el('slide-title').textContent = row.title;
    el('slide-author').textContent = row.author;
    el('slide-summary').textContent = row.summary || '';

    restart(el('stage-caption'), 'is-fresh');
    const bar = el('stage-bar');
    bar.style.animationDuration = `${SLIDE_MS}ms`;
    restart(bar, 'is-running');

    renderDots();
    preload(show.slides[(show.index + 1) % show.slides.length]);
  }

  function renderDots() {
    el('stage-dots').innerHTML = show.slides
      .map((row, i) => `<li class="${i === show.index ? 'is-on' : ''}"></li>`)
      .join('');
  }

  /** L'image suivante est chargee avant son tour : pas de blanc a l'ecran. */
  function preload(row) {
    if (!row || !row.imageUrl) return;
    const img = new Image();
    img.src = thumb(row.imageUrl, 1024);
  }

  function start() {
    stop();
    if (show.slides.length < 2) return;
    show.timer = setInterval(() => {
      show.index = (show.index + 1) % show.slides.length;
      paint();
    }, SLIDE_MS);
  }

  function stop() {
    clearInterval(show.timer);
    show.timer = null;
  }

  // --- Podium -------------------------------------------------------

  function renderPodium(rows) {
    const top = rows.slice(0, 3);
    const moved = new Set(
      top.filter((row, index) => previous.ranking[index] !== row.id).map((row) => row.id)
    );
    // Au premier affichage, tout est « nouveau » : on ne clignote pas.
    const quiet = previous.ranking.length === 0;

    el('podium2').innerHTML = top
      .map(
        (row, index) => `
      <li class="${index === 0 ? 'is-first' : ''} ${!quiet && moved.has(row.id) ? 'is-moved' : ''}">
        <span class="visual">
          ${
            row.imageUrl
              ? `<img src="${esc(thumb(row.imageUrl, 240))}" alt="Illustration de la vision ${esc(row.title)}" />`
              : '<span class="visual-void" aria-hidden="true"></span>'
          }
          <span class="medal">${MEDALS[index]}<span class="sr-only">${index + 1}e place</span></span>
        </span>
        <span class="body">
          <span class="title">${esc(row.title)}</span>
          <span class="author">${esc(row.author)}</span>
        </span>
        <span class="score"><b>${row.votes}</b><small>vote${row.votes > 1 ? 's' : ''}</small></span>
      </li>`
      )
      .join('');

    previous.ranking = top.map((row) => row.id);
    el('podium2').hidden = top.length === 0;
    el('ranking-empty').hidden = top.length > 0;
    el('ranking-note').textContent = rows.length > 3 ? `${rows.length} visions en lice` : '';
  }

  function hidePodium(message) {
    el('podium2').innerHTML = '';
    // Masquee et non seulement videe : le message occupe alors tout le
    // panneau, au lieu de flotter sous une liste vide.
    el('podium2').hidden = true;
    el('ranking-empty').hidden = true;
    el('ranking-note').textContent = '';
    previous.ranking = [];
    if (message) el('veil2').hidden = false;
  }

  // --- Metriques ----------------------------------------------------

  function metric(id, value) {
    const node = el(id);
    const text = String(value);
    if (node.textContent === text) return;
    node.textContent = text;
    if (Number(value) > Number(previous.metrics[id] || 0)) restart(node.parentElement, 'is-up');
    previous.metrics[id] = value;
  }

  /** Rejoue une animation CSS deja posee sur l'element. */
  function restart(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  }

  // --- Cycle de rafraichissement ------------------------------------

  async function refresh() {
    let config = null;
    try {
      config = await api('/config', { token: null });
      images.optimize = config.imageOptimization === true;
      const copy = config.copy || {};
      el('event-name').textContent = config.eventName;
      el('display-headline').textContent = copy.displayHeadline || 'Les visions de la journée';
      document.title = config.eventName;
      if (config.voteQr) el('display-qr').src = config.voteQr;
      el('vote-url').textContent = config.voteUrl.replace(/^https?:\/\//, '');
      metric('c-projects', config.stats.projects);
      metric('c-voters', config.stats.voters);
      metric('c-votes', config.stats.votes);
      el('c-status').textContent = config.votingOpen ? 'ouverts' : 'clos';
    } catch {
      /* nouvelle tentative au prochain cycle */
    }

    try {
      const { projects } = await api('/projects', { token: null });
      setSlides(projects);
    } catch {
      /* la galerie reste sur les visions deja chargees */
    }

    try {
      const { leaderboard } = await api('/leaderboard', { token: null });
      el('veil2').hidden = true;
      renderPodium(leaderboard);
    } catch (err) {
      if (err.code === 'results_hidden') hidePodium(true);
    }

    return config;
  }

  const badge = el('live');
  const mark = (ok, label) => {
    badge.classList.toggle('is-off', !ok);
    badge.lastChild.textContent = ' ' + label;
  };

  (async function startScreen() {
    const config = await refresh();
    mark(true, config && config.realtime === 'sse' ? 'connecté' : 'mise à jour automatique');
    live(refresh, {
      mode: config ? config.realtime : 'sse',
      intervalMs: config ? config.pollIntervalMs : 5000,
      onOpen: () => mark(true, 'connecté'),
      onError: () => mark(false, 'reconnexion…'),
    });
    // Filet de securite si le flux est coupe sans erreur remontee.
    setInterval(refresh, 30000);
  })();
})();

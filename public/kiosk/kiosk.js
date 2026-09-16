/* Borne IA — parcours : accueil -> identification -> question -> generation -> resultat. */
(function () {
  'use strict';

  const { api, esc, el, idleTimer } = window.MW;

  const SCREENS = ['attract', 'identity', 'answer', 'loading', 'review', 'result', 'closed'];
  const IDLE_MS = 120000;        // retour a l'accueil apres 2 min d'inactivite
  const RESULT_MS = 60000;       // duree d'affichage du resultat
  const POLL_MS = 2000;          // frequence d'interrogation pendant la generation
  const GENERATION_TIMEOUT_MS = 180000;

  // Le jeton borne peut etre passe une fois dans l'URL : /kiosk?kiosk=CODE
  const params = new URLSearchParams(location.search);
  const kioskToken = params.get('kiosk') || sessionStorage.getItem('mobiwish.kiosk') || '';
  if (params.get('kiosk')) sessionStorage.setItem('mobiwish.kiosk', params.get('kiosk'));

  const state = { config: null, token: null, participant: null, project: null, timers: [] };

  function show(name) {
    SCREENS.forEach((key) => {
      const node = el(`screen-${key}`);
      if (node) node.hidden = key !== name;
    });
  }

  function clearTimers() {
    state.timers.forEach(clearTimeout);
    state.timers.forEach(clearInterval);
    state.timers = [];
  }

  function goHome() {
    clearTimers();
    state.token = null;
    state.participant = null;
    state.project = null;
    el('form-identity').reset();
    el('form-answer').reset();
    el('answer-count').textContent = '0';
    hideError('identity-error');
    hideError('answer-error');
    hideError('review-error');
    show(state.config && !state.config.kioskOpen ? 'closed' : 'attract');
  }

  function showError(id, message) {
    const node = el(id);
    node.textContent = message;
    node.hidden = false;
  }
  const hideError = (id) => { el(id).hidden = true; };

  async function loadConfig() {
    try {
      state.config = await api('/config');
      const copy = state.config.copy || {};
      el('attract-event').textContent = state.config.eventName;
      el('attract-headline').textContent = copy.kioskHeadline || 'Imaginez l’entreprise de demain';
      el('attract-intro').textContent = copy.kioskIntro || state.config.question;
      el('attract-footnote').textContent = copy.kioskFootnote || '';
      el('btn-start').textContent = copy.kioskCta || 'Commencer';
      el('answer-question').textContent = state.config.question;
      document.title = `Borne — ${state.config.eventName}`;
      if (!state.config.kioskOpen && el('screen-attract').hidden === false) show('closed');
    } catch {
      /* le serveur repondra a la prochaine tentative */
    }
  }

  // --- Etape 1 : identification -------------------------------------------
  el('form-identity').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    hideError('identity-error');
    const submit = el('identity-submit');
    submit.disabled = true;

    try {
      const { token, participant } = await api('/session', {
        method: 'POST',
        token: null,
        body: {
          firstName: el('firstName').value,
          lastName: el('lastName').value,
          email: el('email').value,
        },
      });
      state.token = token;
      state.participant = participant;
      el('answer-hello').textContent = `Bonjour ${participant.firstName} !`;
      show('answer');
      setTimeout(() => el('answer').focus(), 150);
    } catch (err) {
      showError('identity-error', err.message);
    } finally {
      submit.disabled = false;
    }
  });

  // --- Etape 2 : reponse creative + generation -----------------------------
  el('answer').addEventListener('input', (evt) => {
    el('answer-count').textContent = String(evt.target.value.length);
  });

  el('form-answer').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    hideError('answer-error');
    const title = el('vision-title').value.trim();
    const answer = el('answer').value.trim();
    if (title.length < 2) {
      showError('answer-error', 'Donnez un titre à votre vision.');
      return;
    }
    if (answer.length < 10) {
      showError('answer-error', 'Décrivez votre vision en quelques mots (10 caractères minimum).');
      return;
    }

    const submit = el('answer-submit');
    submit.disabled = true;
    show('loading');

    try {
      const { project, renderMode } = await api('/projects', {
        method: 'POST',
        token: state.token,
        headers: kioskToken ? { 'x-kiosk-token': kioskToken } : {},
        body: { title, answer },
      });
      state.project = project;

      // Hebergement serverless : la generation est declenchee par cet appel,
      // qui repond une fois l'image prete. L'interrogation ci-dessous sert de
      // filet si la requete est coupee en route.
      if ((renderMode || state.config?.renderMode) === 'request') {
        api(`/projects/${project.id}/render`, {
          method: 'POST',
          token: state.token,
          headers: kioskToken ? { 'x-kiosk-token': kioskToken } : {},
        }).catch(() => {});
      }

      await waitForImage(project.id);
    } catch (err) {
      showError('answer-error', err.message);
      show('answer');
    } finally {
      submit.disabled = false;
    }
  });

  /** Interroge le serveur jusqu'a ce que l'image soit prete. */
  function waitForImage(projectId) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const tick = async () => {
        if (Date.now() - startedAt > GENERATION_TIMEOUT_MS) {
          showError('answer-error', 'La génération prend trop de temps. Merci de réessayer.');
          show('answer');
          return resolve();
        }
        try {
          const { project } = await api(`/projects/${projectId}`, { token: state.token });
          if (project.status === 'ready') {
            state.project = project;
            renderReview(project);
            return resolve();
          }
          if (project.status === 'failed') {
            showError('answer-error', project.error || 'La génération a échoué. Réessayez avec une autre formulation.');
            show('answer');
            return resolve();
          }
        } catch {
          /* reseau instable : nouvelle tentative au prochain tick */
        }
        state.timers.push(setTimeout(tick, POLL_MS));
        el('loading-hint').textContent =
          Date.now() - startedAt > 30000
            ? 'Encore quelques secondes, l’IA finalise les détails…'
            : 'Cela prend généralement moins d’une minute.';
        return undefined;
      };
      tick();
    });
  }

  /**
   * Validation par l'auteur : rien n'est publie tant qu'il n'a pas vu son
   * image et confirme. Il peut aussi demander une autre image, ou revenir
   * corriger son texte.
   */
  function renderReview(project) {
    clearTimers();
    hideError('review-error');
    el('review-img').src = project.imageUrl;
    el('review-title').textContent = project.title;
    el('review-summary').textContent = project.summary || project.answer;

    const max = (state.config && state.config.maxRenders) || 3;
    const left = Math.max(0, max - (project.renderCount || 1));
    el('btn-regenerate').disabled = left === 0;
    el('review-renders').textContent = left
      ? `${left} autre${left > 1 ? 's' : ''} image${left > 1 ? 's' : ''} possible${left > 1 ? 's' : ''}`
      : 'Nombre d’images atteint pour cette vision';

    show('review');
  }

  el('btn-publish').addEventListener('click', async () => {
    const button = el('btn-publish');
    button.disabled = true;
    hideError('review-error');
    try {
      const { project } = await api(`/projects/${state.project.id}/publish`, {
        method: 'POST',
        token: state.token,
        headers: kioskToken ? { 'x-kiosk-token': kioskToken } : {},
      });
      renderResult(project);
    } catch (err) {
      showError('review-error', err.message);
    } finally {
      button.disabled = false;
    }
  });

  el('btn-regenerate').addEventListener('click', async () => {
    const button = el('btn-regenerate');
    button.disabled = true;
    hideError('review-error');
    show('loading');
    try {
      const { project, renderMode } = await api(`/projects/${state.project.id}/regenerate`, {
        method: 'POST',
        token: state.token,
        headers: kioskToken ? { 'x-kiosk-token': kioskToken } : {},
      });
      if ((renderMode || state.config?.renderMode) === 'request') {
        api(`/projects/${project.id}/render`, {
          method: 'POST',
          token: state.token,
          headers: kioskToken ? { 'x-kiosk-token': kioskToken } : {},
        }).catch(() => {});
      }
      await waitForImage(project.id);
    } catch (err) {
      showError('review-error', err.message);
      renderReview(state.project);
    } finally {
      button.disabled = false;
    }
  });

  el('btn-edit').addEventListener('click', () => {
    clearTimers();
    show('answer');
    el('answer').focus();
  });

  function renderResult(project) {
    el('result-img').src = project.imageUrl;
    el('result-title').textContent = project.title;
    el('result-answer').textContent = project.summary || project.answer;
    show('result');

    let left = Math.round(RESULT_MS / 1000);
    const countdown = el('result-countdown');
    countdown.textContent = `Retour à l’accueil dans ${left} s`;
    const interval = setInterval(() => {
      left -= 1;
      countdown.textContent = `Retour à l’accueil dans ${left} s`;
      if (left <= 0) { clearInterval(interval); goHome(); }
    }, 1000);
    state.timers.push(interval);
  }

  // --- Navigation ---------------------------------------------------------
  el('btn-start').addEventListener('click', () => {
    if (state.config && !state.config.kioskOpen) return show('closed');
    show('identity');
    setTimeout(() => el('firstName').focus(), 150);
    return undefined;
  });

  document.querySelectorAll('[data-action="home"]').forEach((btn) => btn.addEventListener('click', goHome));

  idleTimer(IDLE_MS, () => {
    // On ne coupe jamais un ecran de generation ou de resultat en cours.
    const busy = !el('screen-loading').hidden || !el('screen-review').hidden || !el('screen-result').hidden;
    if (!busy && el('screen-attract').hidden) goHome();
  });

  loadConfig();
  setInterval(loadConfig, 30000);
  show('attract');
})();

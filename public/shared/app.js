/* Utilitaires partages par la borne, la WebApp de vote, l'ecran et l'admin. */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'mobiwish.token';

  const store = {
    get token() {
      try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
    },
    set token(value) {
      try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch { /* mode prive */ }
    },
  };

  /**
   * Les quatre interfaces sont servies par le CDN : elles s'affichent meme
   * quand l'hebergement n'est pas encore configure. Plutot que de laisser
   * l'utilisateur buter sur un formulaire qui ne peut pas repondre, on
   * recouvre la page par la liste de ce qui reste a brancher.
   */
  function showSetupNotice(missing) {
    if (document.getElementById('mw-setup')) return;

    const items = (missing || [])
      .map(
        (item) =>
          `<li><code>${esc(item.key)}</code><b>${esc(item.label)}</b><span>${esc(item.hint)}</span></li>`
      )
      .join('');

    const overlay = document.createElement('div');
    overlay.id = 'mw-setup';
    overlay.innerHTML = `
      <style>
        #mw-setup {
          position: fixed; inset: 0; z-index: 9999; overflow-y: auto;
          background: #f6f2ed; color: #17140f; padding: 2rem 1.25rem;
          font: 16px/1.55 "Segoe UI", -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;
        }
        #mw-setup .box { max-width: 44rem; margin-inline: auto; background: #fff; border-radius: 20px;
          padding: 1.8rem clamp(1.1rem, 4vw, 2.2rem); box-shadow: 0 10px 34px rgba(23, 20, 15, .09); }
        #mw-setup .tag { display: inline-block; background: #fff1e7; color: #d95300; font-weight: 700;
          font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; padding: .25rem .7rem; border-radius: 999px; }
        #mw-setup h2 { font-size: clamp(1.3rem, 4vw, 1.8rem); letter-spacing: -.02em; margin: .6rem 0 .5rem; }
        #mw-setup p { color: #5c5147; margin: 0 0 1rem; }
        #mw-setup ul { list-style: none; margin: 0 0 1.2rem; padding: 0; display: grid; gap: .6rem; }
        #mw-setup li { display: grid; gap: .1rem; background: #f9f5f0; border-left: 4px solid #ff6e14;
          border-radius: 10px; padding: .7rem .9rem; }
        #mw-setup code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .84rem;
          color: #d95300; font-weight: 700; }
        #mw-setup b { font-size: .96rem; }
        #mw-setup span { font-size: .86rem; color: #5c5147; }
        #mw-setup .fine { font-size: .84rem; color: #8d8175; margin: 0; }
      </style>
      <div class="box">
        <span class="tag">Configuration requise</span>
        <h2>Cette interface ne peut pas encore fonctionner</h2>
        <p>L’application est bien déployée, mais il lui manque les ressources ci-dessous.
           Aucun code d’accès ne pourra fonctionner tant qu’elles ne sont pas branchées.</p>
        <ul>${items || '<li><b>Ressource d’hébergement manquante</b></li>'}</ul>
        <p class="fine">Une fois ajoutées dans les réglages du projet, redéployez : cette page laissera
           place à la borne, à la WebApp de vote et au classement.</p>
      </div>`;

    document.body.appendChild(overlay);
  }

  async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
    const auth = token === undefined ? store.token : token;
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      if (payload?.error?.code === 'setup_required') showSetupNotice(payload.error.missing);
      const err = new Error(payload?.error?.message || `Erreur ${res.status}`);
      err.code = payload?.error?.code || 'http_error';
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  /** Flux temps reel avec reconnexion automatique. */
  function subscribe(handlers = {}) {
    let source;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/events');
      for (const [type, handler] of Object.entries(handlers)) {
        if (type === 'open' || type === 'error') continue;
        source.addEventListener(type, (evt) => {
          let data = {};
          try { data = JSON.parse(evt.data); } catch { /* ping */ }
          handler(data);
        });
      }
      source.addEventListener('open', () => handlers.open?.());
      source.onerror = () => {
        handlers.error?.();
        source.close();
        if (!closed) setTimeout(connect, 3000);
      };
    };

    connect();
    return { close() { closed = true; source?.close(); } };
  }

  /**
   * Mises a jour temps reel, quel que soit l'hebergement :
   *   - serveur durable  : flux SSE (/api/events) ;
   *   - serverless        : interrogation periodique de l'API.
   * La page fournit un seul rappel `onChange`, appele a chaque changement.
   */
  function live(onChange, options = {}) {
    const mode = options.mode || 'sse';
    const intervalMs = options.intervalMs || 5000;

    if (mode !== 'sse') {
      const timer = setInterval(onChange, intervalMs);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) onChange();
      });
      return { close() { clearInterval(timer); } };
    }

    return subscribe({
      open: options.onOpen,
      error: options.onError,
      'project:created': onChange,
      'project:ready': onChange,
      'project:failed': onChange,
      'project:updated': onChange,
      'project:deleted': onChange,
      'vote:cast': onChange,
      'settings:updated': onChange,
      'event:reset': onChange,
    });
  }

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const el = (id) => document.getElementById(id);

  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  /** Minuterie d'inactivite : remet la borne a l'ecran d'accueil. */
  function idleTimer(ms, onIdle) {
    let handle;
    const reset = () => {
      clearTimeout(handle);
      handle = setTimeout(onIdle, ms);
    };
    ['pointerdown', 'keydown', 'input', 'touchstart'].forEach((evt) =>
      document.addEventListener(evt, reset, { passive: true })
    );
    reset();
    return { reset, stop: () => clearTimeout(handle) };
  }

  global.MW = { api, store, subscribe, live, esc, el, plural, idleTimer, showSetupNotice };
})(window);

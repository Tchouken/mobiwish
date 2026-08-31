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

  global.MW = { api, store, subscribe, esc, el, plural, idleTimer };
})(window);

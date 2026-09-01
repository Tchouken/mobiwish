'use strict';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Page d'installation servie tant qu'il manque une ressource obligatoire.
 * Elle remplace un plantage opaque par la liste exacte de ce qui reste a
 * brancher, avec le chemin a suivre dans le tableau de bord.
 */
function setupPage(missing) {
  const items = missing
    .map(
      (item) => `
      <li>
        <code>${esc(item.key)}</code>
        <strong>${esc(item.label)}</strong>
        <span>${esc(item.hint)}</span>
      </li>`
    )
    .join('');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8" />
<title>Configuration requise — Borne IA &amp; vote mobile</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 2.5rem 1.5rem; background: #f6f2ed; color: #17140f;
         font: 16px/1.55 "Segoe UI", -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif; }
  main { max-width: 46rem; margin-inline: auto; background: #fff; border-radius: 20px;
         padding: 2rem clamp(1.2rem, 4vw, 2.4rem); box-shadow: 0 10px 34px rgba(23, 20, 15, .08); }
  h1 { font-size: clamp(1.5rem, 4vw, 2rem); letter-spacing: -.02em; margin: .2rem 0 .6rem; }
  p { color: #5c5147; }
  .tag { display: inline-block; background: #fff1e7; color: #d95300; font-weight: 700;
         font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; padding: .25rem .7rem; border-radius: 999px; }
  ol.steps { padding-left: 1.2rem; color: #5c5147; }
  ol.steps li { margin-bottom: .4rem; }
  ul.vars { list-style: none; margin: 1.2rem 0; padding: 0; display: grid; gap: .7rem; }
  ul.vars li { display: grid; gap: .15rem; background: #f9f5f0; border-left: 4px solid #ff6e14;
               border-radius: 10px; padding: .8rem 1rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; color: #d95300; font-weight: 700; }
  strong { font-size: .98rem; }
  span { font-size: .88rem; color: #5c5147; }
  footer { margin-top: 1.6rem; font-size: .85rem; color: #8d8175; }
</style></head>
<body><main>
  <span class="tag">Configuration requise</span>
  <h1>L’application est déployée, il reste à brancher ses ressources</h1>
  <p>Une plateforme serverless n’a ni disque persistant ni base intégrée. Ajoutez les éléments
     ci-dessous dans les réglages du projet, puis redéployez : cette page laissera place à la borne,
     à la WebApp de vote et à l’écran de classement.</p>
  <ul class="vars">${items}</ul>
  <ol class="steps">
    <li>Tableau de bord Vercel → <strong>Storage</strong> : créer la base Postgres et le store Blob, puis les relier à ce projet.</li>
    <li><strong>Settings → Environment Variables</strong> : ajouter les variables manquantes ci-dessus, plus <code>PUBLIC_URL</code>, <code>IMAGE_PROVIDER=openai</code> et <code>OPENAI_API_KEY</code>.</li>
    <li><strong>Redeploy</strong> : les tables sont créées au premier démarrage.</li>
  </ol>
  <footer>Diagnostic : <code>/healthz</code> — le détail de la configuration attendue est dans le README du dépôt.</footer>
</main></body></html>`;
}

module.exports = { setupPage };

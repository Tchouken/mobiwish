# MobiWish — Borne IA & vote mobile

Dispositif événementiel en deux volets, pensé pour une journée d’entreprise :

1. **La borne IA** (iPad Pro sur borne, à disposition toute la journée) — chaque collaborateur
   s’identifie simplement (prénom, nom, e-mail), répond à une question créative sur l’entreprise
   de demain, et l’IA génère instantanément une image illustrant son idée. L’ensemble constitue
   son « projet », qui rejoint la galerie des projets de la journée.
2. **Le vote sur mobile** — via un QR code affiché sur place, chacun accède depuis son téléphone
   à la galerie, s’identifie simplement et vote pour ses projets préférés (un vote unique par
   participant). Le classement est mis à jour en temps réel, idéal pour révéler les projets
   gagnants en fin de journée.

Le tout est une application Node.js autonome : un seul processus, une base SQLite, aucun service
externe obligatoire. Elle tourne sur un mini-PC ou un portable posé sur place, ou sur un petit
serveur si le lieu dispose d’une connexion fiable.

## Les quatre interfaces

| Adresse    | Écran                | Usage |
|------------|----------------------|-------|
| `/kiosk`   | Borne IA             | iPad Pro en mode kiosque, plein écran, retour automatique à l’accueil |
| `/vote`    | WebApp de vote       | Mobile des participants, cible du QR code |
| `/display` | Écran de l’événement | Vidéoprojecteur ou TV : podium, compteurs, QR code, mise à jour en direct |
| `/admin`   | Console d’animation  | Ouverture/fermeture de la borne et des votes, question, modération, export CSV |

## Démarrage

```bash
npm install
cp .env.example .env      # puis renseigner SESSION_SECRET, ADMIN_TOKEN, PUBLIC_URL
npm start                 # http://localhost:3000
```

Jeu de démonstration pour une répétition (projets + votes fictifs) :

```bash
npm run seed 8
```

Tests (parcours borne, règles de vote, classement, administration, flux temps réel) :

```bash
npm test
```

## Configuration (`.env`)

| Variable | Rôle |
|----------|------|
| `PORT` | Port d’écoute (3000 par défaut) |
| `PUBLIC_URL` | URL publique de l’événement : elle alimente le **QR code** affiché sur place |
| `SESSION_SECRET` | Secret de signature des sessions participants — **obligatoire en production** |
| `ADMIN_TOKEN` | Code d’accès à `/admin` |
| `KIOSK_TOKEN` | Code d’accès optionnel à la borne (`/kiosk?kiosk=CODE`, mémorisé sur l’iPad) |
| `IMAGE_PROVIDER` | `mock` (générateur local, sans clé) ou `openai` (API images, `gpt-image-1`) |
| `OPENAI_API_KEY` | Clé API si `IMAGE_PROVIDER=openai` |
| `IMAGE_STYLE` | Style graphique appliqué à toutes les images générées |
| `IMAGE_FALLBACK_MOCK` | `1` : bascule automatiquement sur le générateur local si l’API échoue le jour J |
| `DATA_DIR` | Dossier de la base SQLite et des images générées (`./data` par défaut) |

Le fournisseur `mock` compose une illustration abstraite déterministe : il permet de répéter
l’événement hors ligne, sert de démonstration, et constitue le filet de sécurité si l’API
d’images tombe pendant la journée.

**Ajouter un autre fournisseur d’images** : une fonction `generate(prompt, { seed })` renvoyant
`{ buffer, mime, ext, provider }`, ajoutée à `PROVIDERS` dans `server/services/imageProvider.js`.

## Déroulé d’une journée

1. **Avant** — dans `/admin` : nom de l’événement, question créative, nombre de votes par
   participant. La borne et les votes sont ouverts.
2. **Pendant** — la borne tourne en boucle sur l’iPad ; l’écran `/display` affiche le QR code,
   les compteurs et le classement en direct.
3. **Modération** — un projet peut être masqué (retiré de la galerie et du vote, conservé en
   base) ou supprimé depuis `/admin`.
4. **Suspense** — décocher « Résultats visibles » masque les scores côté mobile et écran jusqu’à
   la révélation ; refermer « Votes ouverts » fige le classement avant l’annonce.
5. **Après** — export CSV (projets, auteurs, e-mails, votes) depuis `/admin`.

## Règles de vote

- **Un bulletin unique par participant**, identifié par son adresse e-mail (insensible à la casse).
  Le bulletin est écrit en une seule transaction : aucun vote partiel n’est possible.
- Nombre de projets sélectionnables : réglable de 1 à 10 (3 par défaut).
- Un participant ne peut pas voter pour son propre projet (réglage désactivable).
- Les projets masqués, en cours de génération ou en échec ne sont pas votables.
- Classement avec rangs ex æquo (1, 1, 3, …), départagés par ordre de création.

## Personnalisation graphique

Toute la charte tient dans les variables CSS en tête de `public/shared/theme.css` (couleurs,
rayons, ombres, typographie). La palette par défaut reprend l’orange leboncoin sur fond sable.
Aucune ressource externe n’est chargée (ni police, ni CDN) : l’affichage reste identique même si
le Wi-Fi du lieu est capricieux.

## Confidentialité

- Les noms complets et adresses e-mail restent internes : la galerie et le classement n’affichent
  que « Prénom + initiale ».
- Aucune donnée n’est transmise à un tiers, hormis le texte de la réponse envoyé au fournisseur
  d’images lorsque `IMAGE_PROVIDER=openai`.
- `POST /api/admin/reset` (bouton « Réinitialiser l’événement ») purge projets, votes et
  participants après la journée.

## API

Publique :

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET`  | `/api/config` | Nom de l’événement, question, réglages, compteurs |
| `POST` | `/api/session` | Identification simple → jeton participant |
| `GET`  | `/api/me` | Session courante, projets, bulletin |
| `POST` | `/api/projects` | Création d’un projet depuis la borne (génération asynchrone) |
| `GET`  | `/api/projects` | Galerie des projets publiés |
| `GET`  | `/api/projects/:id` | Détail d’un projet (l’auteur voit aussi les états `generating`/`failed`) |
| `POST` | `/api/votes` | Dépôt du bulletin |
| `GET`  | `/api/leaderboard` | Classement |
| `GET`  | `/api/events` | Flux temps réel (SSE) |
| `GET`  | `/api/qr.svg` | QR code vers la page de vote |

Administration (en-tête `x-admin-token`) : `GET /api/admin/state`, `PUT /api/admin/settings`,
`POST /api/admin/projects/:id/visibility`, `DELETE /api/admin/projects/:id`,
`GET /api/admin/export.csv`, `POST /api/admin/reset`.

## Structure

```
server/            API Express, SQLite, génération d’images, flux SSE
  routes/          api.js (public) · admin.js (console)
  services/        store.js · imageProvider.js · generation.js · prompt.js · serialize.js
  util/            auth.js (jetons signés) · validate.js · rateLimit.js · ids.js
public/            Interfaces sans dépendance : kiosk · vote · display · admin · shared
scripts/seed.js    Jeu de démonstration
test/              Tests d’intégration (node:test)
```

## Recommandations d’exploitation

- **iPad** : ouvrir `/kiosk` dans Safari, « Sur l’écran d’accueil » pour le plein écran, puis
  activer l’Accès guidé. La borne revient seule à l’accueil (2 min d’inactivité, 60 s après
  l’affichage d’un résultat).
- **Réseau** : privilégier une connexion filaire ou un partage 4G dédié pour la machine hôte ;
  les mobiles n’ont besoin que d’accéder à `PUBLIC_URL`.
- **Sauvegarde** : le dossier `data/` (base SQLite + images) contient tout l’événement ; le copier
  en fin de journée suffit à archiver la galerie.

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

Tests (parcours borne, règles de vote, classement, administration, flux temps réel, mode
serverless, et exécution de **toutes les requêtes sur un vrai PostgreSQL** via PGlite) :

```bash
npm test
```

## Déploiement sur Vercel

Une fonction serverless n'a ni disque persistant ni processus qui survit à la réponse : il faut
donc une base gérée et un stockage objet. Le reste est automatique.

1. **Base PostgreSQL** — dans le projet Vercel : *Storage → Create Database → Neon* (ou Supabase).
   L'intégration injecte `DATABASE_URL`. Utiliser la chaîne **avec pooling**.
2. **Stockage des images** — *Storage → Create → Blob*. L'intégration injecte `BLOB_READ_WRITE_TOKEN`.
   Un store Blob est créé **public** ou **privé**, et ce choix ne se modifie plus ensuite :
   - **public** : les images sont servies directement par le CDN de Vercel. Rien à configurer.
   - **privé** : l'application relaie chaque image derrière sa propre adresse (`/media/…`), avec un
     cache CDN permanent — une seule lecture du stockage par image et par région. Les visuels ne
     sont alors accessibles qu'à travers l'application. Le mode privé exige `@vercel/blob` 2 ou
     supérieur ; les versions antérieures refusent `access: "private"` avant tout appel réseau.

   Rien à déclarer dans les deux cas : le mode est découvert au premier dépôt. `BLOB_ACCESS` permet
   de l'imposer, et l'autre mode reste tenté en secours plutôt que de bloquer la borne.
3. **Une seule variable à ajouter à la main** :

   ```
   GEMINI_API_KEY=<clé Google AI Studio>
   ```

   Le reste se déduit tout seul :
   - `IMAGE_PROVIDER` — déduit de la clé présente (`GEMINI_API_KEY` → Gemini, `OPENAI_API_KEY` → OpenAI, aucune → générateur local) ;
   - `PUBLIC_URL` — l'adresse du déploiement, sauf domaine personnalisé à déclarer ;
   - `SESSION_SECRET` — dérivé d'une valeur secrète déjà présente et stable ;
   - `BLOB_ACCESS` — le mode du store (public ou privé) est découvert au premier dépôt ;
   - `ADMIN_TOKEN` — à défaut, le code d'accès se choisit à la première ouverture de `/admin`,
     et n'est plus modifiable une fois qu'un participant existe. Le définir en variable reste
     possible et reste prioritaire.

   Chacune de ces variables peut être imposée explicitement : la configuration l'emporte
   toujours sur la déduction.

4. **Schéma de la base** : `npm run migrate` en local avec `DATABASE_URL` pointant sur la base de
   production, ou laisser `AUTO_MIGRATE=1` créer les tables au premier démarrage.
5. **Déployer** : `vercel --prod` (ou connecter le dépôt GitHub au projet — chaque push sur la
   branche de production déclenche alors un déploiement).
6. **Vérifier** : `npm run check -- https://votre-domaine` passe en revue l'application en ligne
   (base, stockage, interfaces, QR code, protection de la console) et sort en erreur s'il reste
   quelque chose à corriger.

Tant qu'une ressource obligatoire manque, l'application sert une page « Configuration requise »
qui liste précisément ce qui reste à brancher — au lieu de planter avec une erreur opaque.

`vercel.json` route `/api/*` vers la fonction Express (`api/index.js`, `maxDuration` 300 s pour
couvrir la génération d'image) et sert les quatre interfaces en statique depuis le CDN.

Garde-fous : l'application **refuse de démarrer** sur Vercel sans `DATABASE_URL` ou sans
`BLOB_READ_WRITE_TOKEN`, plutôt que d'écrire dans un disque éphémère et de perdre les projets.

### Tenue de charge

| Charge | Comportement |
|---|---|
| Galerie et classement | mis en cache 3 s par le CDN (`s-maxage`) : 1 000 mobiles qui rafraîchissent ne déclenchent que quelques requêtes vers la base |
| Vote | une écriture par participant, protégée par la clé primaire de `ballots` — un double envoi simultané renvoie `409`, jamais deux bulletins |
| Génération d'image | une fonction par projet, verrou en base (`claimProjectForRender`) : deux appels concurrents ne produisent jamais deux images |
| Base | quelques milliers de lignes sur la journée : très en deçà de ce qu'encaisse la plus petite offre Neon |

**Le facteur limitant n'est pas le serveur, c'est le nombre de bornes.** Un passage complet
(identification + rédaction + génération + écran de résultat) prend 1 min 30 à 2 min 30, soit
**25 à 35 projets par heure et par borne**, ~250 sur une journée de 8 h. Pour viser 1 000 projets,
prévoir **4 bornes** en parallèle (la WebApp de vote, elle, absorbe sans difficulté 1 000 votants).

Ordre de grandeur du coût de génération, à confirmer par un test réel avant l'événement (les
tarifs des modèles d'images évoluent, et `OPENAI_IMAGE_QUALITY` change tout) : en qualité
standard, compter quelques dizaines d'euros pour 1 000 images ; en qualité haute, plusieurs
centaines. Le mode `mock` permet de répéter le dispositif sans dépenser un centime.

## Configuration (`.env`)

| Variable | Rôle |
|----------|------|
| `PORT` | Port d’écoute (3000 par défaut) |
| `PUBLIC_URL` | URL publique de l’événement : elle alimente le **QR code** affiché sur place |
| `SESSION_SECRET` | Secret de signature des sessions participants — **obligatoire en production** |
| `ADMIN_TOKEN` | Code d’accès à `/admin` |
| `KIOSK_TOKEN` | Code d’accès optionnel à la borne (`/kiosk?kiosk=CODE`, mémorisé sur l’iPad) |
| `DB_DRIVER` | `sqlite` (défaut) ou `postgres` — déduit automatiquement de `DATABASE_URL` |
| `DATABASE_URL` | Chaîne PostgreSQL **avec pooling** (Neon, Supabase, RDS…) |
| `STORAGE_DRIVER` | `disk` (défaut) ou `blob` (Vercel Blob) |
| `BLOB_ACCESS` | `public` (défaut) ou `private`, selon le store Blob créé |
| `RENDER_MODE` | `inline` (serveur durable) ou `request` (serverless) |
| `REALTIME` | `sse` (serveur durable) ou `poll` (serverless) |
| `PUBLIC_CACHE_SECONDS` | Durée de cache CDN des réponses publiques |
| `IMAGE_PROVIDER` | `mock` (générateur local, sans clé), `gemini` (Google) ou `openai` |
| `GEMINI_API_KEY` | Clé Google AI Studio si `IMAGE_PROVIDER=gemini` |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` par défaut |
| `OPENAI_IMAGE_QUALITY` | `low`, `medium` ou `high` — pèse directement sur le coût et la durée |
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

| `POST` | `/api/projects/:id/render` | Génère l’image (hébergement serverless) — idempotent |

Administration (en-tête `x-admin-token`) : `GET /api/admin/state`, `PUT /api/admin/settings`,
`POST /api/admin/projects/:id/visibility`, `DELETE /api/admin/projects/:id`,
`GET /api/admin/export.csv`, `POST /api/admin/reset`.

## Structure

```
api/index.js       Point d’entrée serverless (Vercel)
vercel.json        Routage, durée max de fonction, en-têtes de cache
server/
  db/              driver.js (SQLite | PostgreSQL) · schema.js · index.js
  routes/          api.js (public) · admin.js (console)
  services/        store.js · imageProvider.js · generation.js · media.js · prompt.js · serialize.js
  util/            auth.js (jetons signés) · validate.js · rateLimit.js · ids.js
public/            Interfaces sans dépendance : kiosk · vote · display · admin · shared
scripts/           migrate.js (schéma) · seed.js (jeu de démonstration)
test/              Tests d’intégration, dont l’exécution de toutes les requêtes sur PostgreSQL
```

## Recommandations d’exploitation

- **iPad** : ouvrir `/kiosk` dans Safari, « Sur l’écran d’accueil » pour le plein écran, puis
  activer l’Accès guidé. La borne revient seule à l’accueil (2 min d’inactivité, 60 s après
  l’affichage d’un résultat).
- **Réseau** : privilégier une connexion filaire ou un partage 4G dédié pour la machine hôte ;
  les mobiles n’ont besoin que d’accéder à `PUBLIC_URL`.
- **Sauvegarde** : le dossier `data/` (base SQLite + images) contient tout l’événement ; le copier
  en fin de journée suffit à archiver la galerie.

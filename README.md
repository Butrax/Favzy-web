# Favzy web : Bookmark manager

**Favzy** est un gestionnaire de marque-pages personnel : protégé par mot de passe, accessible depuis n'importe quel appareil, **sans base de données**.

- Les marque-pages vivent dans **un seul fichier JSON** (`bookmarks.json`) d'un **dépôt GitHub privé** (`favzy-stock`). Chaque modification est un commit : tu as gratuitement l'historique complet et un « annuler » (`git revert`).
- L'application (`favzy-web`) est un site statique + 4 petites fonctions Vercel. Aucune dépendance npm.
- Le mot de passe et les clés ne sont que dans les **variables d'environnement Vercel**, jamais dans un dépôt.
- La navigation est **100 % locale et déterministe** : aucune IA, aucun appel externe, aucun service tiers.

```
Navigateur ──► Vercel (favzy-web) ──► API GitHub ──► dépôt privé favzy-stock
               pages + /api/*          token limité     bookmarks.json
```

## Mise en place (≈ 10 minutes)

### 1. Le dépôt de données (`favzy-stock`)
Déjà créé, privé. Rien à y mettre : `bookmarks.json` est créé tout seul au premier ajout
(si tu préfères, crée-le toi-même avec `{"version":2,"primaryTags":[],"bookmarks":[]}`).

### 2. Le token GitHub (accès limité à ce seul dépôt)
GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- **Repository access** : *Only select repositories* → `favzy-stock`
- **Repository permissions** : *Contents* → **Read and write** (le reste reste sur « No access »)
- **Expiration** : 1 an (note la date : à l'expiration, l'appli affichera « Token GitHub invalide ou expiré »)

Copie le token (`github_pat_…`), il ne s'affiche qu'une fois.

### 3. Pousser le code (`favzy-web`)
Dépose le contenu de ce dossier à la racine du dépôt `favzy-web`.

### 4. Déployer sur Vercel
**Add New → Project → importer `favzy-web`.** Laisse le preset sur *Other*, sans commande de build. (Si la page d'accueil affiche une 404, règle *Output Directory* sur `public`.)

### 5. Variables d'environnement
Project → **Settings → Environment Variables**, puis redéploie :

| Variable | Valeur |
|---|---|
| `APP_PASSWORD` | ton mot de passe (long : c'est la seule barrière) |
| `SESSION_SECRET` | chaîne aléatoire d'au moins 32 caractères (`openssl rand -base64 48`) |
| `GITHUB_REPO` | `ton-pseudo/favzy-stock` |
| `GITHUB_TOKEN` | le token de l'étape 2 |
| `GITHUB_BRANCH` | *(optionnel)* `main` par défaut |
| `GITHUB_FILE` | *(optionnel)* `bookmarks.json` par défaut |

Si une variable manque, la page de connexion affiche précisément laquelle.

## Utilisation

### Navigation par tags (il n'y a plus de dossiers)
Chaque favori porte des **tags**. Certains sont **principaux** (les grandes catégories : Musique, Informatique, Sport…), tous les autres sont **secondaires**.

1. **Boîte « Tags principaux »** : le bouton **⚙** (présent aussi dans la boîte des secondaires) ouvre la fenêtre « Gérer les tags », qui liste *tous* les tags de tes favoris ; coche ceux qui sont des tags principaux, puis Enregistrer. Tant qu'aucun n'est défini, la boîte te l'indique.
2. Clique sur un ou plusieurs tags principaux. Les autres tags principaux sont filtrés : seuls restent ceux qui existent sur au moins un favori de la sélection (Musique + Sport est masqué s'aucun favori n'a les deux).
3. **Boîte « Tags secondaires »** : une liste unique des tags qui coexistent avec ta sélection, avec leur nombre de favoris. Elle reste vide tant que tu n'as rien sélectionné (jamais tous les secondaires d'un coup) ; sa recherche permet de retrouver directement un tag.
4. **Logique ET stricte** : un favori doit avoir *tous* les tags sélectionnés. Tout est recalculé en direct, sans bouton « Appliquer ».
5. Les filtres actifs restent visibles en haut de la liste, chacun se retire d'un clic sur ✕ ; **Tout réinitialiser** remet tout à zéro. Retirer un filtre ne touche pas aux autres et réaffiche les tags redevenus pertinents. Un clic sur le tag d'une carte l'ajoute aux filtres.

Les tags sont **toujours triés par ordre alphabétique** (boîtes, cartes, suggestions) : sans tenir compte de la casse ni des accents, et dans l'ordre naturel pour les nombres (« Tag 2 » avant « Tag 10 »). Le nombre de favoris n'influence jamais l'ordre, donc un tag ne change pas de place quand on le sélectionne.

### Renommer un tag
Dans « Gérer les tags » (⚙), le bouton **✎** d'un tag ouvre une fenêtre de renommage. Le nouveau nom est appliqué **à tous les favoris qui portent ce tag**, en une seule modification (un seul commit dans `favzy-stock`) :
- si le tag était principal, il le reste ; si un filtre actif portait son nom, le filtre suit ;
- si le nouveau nom est celui d'un **autre tag existant**, les deux tags sont **fusionnés** : la fenêtre te prévient et le bouton devient « Fusionner ». Un favori qui avait les deux n'a plus de doublon, et le tag fusionné est principal si l'un des deux l'était ;
- un simple changement de casse (« musique » → « Musique ») est accepté. Une virgule est refusée (elle sépare les tags).

La recherche texte (touche `/`) et « ★ Favoris seulement » se combinent avec les tags : suggestions et compteurs en tiennent compte. **« Sans tag »** (avec son compteur) n'affiche que les favoris qui n'ont aucun tag, pour les retrouver et les étiqueter, par exemple avec Sélectionner → Tout sélectionner → Ajouter des tags ; ce filtre et la sélection de tags s'excluent (un favori sans tag ne peut pas porter un tag choisi). Rien n'est stocké comme « relation entre tags » : la coexistence se déduit des favoris.

### Ajouter un lot de tags à plusieurs favoris
1. Clique sur **Sélectionner** (au-dessus de la liste) : la pastille d'initiale de chaque carte devient une case à cocher. **Maj + clic** coche une plage de cartes.
2. **Tout sélectionner (n)** coche tous les favoris actuellement affichés. Combiné avec les filtres, c'est le moyen le plus rapide : filtre par exemple sur « Musique », puis tout sélectionner.
3. **Ajouter des tags…** ouvre une fenêtre : saisis les tags (séparés par des virgules) ou clique sur les tags existants. Le résumé indique les tags qui n'existent pas encore.

Les tags sont ajoutés à chaque favori coché **sans toucher à ses autres tags**, sans doublon, et un tag saisi « linux » reprend l'écriture existante « Linux ». Tout le lot est enregistré en **un seul commit**. La barre indique « dont N masqués par les filtres » si des favoris cochés ne sont plus affichés ; **Terminer** quitte le mode et décoche tout. Si aucun favori n'a rien à gagner, rien n'est écrit.

### Descriptions multi-lignes et notes
- La **description** conserve les retours à la ligne (saisie, enregistrement et affichage). Les espaces en trop et les séries de plus de deux lignes vides sont réduits. Limite : 5 000 caractères ; une carte de lien en affiche 4 lignes au plus.
- **Une note** est un favori **sans URL** : laisse le champ adresse vide. Il faut alors un titre ou une description (sans titre, la première ligne de la description sert de titre). Une note s'affiche en entier, avec la pastille ✎ et « Note » à la place du site ; elle a des tags, peut être mise en favori, filtrée, cherchée et sélectionnée comme les autres. Elle n'est jamais signalée comme doublon.
- Ajouter une adresse à une note la transforme en lien, et inversement. L'**import/export JSON** garde les notes ; l'**export HTML** (format des navigateurs) les omet, faute d'adresse.

### Le reste
- **Ajout rapide** : colle une adresse, le titre et la description sont récupérés automatiquement. Les doublons sont signalés (l'ancre `#…` et les `utm_*` sont ignorés). Le formulaire propose les tags existants en un clic ; un tag saisi avec une autre casse (« musique ») reprend l'écriture existante (« Musique »). Un nouveau favori reprend les tags actuellement sélectionnés. À l'ajout, le bouton **« Reprendre les tags du dernier favori »** ajoute d'un clic tous les tags du favori le plus récent (selon sa date d'ajout) à ceux déjà saisis ; il disparaît quand ils sont tous repris et n'est pas proposé à la modification.
- **Bookmarklet** (⚙ en haut → Outils) : glisse le bouton dans la barre de favoris ; un clic sur n'importe quelle page l'ajoute.
- **Import** d'un export HTML de Chrome, Firefox, Edge ou Safari (tags, dates et descriptions conservés ; **les dossiers du navigateur ne le sont pas**), ou d'un export JSON Favzy (qui restaure aussi les tags principaux). **Export** HTML (réimportable dans un navigateur) et JSON.
- **Mobile** : « Ajouter à l'écran d'accueil » installe Favzy comme une application ; sur Android, elle apparaît ensuite dans le menu **Partager**. Les boîtes de tags s'ouvrent avec le bouton ☰.

## Format des données

```json
{
  "version": 2,
  "primaryTags": ["Musique", "Informatique", "Sport"],
  "bookmarks": [
    { "id": "…", "url": "https://…", "title": "…", "description": "", "tags": ["Musique", "VST"], "favorite": false, "createdAt": "…" }
  ]
}
```

Les tags se comparent sans tenir compte de la casse. **Migration** : un fichier de l'ancienne version (avec des dossiers) se lit sans rien faire ; le champ `folder` est retiré à la prochaine écriture (les anciennes valeurs restent dans l'historique Git de `favzy-stock`). Les tags existants sont d'abord tous secondaires : définis les principaux avec le bouton ⚙.

## En local

```bash
npm i -g vercel
cp .env.example .env.local     # puis remplis les valeurs
vercel dev                     # http://localhost:3000
npm test                       # 47 tests (API avec GitHub simulé + moteur de tags), aucun réseau
```

## Sécurité : ce qui est fait, et les limites

- Mot de passe comparé en temps constant ; session = cookie `HttpOnly`, `Secure`, `SameSite=Strict`, signé HMAC-SHA256, valable 30 jours. Changer `SESSION_SECRET` déconnecte tous les appareils.
- Toutes les routes `/api` (sauf `login`) exigent la session ; les écritures vérifient en plus l'en-tête `Origin`.
- CSP stricte (aucun script ni style en ligne, aucune ressource externe), pas de `Referer` envoyé, `noindex`. Pas de favicons chargés depuis un service tiers : aucun site n'est révélé à un tiers.
- Récupération du titre protégée contre le **SSRF** : http(s) seulement, ports 80/443, adresses privées/locales refusées (vérifiées au moment de la connexion, donc aussi contre le DNS rebinding), redirections revalidées.
- **Limite** : sans base de données, il n'y a pas de vrai blocage après N échecs de connexion, seulement un ralentissement de 1 s par essai. D'où l'importance d'un mot de passe long. Tu peux aussi ajouter une règle de limitation de débit sur `/api/login` dans le pare-feu Vercel si ton offre le permet.

## Limites techniques

- Le fichier est lu via l'API Contents de GitHub (jusqu'à 1 Mo, soit plusieurs milliers de marque-pages). Au-delà, l'appli le signale.
- **Jauge de stockage** : en bas de la barre latérale (☰ sur mobile), une barre indique le pourcentage restant (par rapport à 1 Mo). Elle passe en orange à 80 % d'utilisation et en rouge à 95 %. Si une écriture ferait dépasser 1 Mo, elle est **refusée** avec le message « Stockage plein » (sinon le fichier ne pourrait plus être relu) ; supprimer des favoris reste toujours possible, pense à exporter une sauvegarde JSON avant de faire du tri.
- Chaque écriture prend environ 1 seconde (un commit) ; une opération qui ne change rien n'écrit rien. Deux écritures simultanées depuis deux appareils sont gérées : l'appli relit et rejoue la modification.
- Les favoris sans aucun tag principal ne sont atteignables que par la liste complète (aucun filtre) ou la recherche texte.

## Structure

```
api/
  login.js  logout.js  bookmarks.js  title.js
  _lib/     auth.js  github.js  bookmarks.js  safe-fetch.js  http.js
public/
  index.html  style.css  app.js  tagnav.js  netscape.js  manifest.webmanifest  icônes
tests/
  api.test.js  tagnav.test.js
vercel.json   package.json   .env.example
```

`public/tagnav.js` est le moteur de navigation par tags : un module pur (sans DOM ni réseau) qui calcule, à partir des favoris et de la sélection, les résultats, les tags disponibles et les compteurs.

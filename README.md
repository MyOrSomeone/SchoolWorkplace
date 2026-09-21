# SchoolWorkspace — architecture

## Render (backend uniquement)
- app.py
- ed_service.py
- requirements.txt

## Frontend local
- index.html
- app.js
- loading.json
- data/schedule_default.js   <-- doit exister à côté d'index.html (voir plus bas)

Le frontend utilise `https://schoolworkplace.onrender.com` comme API.
`homeworks`, `schedule_changes`, `messages` (cache/synchronisation) et `notebooks` utilisent Firestore, côté frontend uniquement (Render n'y touche pas).

### Firebase (frontend uniquement)
Dans `index.html`, remplace les valeurs de `window.SCHOOLWORKSPACE_FIREBASE_CONFIG` par ta vraie config Firebase. Le backend Render n'utilise PAS Firebase pour l'instant (voir plus bas).

## Ce qui a changé dans cette version

Cette version repart de tes fichiers `_local` (`app_local.py`, `ed_service_local.py`), qui fonctionnent de manière fiable, plutôt que de la version précédente. Les seules différences avec `_local` :

1. **CORS activé** (`flask-cors`) : le frontend est ouvert en local (ou servi ailleurs) et appelle Render depuis une autre origine.
2. **Identifiants par requête** : le frontend envoie l'identifiant/mot de passe ÉcoleDirecte à chaque appel à `/api/data` (header `X-ED-Username`/`X-ED-Password` ou JSON `{username, password}`). En secours, `ECOLEDIRECTE_USERNAME`/`ECOLEDIRECTE_PASSWORD` (variables d'environnement Render) ou un `credentials.py` local fonctionnent aussi.
3. **`/api/data` n'utilise plus les fichiers JSON locaux** (`schedule_default.json`, `schedule_changes.json`, `homework_local.json`) : sur Render, ils ne survivraient pas aux redémarrages de toute façon. Le planning par défaut, les surcharges et les devoirs locaux sont gérés côté frontend (Firestore + `data/schedule_default.js`).
4. **Beaucoup de `print(..., flush=True)`** dans `ed_service.py` et `app.py`, pour voir dans les logs Render exactement ce qui se passe à chaque étape de la connexion ÉcoleDirecte (GTK, code retourné par ED, QCM, etc.).
5. **Un coupe-circuit anti-rafale minimal, sans Firebase ni base de données** : si ÉcoleDirecte refuse 2 connexions d'affilée pour un compte, le backend arrête de retenter pendant 2 minutes plutôt que de renvoyer une requête à chaque appel entrant. C'est juste une variable en mémoire : un redémarrage du service la remet à zéro. Aucune configuration nécessaire.
6. **Pas de Firebase côté backend** : contrairement à la version précédente, `ed_service.py` ne dépend plus de `firebase-admin` ni de `ECOLEDIRECTE_CN`/`ECOLEDIRECTE_CV`. Il se comporte exactement comme `ed_service_local.py` : au démarrage, s'il n'a pas de `tokens.json` valide, il refait une connexion complète (identifiant + mot de passe), ÉcoleDirecte demande alors le QCM (code 250), et `_solve_qcm()` le résout automatiquement — sans aucune intervention manuelle.

## Variables d'environnement Render — à FAIRE

**À SUPPRIMER** (si elles existent encore) : `ECOLEDIRECTE_CN` et `ECOLEDIRECTE_CV` (et leurs alias `ED_CN`/`ED_CV`).
Elles ne sont plus lues par le code, et c'est probablement elles qui causaient le problème : figées au moment où tu les as copiées, elles étaient invalides pour Render, provoquaient un 505, le code les effaçait puis retentait — à chaque redémarrage du service gratuit (le disque est remis à zéro à chaque réveil), ce qui a pu accumuler beaucoup de tentatives échouées sur ton compte ÉcoleDirecte.

**Optionnel, pratique pour tester sans le frontend** : `ECOLEDIRECTE_USERNAME` et `ECOLEDIRECTE_PASSWORD`. Si tu les ajoutes, tu peux appeler `https://schoolworkplace.onrender.com/api/data` directement (GET) depuis un navigateur pour tester, sans avoir à envoyer les identifiants à chaque fois.

**Si tu avais ajouté `FIREBASE_SERVICE_ACCOUNT_FILE`/`FIREBASE_SERVICE_ACCOUNT_JSON` la dernière fois** : ils peuvent aussi être supprimés, `ed_service.py` ne les regarde plus.

## Pourquoi ça devrait marcher maintenant (et comment vérifier si ce n'est pas le cas)

À chaque redémarrage de Render (offre gratuite → redémarre après ~15 min d'inactivité), `ed_service.py` va maintenant systématiquement : se connecter à froid → ÉcoleDirecte répond 250 (nouvel appareil) → le QCM est résolu automatiquement → connexion réussie. C'est exactement le chemin qui fonctionne déjà avec `ed_service_local.py`, simplement rejoué depuis l'IP de Render.

**Si ça échoue encore avec un 505**, regarde les logs Render (Dashboard → ton service → Logs) juste après un appel à `/api/data`. Avec tous les `print(flush=True)` ajoutés, tu dois voir une ligne `[ED][LOGIN] tentative (...)`, puis `[ED][LOGIN] réponse HTTP ..., code ED=...`. Deux cas possibles :
- Tu vois `code ED=250` puis les lignes `[ED][QCM] ...` : le QCM est bien déclenché et résolu, donc le problème est ailleurs (regarde le message d'erreur final).
- Tu vois directement `code ED=505` **dès la toute première tentative**, sans jamais passer par 250 : ça veut dire qu'ÉcoleDirecte rejette la connexion avant même de proposer le QCM. Comme le même compte fonctionne actuellement en local et sur le site officiel, ce cas précis pointerait vers un blocage spécifique à l'infrastructure de Render (IP de datacenter), qu'aucun changement de code ne peut contourner — il faudrait alors soit contacter ÉcoleDirecte, soit héberger le backend ailleurs.

Envoie-moi le contenu de ces logs si le problème persiste : avec les codes ED précis à chaque étape, on saura immédiatement dans lequel des deux cas on est.

## data/schedule_default.js — chargement manquant corrigé

En vérifiant `index.html`, `data/schedule_default.js` n'était en fait jamais chargé (aucune balise `<script>` ne le référençait), donc `window.SCHOOLWORKSPACE_DEFAULT_SCHEDULE` restait toujours vide et le planning par défaut aussi — même quand Render répondait. J'ai ajouté le chargement de ce fichier avant `app.js` (avec un ordre d'exécution garanti), donc le planning par défaut s'affichera bien si Render ne répond pas.

Assure-toi juste que le fichier `data/schedule_default.js` existe réellement à côté de ton `index.html`, avec ce format :
```js
window.SCHOOLWORKSPACE_DEFAULT_SCHEDULE = {
  vacances: [ { debut: "2026-10-17", fin: "2026-11-02", nom: "Vacances de la Toussaint" }, ... ],
  semaine_paire: { lundi: [...], mardi: [...], ... },
  semaine_impaire: { lundi: [...], mardi: [...], ... }
};
```
Si tu n'as encore que l'ancien `schedule_default.json`, envoie-moi son contenu et je le convertis directement dans ce format.

La logique de repli côté frontend (`getScheduleForDate()` dans `app.js`) fonctionnait déjà correctement : surcharge locale > API ÉcoleDirecte > planning par défaut. Le seul problème était que la troisième couche n'avait jamais de données à cause du script manquant.

### Note sur QCM_ANSWERS
`ed_service.py` contient en clair la date de naissance, la classe et le nom du professeur principal utilisés pour répondre automatiquement au QCM de double authentification. Comme pour les tokens, si le dépôt GitHub est public, il vaut mieux déplacer ces valeurs vers des variables d'environnement plutôt que de les laisser en clair dans le code source.

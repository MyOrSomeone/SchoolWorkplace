# SchoolWorkspace — architecture finale

## Render (backend uniquement)
- app.py
- ed_service.py
- requirements.txt

## Frontend local
- index.html
- app.js
- loading.json
- data/schedule_default.js

Le frontend utilise `https://schoolworkplace.onrender.com` comme API.
Le planning récurrent vient de `data/schedule_default.js`.
`homeworks`, `schedule_changes`, `messages` (cache/synchronisation) et `notebooks` utilisent Firestore.

### Firebase
Dans `index.html`, remplace uniquement les valeurs de `window.SCHOOLWORKSPACE_FIREBASE_CONFIG` par ta vraie config Firebase.

### ÉcoleDirecte
Le backend accepte les identifiants envoyés par le frontend et conserve le mécanisme d'authentification de la version fonctionnelle (`tokens.json`, GTK, QCM, cn/cv).
Pour reproduire une session fonctionnelle sur Render sans mettre les tokens dans GitHub, `ed_service.py` accepte aussi `ECOLEDIRECTE_CN` et `ECOLEDIRECTE_CV` comme variables d'environnement Render (voir "Diagnostic 505" ci-dessous pour les limites de cette approche).

### Diagnostic de l'erreur 505 (session Render)

Ce que les tests ont montré :
- Le mot de passe transite correctement jusqu'à Render (hash identique des deux côtés).
- Une tentative de connexion en Python **depuis le PC local**, sans cn/cv, renvoie aussi 505 "Mot de passe invalide" malgré un mot de passe correct.
- `ed_service.py` gère déjà tout seul le QCM de double authentification (code 250) : il n'y a pas besoin d'intervention manuelle pour ça.

Le deuxième point est la clé : un identifiant/mot de passe correct envoyé sans cn/cv devrait normalement renvoyer le code 250 (nouvel appareil, QCM à résoudre), pas 505. Obtenir 505 même en local suggère que ce n'est pas (uniquement) une histoire d'adresse IP de Render, mais plutôt que le **compte ÉcoleDirecte** est temporairement bloqué par leur protection anti-brute-force — probablement déclenché par le grand nombre de tentatives de connexion automatiques ratées accumulées pendant le débogage.

Un vrai bug contribuait à ces tentatives répétées : sur l'offre gratuite de Render, le système de fichiers est effacé à chaque mise en veille/redémarrage du service (cf. `render.com/docs/disks`). Donc `tokens.json` ne survivait jamais, et à chaque réveil du service, `ed_service.py` repartait des `ECOLEDIRECTE_CN`/`ECOLEDIRECTE_CV` figés (potentiellement déjà invalides), échouait, effaçait les tokens, retentait sans cn/cv — soit jusqu'à 2 requêtes de connexion à ÉcoleDirecte à chaque réveil du service, répétées à chaque cycle de mise en veille pendant plusieurs jours de tests.

**Ce qui a été corrigé dans le code :**
1. `ed_service.py` expose maintenant un `token_store` interchangeable (fichier local par défaut, Firestore en option — voir plus bas) au lieu d'un simple fichier qui ne survit pas aux redémarrages Render.
2. `app.py` ajoute un coupe-circuit anti-rafale : après 2 échecs de connexion ÉcoleDirecte d'affilée pour un compte, il arrête de retenter pendant 3 minutes (au lieu de renvoyer une requête à chaque appel entrant), pour ne pas aggraver/prolonger un éventuel blocage de sécurité.

**Ce qu'il reste à faire côté compte (pas du code) :**
1. Vérifie que la connexion fonctionne bien depuis le site ou l'appli officielle ÉcoleDirecte, avec le même identifiant/mot de passe. Si ça échoue aussi là, le mot de passe a probablement changé ou le compte est bloqué — utilise "mot de passe oublié" sur le site officiel. Si ça fonctionne, le blocage est probablement limité à l'API de connexion.
2. Arrête les tests automatisés répétés pendant un moment (quelques dizaines de minutes) pour laisser un éventuel blocage anti-brute-force se lever de lui-même.
3. Une fois la connexion officielle confirmée, retente `/api/data` : avec le coupe-circuit, tu sauras vite si ÉcoleDirecte a débloqué la situation ou si ça boucle encore.

### Persistance des tokens via Firestore (optionnel mais recommandé sur Render)

Pour que les cn/cv obtenus après un QCM survivent réellement aux redémarrages Render (au lieu de dépendre de variables d'environnement figées) :
1. Dans la console Firebase du projet déjà utilisé par le frontend → Paramètres du projet → Comptes de service → "Générer une nouvelle clé privée". Ça télécharge un fichier JSON.
2. Dans Render → ton service → Environment → **Secret Files** : ajoute ce fichier JSON (ex. nom `firebase-service-account.json`, monté par Render sous `/etc/secrets/firebase-service-account.json`).
3. Ajoute la variable d'environnement `FIREBASE_SERVICE_ACCOUNT_FILE` = `/etc/secrets/firebase-service-account.json`.
4. Redéploie. `ed_service.py` détecte automatiquement Firestore et l'utilise ; sans cette configuration, il continue de fonctionner comme avant (fichier local + variables `ECOLEDIRECTE_CN`/`ECOLEDIRECTE_CV`).

Ne mets jamais ce fichier de compte de service sur GitHub (même logique que pour `tokens.json`).

### Note sur QCM_ANSWERS
`ed_service.py` contient en clair la date de naissance, la classe et le nom du professeur principal utilisés pour répondre automatiquement au QCM de double authentification. Comme pour les tokens, si le dépôt GitHub est public, il vaut mieux déplacer ces valeurs vers des variables d'environnement plutôt que de les laisser en clair dans le code source.

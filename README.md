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
Pour reproduire une session fonctionnelle sur Render sans mettre les tokens dans GitHub, `ed_service.py` accepte aussi `ECOLEDIRECTE_CN` et `ECOLEDIRECTE_CV` comme variables d'environnement Render.

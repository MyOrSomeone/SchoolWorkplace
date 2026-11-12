# SchoolWorkplace

## 1. Mettre à jour Python (le FutureWarning)
Le message `You are using a Python version (3.11.9) which Google will stop supporting…` n'est **pas une erreur** (rien ne casse avant octobre 2027) ; `app.py` le masque.
Le vrai correctif :
```powershell
cd D:\MesDocs\Apps\SchoolWorkplace
Remove-Item -Recurse -Force .venv
py -3.12 -m venv .venv          # ou py -3.13
.venv\Scripts\activate
python -m pip install -U pip
python -m pip install -r requirements.txt
python -m pip list --outdated
```

## 2. Mettre à jour le projet sans perdre tes cours
Copie les **fichiers de code** (`app.py`, `SchoolWorkplace.html`, tout `notebooks/*.py`, `notebooks.css`, `notebooks.js`, `notebooks.doc.json`, `README.md`, `requirements.txt`) par-dessus les tiens.
**Ne remplace pas `notebooks/data/`** : c'est là que vivent tes matières (SPC, Anglais…). Le bloc de mise en page (`nb-layout`) s'installe tout seul dans ton CSS partagé au premier lancement, sans rien écraser.

## 3. Niveau de créativité (panneau IA → « Créativité »)
Le curseur règle, **par matière**, combien d'éléments *visuels* (on regarde : schéma annoté, infographie, frise…) et *interactifs* (on manipule : simulation, étapes cliquables, carte de concepts…) l'IA doit mettre dans le cours.

| Niveau | Par grande partie (niveau 1) |
|---|---|
| 0 · Cours seul | texte fidèle à tes notes, rien d'ajouté |
| 1 · Léger | un schéma quand c'est utile (une partie sur deux) |
| 2 · Équilibré | ≥ 1 visuel · 1 interactif pour 2 parties |
| 3 · Riche | ≥ 1 visuel **et** ≥ 1 interactif |
| 4 · Maximal | ≥ 2 visuels et 1 à 2 interactifs ambitieux : cours illustré et manipulable de bout en bout |

Ce n'est pas qu'une consigne : **le code compte** ce que l'IA a produit et la relance une fois, avec la liste précise de ce qui manque, si le quota n'est pas atteint.
*Mini-film* : case séparée, **désactivée par défaut** (utile en sciences, bizarre ailleurs) ; sans elle, l'IA n'en fait jamais.

## 4. Comment l'IA travaille maintenant
* **Elle voit les chapitres déjà écrits** (« mémoire du cours ») : plan, éléments déjà créés, couleurs utilisées, couleur suggérée pour un nouveau chapitre, et une partie de référence à égaler.
* **Elle délègue** : après `add_part`, elle appelle `request_visual` / `request_interactive` (/ `request_film`). Le système pose un emplacement `<div class="nb-slot">` dans la partie, l'inscrit au registre (`_src/slots.json`) et met la réalisation en file. Un **spécialiste** (Gemini ou IA locale) réalise l'élément ensuite, un par un, **en arrière-plan** (état affiché sous le bouton ; quota épuisé = pause, reprise avec « ▶ Reprendre »).
* **Cahier des charges obligatoire** (but, contenu exact recopié du cours, interactions) : trop mince = refusé, l'IA doit le compléter.
* **Commencer / finir** : elle peut passer un code *partiel* (`partial_html`, `partial_js`) et décrire ce qui `remaining` ; l'IA suivante reçoit le brief, le code déjà écrit et le reste à faire. Les éléments en attente sont listés dans son prompt (`ÉLÉMENTS DÉJÀ DEMANDÉS`), elle peut en terminer un avec `complete_slot`. Un élément déjà fait ne peut pas être redemandé (doublon refusé) ; « Refaire » remplace l'ancien (sauvegardé dans l'historique).
* **Moins d'appels inutiles** : 2 outils de lecture au plus par lot (tout est déjà dans le prompt), lectures identiques mises en cache, les photos ne sont renvoyées qu'au premier tour, arrêt après 3 tours d'erreurs d'outils, lots de 2 pages (`NB_SOURCES_PER_BATCH`).
* **Corrections automatiques** des erreurs récurrentes : `$…$` → `\(…\)` (le lecteur ne rend que `\( \)` et `\[ \]`), `ico-badge` posé sur `<i>`, `text-white` dans un en-tête.
* Les spécialistes n'écrivent que le **corps HTML et le JavaScript** ; le CSS de base, le thème sombre, le canvas responsive et la boucle d'animation sont fournis (`notebook_widgets.py`), avec l'exemple le plus proche à *adapter* (`notebook_examples.py`). Le JavaScript est vérifié (syntaxe, API interdites) et les erreurs précises sont renvoyées au modèle (2 essais, 3 pour un modèle local).

## 5. Installer et brancher Ollama (IA locale), pas à pas
**À quoi ça sert** : une IA installée sur *ton* ordinateur réalise les schémas et simulations pendant que Gemini écrit le cours : ça économise le quota Gemini. **Elle est moins puissante** : l'IA principale lui écrit des consignes très explicites, lui donne un exemple à adapter, et **Gemini prend le relais si elle échoue 3 fois ou si elle est injoignable**. Le texte du cours reste écrit par Gemini.

1. **Installer** : télécharge Ollama sur https://ollama.com/download (Windows), installe, laisse-le démarrer (icône dans la barre des tâches). Il écoute sur `http://localhost:11434`.
2. **Télécharger un modèle** (PowerShell). Choisis un modèle *de code* ; la taille dépend de ta mémoire :
   ```powershell
   ollama pull qwen2.5-coder:7b      # ~5 Go : bon compromis, 8 Go de RAM libres conseillés
   ollama pull qwen2.5-coder:3b      # ~2 Go : PC modeste (résultats plus simples)
   ollama pull qwen2.5-coder:14b     # ~9 Go : meilleur si tu as 16 Go+ de RAM ou une carte graphique
   ```
   (cherche « coder » sur https://ollama.com/library : une version plus récente de la même famille convient aussi.)
3. **Vérifier** : `ollama run qwen2.5-coder:7b "Dis bonjour"` doit répondre ; `http://localhost:11434` dans le navigateur affiche « Ollama is running ».
4. **Brancher** : lance SchoolWorkplace, ouvre une matière, panneau IA → déplie **« IA locale »** → clique **« Enregistrer et détecter »** (la liste des modèles installés apparaît dans le champ *Modèle*) → choisis le modèle → coche ce que tu lui confies (interactifs, schémas, films) → **« Tester »** (premier appel lent : le modèle se charge en mémoire). L'état affiche « prête ✓ ». C'est enregistré dans `notebooks/data/_local_ai.json` : pas de variable d'environnement à régler.
   *Variante sans interface* : `NB_LOCAL_MODEL=qwen2.5-coder:7b` (+ `OLLAMA_URL`, `NB_LOCAL_STRENGTH`, `NB_LOCAL_USE_FOR`) avant de lancer `python app.py`.
5. **Puissance du modèle** : laisse « Petit modèle » (3 essais, exemples simplifiés) tant que tu n'as pas un gros modèle.
* **LM Studio / llama.cpp / vLLM** : démarre le serveur local (LM Studio : onglet *Developer* → *Start Server*, port 1234), choisis le type « Compatible OpenAI », adresse `http://localhost:1234`, modèle = l'identifiant affiché.
* **Important** : l'IA locale n'est joignable que si le serveur Flask tourne sur **le même ordinateur** qu'Ollama. Hébergé (Render…), `localhost` désigne le serveur, pas ton PC.
* **Lent ?** Sans carte graphique, un modèle 7B met 1 à 5 minutes par élément : normal, c'est en arrière-plan. Augmente le délai (`timeout`) si besoin, ferme les gros programmes, prends un modèle plus petit.
* **Sans automatisation** : `GET /api/notebooks/<matière>/jobs/<id>/prompt` donne le prompt complet à coller dans n'importe quelle IA ; colle sa réponse (blocs ```html / ```js / ```svg) avec `POST …/jobs/<id>/fill {"text": "…"}`.

## 6. Sécurité du travail
* **Historique automatique** avant tout remplacement/patch/suppression d'une partie : `notebooks/data/<Matière>/_src/_history/` ; `GET /api/notebooks/<m>/history`, `POST …/history/<id>/restore`.
* **Où écrire** : `create_chapter(title, parent)` et `add_part(..., after_part_id)`.
* **Notes à soi-même** : `_src/journal.json`. **Ordre des pages** : l'IA reçoit « PAGE 1/N… » dans l'ordre de lecture (sans noms de fichiers) ; `PUT /api/notebooks/<m>/sources/order`.

## 7. Routes principales (`notebooks/notebook_routes.py`)
`GET/POST /api/notebooks/<m>/settings` · `GET /api/notebooks/<m>/slots` · `POST …/slots/<id>/retry` · `GET/POST/DELETE …/jobs` (`{"enrich": true, "chapter": …}` = l'IA propose des éléments pour un chapitre déjà écrit) · `…/jobs/start|stop|next` · `GET/POST /api/notebooks/ai/local[?test=1]` · `GET /api/notebooks/ai/levels`.

## 8. Réglages utiles (variables d'environnement, tous facultatifs)
`NB_SOURCES_PER_BATCH` (2) · `GEMINI_MAX_OUTPUT_TOKENS` (ex. 32000) · `NB_MAX_READ_CALLS` (2) · `NB_JOB_PAUSE` (2 s) · `NB_JOB_MAX_ATTEMPTS` (2) · `NB_HISTORY_KEEP` (60).

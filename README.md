# SchoolWorkplace

## 1. Lancer / mettre à jour Python (le FutureWarning)
Le message `You are using a Python version (3.11.9) which Google will stop supporting…` n'est **pas une erreur** : rien ne casse avant
octobre 2027. `app.py` le masque désormais. Le vrai correctif :

```powershell
# après avoir installé Python 3.12 (ou plus récent) depuis python.org
cd D:\MesDocs\Apps\SchoolWorkplace
Remove-Item -Recurse -Force .venv
py -3.12 -m venv .venv          # ou py -3.13
.venv\Scripts\activate
python -m pip install -U pip
python -m pip install -r requirements.txt
python -m pip list --outdated   # voir ce qui peut encore être mis à jour
```
Si une bibliothèque refuse de s'installer sur la nouvelle version, repasse sur 3.12.

## 2. Travailler avec l'IA sans qu'elle bâcle ni écrase
* **Historique automatique** : avant tout remplacement / patch / suppression d'une partie, une copie est faite dans
  `notebooks/data/<Matière>/_src/_history/`. `GET /api/notebooks/<matière>/history` liste, `POST …/history/<id>/restore` restaure.
* **Où écrire** : l'IA a maintenant `create_chapter(title, parent)` (nouvelle séance/séquence au bon endroit de l'arborescence) et
  `add_part(..., after_part_id)` (insertion au milieu).
* **Notes à soi-même** : `note_to_self` (+ à-faire). Stockées dans `_src/journal.json`, relues au début de chaque requête.
  Tu peux en ajouter : `POST /api/notebooks/<matière>/journal {"text": "...", "todo": true}`.
* **Ordres futurs / travail découpé** : `POST /api/notebooks/<matière>/jobs {"plan": true, "per_job": 2, "start": true}` découpe les photos
  en attente en petits ordres (2 pages chacun) exécutés un par un en arrière-plan ; si le quota du jour est atteint, la file se met en
  pause et reprend au prochain `…/jobs/start`. Ordre libre : `{"kind":"write","instruction":"Après la séance 1, crée la séance 2…","source_ids":[…],"new_chapter_title":"Séance 2","parent":"<slug>"}`.
* **Ordre des pages** : l'IA reçoit « PAGE 1/N, PAGE 2/N… » dans l'ordre de lecture (sans noms de fichiers, qui la trompaient), recopie le
  numéro de page imprimé (`annotate_source`) pour garder la continuité d'un lot à l'autre, et signale toute contradiction. À l'envoi de
  plusieurs photos, elles sont triées par nom « naturel » (2 avant 10). Pour fixer l'ordre d'un coup :
  `PUT /api/notebooks/<matière>/sources/order {"order": ["src003","src001",…]}` (la 1re = première page).
* **Éléments interactifs ambitieux** : l'IA a pour règle d'en demander au moins un par grande partie. Elle appelle
  `request_interactive(slot_id, title, goal, content, interactions, visual_style, anchor_text)` : le système place l'emplacement
  (après `anchor_text`, sinon en fin de partie) et met en file un cahier des charges **autonome** (texte et données exacts recopiés).
  Un spécialiste (Gemini ou IA locale) le réalise plus tard dans une requête dédiée, avec une seconde chance s'il se trompe.
* **Passe d'enrichissement** : `POST …/jobs {"enrich": true, "chapter": "<slug>"}` fait proposer à l'IA, partie par partie, des éléments
  interactifs pour un chapitre DÉJÀ écrit (emplacements + ordres créés automatiquement, sans doublon).
* **Commander toi-même un élément** : `POST …/jobs {"kind":"interactive","chapter","part_id","slot_id","goal","content","interactions","visual_style"}`.
* **IA locale** : `NB_LOCAL_MODEL=<modèle>` (Ollama ; `NB_LOCAL_API=openai` pour LM Studio / llama.cpp, `OLLAMA_URL` = adresse du serveur).
  **Sans automatisation** : `GET …/jobs/<id>/prompt` donne le prompt complet à coller dans n'importe quelle IA ; colle sa réponse avec
  `POST …/jobs/<id>/fill {"html": "…"}` (validée, puis insérée dans l'emplacement).
* Réglages utiles : `NB_SOURCES_PER_BATCH` (défaut 2 pages par requête), `GEMINI_MAX_OUTPUT_TOKENS` (ex. 32000 pour autoriser de longues réponses).

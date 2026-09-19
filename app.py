import base64
import json
import os
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path

import requests
import html as html_lib

try:
    import bleach
except ImportError:
    bleach = None

from flask import Flask, jsonify, render_template, request, send_from_directory
from flask_cors import CORS

from ed_service import EcoleDirecteService

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
if not DATA_DIR.exists():
    DATA_DIR = BASE_DIR

SCHEDULE_DEFAULT_FILE = DATA_DIR / "schedule_default.json"
SCHEDULE_CHANGES_FILE = DATA_DIR / "schedule_changes.json"
HOMEWORK_LOCAL_FILE = DATA_DIR / "homework_local.json"
AI_WORKFLOW_FILE = DATA_DIR / "ai_workflow.txt"

TEMPLATES_DIR = BASE_DIR / "templates"

app = Flask(__name__, template_folder=str(TEMPLATES_DIR) if TEMPLATES_DIR.exists() else None)
CORS(app)  # Autorise les appels cross-origin (ex: index.html local -> Render)

# ---------------------------------------------------------------------------
# GESTION DES IDENTIFIANTS VIA LES REQUÊTES HTTP
# ---------------------------------------------------------------------------

_ed_lock = threading.RLock()
_ed_services = {}


def get_req_credentials():
    """Extraction des identifiants.

    Pour les requêtes JSON, le body est prioritaire aux headers afin que le
    mot de passe soit transmis sans perte de caractères Unicode.
    """
    username = None
    password = None

    payload = request.get_json(silent=True) if request.is_json else None
    if isinstance(payload, dict):
        username = payload.get("username") or payload.get("identifiant")
        password = payload.get("password") or payload.get("motdepasse")

    username = username or request.headers.get("X-ED-Username") or request.headers.get("X-Username")
    password = password or request.headers.get("X-ED-Password") or request.headers.get("X-Password")

    if not username or not password:
        username = username or request.args.get("username")
        password = password or request.args.get("password")

    if username is not None:
        username = str(username).strip()
    if password is not None:
        password = str(password)

    return username, password


def get_ed_service(username=None, password=None, force_login=False):
    """Instancie ou réutilise le service ÉcoleDirecte pour les identifiants transmis."""
    if not username or not password:
        u, p = get_req_credentials()
        username = username or u
        password = password or p

    if not username or not password:
        raise RuntimeError("Identifiants ÉcoleDirecte manquants dans la requête HTTP (en-têtes X-ED-Username / X-ED-Password).")

    with _ed_lock:
        service = _ed_services.get(username)

        # Ne jamais réutiliser un service construit avec un autre mot de passe.
        password_changed = service is not None and getattr(service, "password", None) != password

        if service is None or force_login or password_changed:
            service = EcoleDirecteService(username, password)
            service.login()
            _ed_services[username] = service

        return service


def ed_call(method_name, *args, **kwargs):
    """Exécute une méthode ED avec reconnexion automatique si besoin."""
    username, password = get_req_credentials()
    try:
        service = get_ed_service(username, password)
        return getattr(service, method_name)(*args, **kwargs)
    except Exception:
        with _ed_lock:
            if username in _ed_services:
                del _ed_services[username]
        service = get_ed_service(username, password, force_login=True)
        return getattr(service, method_name)(*args, **kwargs)


# ---------------------------------------------------------------------------
# JSON LOCAUX & HORODATAGE DE SYNCHRONISATION
# ---------------------------------------------------------------------------

def read_json(path, default):
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


def load_schedule_default():
    data = read_json(
        SCHEDULE_DEFAULT_FILE,
        {"vacances": [], "semaine_paire": {}, "semaine_impaire": {}},
    )
    return data if isinstance(data, dict) else {"vacances": [], "semaine_paire": {}, "semaine_impaire": {}}


def load_schedule_overrides():
    data = read_json(SCHEDULE_CHANGES_FILE, {})
    return data if isinstance(data, dict) else {}


def load_homework_local():
    """Lit les devoirs locaux et la date de dernière mise à jour."""
    data = read_json(HOMEWORK_LOCAL_FILE, {})

    if isinstance(data, list):
        return {"items": data, "deleted_api_ids": [], "last_updated": None}

    if not isinstance(data, dict):
        return {"items": [], "deleted_api_ids": [], "last_updated": None}

    items = data.get("items", [])
    deleted = data.get("deleted_api_ids", [])
    return {
        "items": items if isinstance(items, list) else [],
        "deleted_api_ids": [str(x) for x in deleted] if isinstance(deleted, list) else [],
        "last_updated": data.get("last_updated"),
    }


def save_homework_local(state, updated_now=False):
    """
    Sauvegarde le fichier local uniquement si le contenu a changé
    ou si une nouvelle synchronisation explicite est demandée.
    """
    current = load_homework_local()
    now_str = datetime.now().strftime("%d/%m %HH%M").replace("H", "h")
    
    new_last_updated = now_str if updated_now else current.get("last_updated") or now_str

    to_write = {
        "items": state.get("items", []),
        "deleted_api_ids": state.get("deleted_api_ids", []),
        "last_updated": new_last_updated,
    }

    # Évite l'écriture disque si les données sont exactement identiques
    if (
        current.get("items") == to_write["items"]
        and current.get("deleted_api_ids") == to_write["deleted_api_ids"]
        and current.get("last_updated") == to_write["last_updated"]
    ):
        return to_write

    write_json(HOMEWORK_LOCAL_FILE, to_write)
    return to_write


def clean_past_and_done_homeworks(items, keep_days=0):
    """Filtre les devoirs faits et/ou datant d'un jour passé."""
    today = datetime.now().date()
    threshold = today - timedelta(days=keep_days)
    filtered = []

    for item in items:
        if not isinstance(item, dict):
            continue
        
        # Ignorer si fait
        if parse_bool(item.get("completed", False)):
            continue

        # Ignorer si date passée
        item_date_str = str(item.get("date", ""))[:10]
        try:
            item_date = datetime.strptime(item_date_str, "%Y-%m-%d").date()
            if item_date < threshold:
                continue
        except ValueError:
            pass

        filtered.append(item)

    return filtered


# ---------------------------------------------------------------------------
# NORMALISATION EMPLOI DU TEMPS ET DEVOIRS (Inchangé)
# ---------------------------------------------------------------------------

def _first(d, *keys, default=""):
    if not isinstance(d, dict):
        return default
    for key in keys:
        value = d.get(key)
        if value not in (None, ""):
            return value
    return default


def canonical_subject_key(value):
    raw = str(value or "").strip().lower()
    folded = (
        raw.replace("é", "e").replace("è", "e").replace("ê", "e")
           .replace("à", "a").replace("â", "a").replace("î", "i")
           .replace("ï", "i").replace("ô", "o").replace("û", "u")
           .replace("ç", "c")
    )
    folded = re.sub(r"[^a-z0-9]+", " ", folded).strip()

    aliases = {
        "physique": "physique",
        "physique chimie": "physique",
        "maths": "maths",
        "mathematiques": "maths",
        "maths expert": "maths expert",
        "philosophie": "philo",
        "philo": "philo",
        "anglais": "anglais",
        "anglais lv1": "anglais",
        "histoire geo": "histoire-géo",
        "histoire geographie": "histoire-géo",
        "espagnol": "espagnol",
        "espagnol lv2": "espagnol",
        "enseignement scientifique": "es physique",
        "es physique": "es physique",
        "es svt": "es svt",
        "svt": "es svt",
        "permanence": "perm",
        "vie scolaire": "vie scolaire",
    }
    return aliases.get(folded, raw)


def normalize_schedule_course(course):
    start = _first(course, "start_date", "startDate", default="")
    end = _first(course, "end_date", "endDate", default="")

    date = str(start).split(" ")[0] if start else ""
    start_time = str(start).split(" ")[1][:5] if " " in str(start) else ""
    end_time = str(end).split(" ")[1][:5] if " " in str(end) else ""

    if not start_time:
        start_time = str(_first(course, "heureDebut", "heure_debut", default=""))[:5]
    if not end_time:
        end_time = str(_first(course, "heureFin", "heure_fin", default=""))[:5]

    raw_subject = _first(course, "matiere", "text", "name", default="Matière inconnue")
    subject_key = canonical_subject_key(raw_subject)
    if str(course.get("typeCours", "")).upper() == "PERMANENCE" or subject_key == "perm":
        return None

    prof = _first(course, "prof", "professeur", default="-")
    salle = _first(course, "salle", "room", default="Salle ?")
    titre = _first(course, "titre", "title", default="")

    return {
        "id": str(_first(course, "id", default=f"api_{date}_{start_time}_{subject_key}")),
        "matiere": subject_key,
        "titre": str(titre or ""),
        "heure": f"{start_time} - {end_time}".strip(" -") if start_time or end_time else "08:00 - 09:00",
        "salle": str(salle or "Salle ?"),
        "prof": str(prof or "-"),
        "api_color": _first(course, "color", default=""),
        "isAnnule": bool(course.get("isAnnule", False)),
        "_api": True,
    }


def api_schedule_to_dates(raw):
    data = raw.get("data", {}) if isinstance(raw, dict) else {}
    result = {}

    if isinstance(data, list):
        iterable = data
    elif isinstance(data, dict):
        if any(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(k)) for k in data.keys()):
            for day, courses in data.items():
                if isinstance(courses, list):
                    result[str(day)] = [n for c in courses if isinstance(c, dict) for n in [normalize_schedule_course(c)] if n]
            return result
        iterable = []
        for key in ("events", "cours", "courses", "emploiDuTemps", "emploidutemps"):
            if isinstance(data.get(key), list):
                iterable = data[key]
                break
    else:
        iterable = []

    for course in iterable:
        if not isinstance(course, dict):
            continue
        normalized = normalize_schedule_course(course)
        if not normalized:
            continue
        date = normalized.pop("_date", None) or str(course.get("date", "") or normalized.get("date", ""))
        if not date:
            raw_start = _first(course, "start_date", "startDate", default="")
            date = str(raw_start).split(" ")[0] if raw_start else ""
        if date:
            result.setdefault(date, []).append(normalized)

    for courses in result.values():
        courses.sort(key=lambda c: c.get("heure", "").split(" - ")[0])

    return result


def parse_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"true", "1", "yes", "oui"}: return True
        if v in {"false", "0", "no", "non", ""}: return False
    return default


def normalize_homework(item, date_hint=None, subject_hint=None):
    if not isinstance(item, dict):
        return None

    subject = (
        item.get("matiere")
        or item.get("nomMatiere")
        or item.get("matiereNom")
        or item.get("discipline")
        or subject_hint
        or "autre"
    )

    work = item.get("travail") or item.get("contenu") or item.get("description") or item.get("texte") or ""
    title = item.get("titre") or item.get("libelle") or item.get("title") or ""

    date_value = date_hint or item.get("date") or item.get("dateDevoir") or item.get("dateTravail") or ""
    given_date = item.get("donneLe") or item.get("dateDonne") or item.get("dateDonnee") or ""

    api_id = item.get("idDevoir") or item.get("id") or item.get("id_devoir")
    completed = parse_bool(item.get("effectue", item.get("completed", False)))

    if api_id is not None:
        api_id = str(api_id)

    local_id = str(item.get("id_local") or item.get("_local_id") or api_id or f"api_{date_value}_{subject}_{title}")

    return {
        "id": local_id,
        "api_id": api_id,
        "matiere": canonical_subject_key(str(subject).strip()),
        "date": str(date_value)[:10],
        "donne_le": str(given_date)[:10] if given_date else "",
        "titre": str(title).strip(),
        "travail": str(work).strip(),
        "completed": bool(completed),
        "source": "api",
    }


def fetch_homeworks_from_ed(username, password):
    service = get_ed_service(username, password)
    overview = service.get_homework_overview()
    overview_data = overview.get("data", {}) if isinstance(overview, dict) else {}
    
    result = []
    days = list(overview_data.keys()) if isinstance(overview_data, dict) else []
    
    for day in days:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(day)):
            try:
                detail = service.get_homework_detail(day)
                detail_data = detail.get("data", {}) if isinstance(detail, dict) else {}
                matieres = detail_data.get("matieres", []) if isinstance(detail_data, dict) else []
                for m in matieres:
                    if isinstance(m, dict) and "aFaire" in m:
                        hw = normalize_homework(m["aFaire"], day, m.get("nomMatiere"))
                        if hw:
                            result.append(hw)
            except Exception:
                pass

    return result


def merge_homeworks(api_items, local_state):
    local_items = local_state.get("items", [])
    deleted = {str(x) for x in local_state.get("deleted_api_ids", [])}
    merged = {}

    for item in api_items:
        key = str(item.get("api_id") or item.get("id"))
        if key in deleted:
            continue
        merged[key] = item

    for item in local_items:
        if not isinstance(item, dict):
            continue
        api_id = item.get("api_id")
        key = str(api_id or item.get("id"))
        if api_id is not None and str(api_id) in deleted:
            continue
        merged[key] = item

    return list(merged.values())


# ---------------------------------------------------------------------------
# ROUTES API & APPLI
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    template_file = TEMPLATES_DIR / "index.html"
    root_file = BASE_DIR / "index.html"

    if template_file.exists():
        return render_template("index.html")
    if root_file.exists():
        from flask import send_file
        return send_file(root_file)

    return "Erreur : fichier index.html introuvable.", 404


@app.route("/api/data", methods=["GET", "POST"])
def api_data():
    username, password = get_req_credentials()
    
    # 1. Traitement des devoirs
    local_hw = load_homework_local()
    homework_api_ok = False
    homework_error = None
    api_homeworks = []

    if username and password:
        try:
            api_homeworks = fetch_homeworks_from_ed(username, password)
            homework_api_ok = True
        except Exception as exc:
            homework_error = str(exc)

    merged_hw = merge_homeworks(api_homeworks, local_hw)
    
    # Mettre à jour l'horodatage si l'appel API a réussi
    updated_state = save_homework_local(
        {"items": merged_hw, "deleted_api_ids": local_hw.get("deleted_api_ids", [])},
        updated_now=homework_api_ok
    )

    # 2. Emploi du temps
    default_schedule = load_schedule_default()
    overrides = load_schedule_overrides()

    # 3. Mails
    messages = []
    messages_api_ok = False
    messages_error = None

    if username and password:
        try:
            raw_msg = ed_call("get_messages_list")
            messages = raw_msg.get("data", {}).get("messages", {}).get("received", []) if isinstance(raw_msg, dict) else []
            messages_api_ok = True
        except Exception as exc:
            messages_error = str(exc)

    return jsonify({
        "success": True,
        "last_updated": updated_state.get("last_updated"),
        "schedule": {
            "default": default_schedule,
            "overrides": overrides,
            "api_ok": homework_api_ok,
        },
        "homeworks": {
            "items": merged_hw,
            "local": local_hw,
            "api_ok": homework_api_ok,
            "api_error": homework_error,
        },
        "messages": {
            "items": messages,
            "api_ok": messages_api_ok,
            "api_error": messages_error,
        },
        "generated_at": datetime.now().isoformat(),
    })


@app.route("/api/homeworks", methods=["GET", "POST"])
def api_homeworks():
    if request.method == "GET":
        return jsonify(load_homework_local())

    payload = request.get_json(silent=True)
    if isinstance(payload, list):
        payload = {"items": payload, "deleted_api_ids": []}

    if not isinstance(payload, dict):
        return jsonify({"success": False, "error": "Objet JSON attendu."}), 400

    # Optionnel: nettoyer les anciens devoirs ou faits lors de l'enregistrement
    items = payload.get("items", [])
    if request.args.get("clean") == "true":
        items = clean_past_and_done_homeworks(items)

    state = {
        "items": items,
        "deleted_api_ids": [str(x) for x in payload.get("deleted_api_ids", [])],
    }
    
    saved = save_homework_local(state, updated_now=False)
    return jsonify({"success": True, "data": saved})


@app.route("/api/homeworks/status", methods=["POST"])
def api_homework_status():
    payload = request.get_json(silent=True) or {}
    completed = payload.get("completed_ids", [])
    uncompleted = payload.get("uncompleted_ids", [])

    try:
        result = ed_call("set_homework_status", completed, uncompleted)
        return jsonify({"success": True, "data": result})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)

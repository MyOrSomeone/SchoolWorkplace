import base64
import json
import os
import re
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
import html as html_lib
from html.parser import HTMLParser

try:
    import bleach
except ImportError:
    bleach = None
from flask import Flask, jsonify, render_template, request, send_from_directory
from flask_cors import CORS

from ed_service import EcoleDirecteService, build_default_token_store

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
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=False)

# ---------------------------------------------------------------------------
# IDENTIFIANTS ÉCOLEDIRECTE
# ---------------------------------------------------------------------------
# Le frontend local envoie les identifiants dans chaque requête. Pour conserver
# la compatibilité avec l'ancien backend fonctionnel, on accepte aussi des
# variables d'environnement Render ou credentials.py.

_ed_lock = threading.RLock()
_ed_services = {}

# ---------------------------------------------------------------------------
# Anti-rafale : si ÉcoleDirecte refuse plusieurs connexions d'affilée pour un
# même compte, on arrête de retenter pendant un moment au lieu de renvoyer
# une nouvelle requête à chaque appel entrant. Marteler /login.awp pendant
# qu'un blocage de sécurité est actif ne fait que l'aggraver/le prolonger.
# ---------------------------------------------------------------------------

LOGIN_COOLDOWN_SECONDS = 180
LOGIN_FAILURE_THRESHOLD = 2

_login_failures = {}  # username -> {"count": int, "last_ts": float, "message": str}


class EcoleDirecteCooldownError(RuntimeError):
    """Levée quand on refuse volontairement de retenter une connexion ED
    pour ne pas aggraver un blocage de sécurité côté ÉcoleDirecte."""


def _record_login_failure(username, message):
    with _ed_lock:
        entry = _login_failures.get(username, {"count": 0, "last_ts": 0.0, "message": ""})
        entry["count"] += 1
        entry["last_ts"] = time.time()
        entry["message"] = message
        _login_failures[username] = entry


def _record_login_success(username):
    with _ed_lock:
        _login_failures.pop(username, None)


def _check_login_cooldown(username):
    with _ed_lock:
        entry = _login_failures.get(username)
    if not entry:
        return
    elapsed = time.time() - entry["last_ts"]
    if entry["count"] >= LOGIN_FAILURE_THRESHOLD and elapsed < LOGIN_COOLDOWN_SECONDS:
        remaining = int(LOGIN_COOLDOWN_SECONDS - elapsed)
        raise EcoleDirecteCooldownError(
            f"ÉcoleDirecte a refusé {entry['count']} connexions d'affilée "
            f"({entry['message']}). Pour éviter d'aggraver un éventuel "
            f"blocage de sécurité côté ÉcoleDirecte, nouvel essai dans "
            f"{remaining}s."
        )


def get_req_credentials():
    """Récupère les identifiants depuis headers, JSON ou paramètres."""
    username = request.headers.get("X-ED-Username") or request.headers.get("X-Username")
    password = request.headers.get("X-ED-Password") or request.headers.get("X-Password")

    payload = request.get_json(silent=True) if request.is_json else {}
    if isinstance(payload, dict):
        username = username or payload.get("username") or payload.get("identifiant")
        password = password or payload.get("password") or payload.get("motdepasse")

    username = username or request.args.get("username") or os.getenv("ECOLEDIRECTE_USERNAME") or os.getenv("ED_USERNAME")
    password = password or request.args.get("password") or os.getenv("ECOLEDIRECTE_PASSWORD") or os.getenv("ED_PASSWORD")

    return str(username).strip() if username else "", str(password) if password else ""


def _fallback_credentials():
    """Compatibilité avec l'ancien credentials.py local si présent."""
    for module_name in ("credentials", "credential"):
        try:
            module = __import__(module_name)
            username = (
                getattr(module, "ECOLEDIRECTE_IDENTIFIANT", None)
                or getattr(module, "USERNAME", None)
                or getattr(module, "username", "")
                or ""
            )
            password = (
                getattr(module, "ECOLEDIRECTE_MOT_DE_PASSE", None)
                or getattr(module, "PASSWORD", None)
                or getattr(module, "password", "")
                or ""
            )
            if username and password:
                return str(username), str(password)
        except ImportError:
            continue
    return "", ""


def _credentials_for_request():
    username, password = get_req_credentials()
    if username and password:
        return username, password
    return _fallback_credentials()


def _token_file_for_user(username):
    # On conserve tokens.json pour être compatible avec la version qui fonctionne.
    # L'environnement Render est actuellement mono-compte.
    return "tokens.json"


def get_ed_service(username=None, password=None, force_login=False):
    """Réutilise la session ED fonctionnelle, par identifiant transmis."""
    if not username or not password:
        username, password = _credentials_for_request()

    if not username or not password:
        raise RuntimeError("Identifiants ÉcoleDirecte manquants.")

    key = str(username)
    signature = (str(username), str(password))

    with _ed_lock:
        entry = _ed_services.get(key)
        service = entry[0] if entry else None
        old_signature = entry[1] if entry else None
        needs_login = service is None or old_signature != signature or force_login

    if not needs_login:
        return service

    # On ne retente une connexion ÉcoleDirecte que si le coupe-circuit
    # anti-rafale l'autorise (voir _check_login_cooldown ci-dessus).
    _check_login_cooldown(key)

    if service is None or old_signature != signature:
        token_store = build_default_token_store(username, _token_file_for_user(username))
        service = EcoleDirecteService(username, password, token_store=token_store)

    try:
        service.login()
    except Exception as exc:
        _record_login_failure(key, str(exc))
        raise

    _record_login_success(key)
    with _ed_lock:
        _ed_services[key] = (service, signature)

    return service


def ed_call(method_name, *args, **kwargs):
    """Exécute une méthode ED avec reconnexion automatique sur erreur de session."""
    username, password = _credentials_for_request()
    if not username or not password:
        raise RuntimeError("Identifiants ÉcoleDirecte manquants.")

    try:
        service = get_ed_service(username, password)
        return getattr(service, method_name)(*args, **kwargs)
    except Exception as first_error:
        # On ne masque pas un échec d'authentification 505 en bouclant inutilement.
        message = str(first_error)
        if "(505)" in message or "code=505" in message or "Mot de passe invalide" in message or "Identifiant et/ou mot de passe invalide" in message:
            raise
        with _ed_lock:
            _ed_services.pop(str(username), None)
        service = get_ed_service(username, password, force_login=True)
        return getattr(service, method_name)(*args, **kwargs)


# ---------------------------------------------------------------------------
# JSON locaux
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
    """
    Format persistant :
    {
      "items": [...],                 # ajouts + versions locales
      "deleted_api_ids": ["123", ...] # suppressions locales d'éléments ED
    }

    Compatibilité avec l'ancien format [] conservée.
    """
    data = read_json(HOMEWORK_LOCAL_FILE, [])

    if isinstance(data, list):
        return {"items": data, "deleted_api_ids": []}

    if not isinstance(data, dict):
        return {"items": [], "deleted_api_ids": []}

    items = data.get("items", [])
    deleted = data.get("deleted_api_ids", [])
    return {
        "items": items if isinstance(items, list) else [],
        "deleted_api_ids": [str(x) for x in deleted] if isinstance(deleted, list) else [],
    }


# ---------------------------------------------------------------------------
# NORMALISATION EMPLOI DU TEMPS
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
    """Convertit les noms ÉcoleDirecte vers les clés utilisées par le front."""
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
        "physique chimie": "physique",
        "physique chimie": "physique",
        "maths": "maths",
        "mathematiques": "maths",
        "mathematique": "maths",
        "maths expert": "maths expert",
        "philosophie": "philo",
        "philo": "philo",
        "anglais": "anglais",
        "anglais lv1": "anglais",
        "histoire geo": "histoire-géo",
        "histoire geographie": "histoire-géo",
        "histoire geo geographie": "histoire-géo",
        "espagnol": "espagnol",
        "espagnol lv2": "espagnol",
        "enseignement scientifique": "es physique",
        "es physique": "es physique",
        "enseignement scientifique physique": "es physique",
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
    """
    Transforme plusieurs variantes possibles de la réponse ED en :
    {
      "YYYY-MM-DD": [course, ...],
      ...
    }
    """
    data = raw.get("data", {}) if isinstance(raw, dict) else {}
    result = {}

    if isinstance(data, list):
        iterable = data
    elif isinstance(data, dict):
        # Variante fréquente : data est directement indexé par date.
        if any(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(k)) for k in data.keys()):
            for day, courses in data.items():
                if isinstance(courses, list):
                    result[str(day)] = [n for c in courses if isinstance(c, dict) for n in [normalize_schedule_course(c)] if n]
            return result

        # Autres variantes : liste dans une clé.
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


# ---------------------------------------------------------------------------
# NORMALISATION DEVOIRS
# ---------------------------------------------------------------------------

def decode_smart(value, max_rounds=3):
    """Décode Base64 tolérante + entités HTML sans supposer que tout est Base64."""
    if value is None:
        return ""

    text = str(value).strip()
    if not text:
        return ""

    for _ in range(max_rounds):
        compact = re.sub(r"\s+", "", text)
        if not re.fullmatch(r"[A-Za-z0-9+/=_-]+", compact):
            break
        compact += "=" * (-len(compact) % 4)

        try:
            candidate = base64.b64decode(compact, altchars=b"-_").decode("utf-8")
        except Exception:
            break

        if not candidate:
            break

        printable = sum(ch.isprintable() or ch in "\n\r\t" for ch in candidate)
        if printable < max(8, int(len(candidate) * 0.90)):
            break

        text = candidate
        # Le contenu est généralement déjà du HTML après un décodage.
        if "<" in text or ">" in text:
            break

    return html_lib.unescape(text)


def plain_text_to_html(value):
    """Convertit un texte brut en HTML riche en conservant les retours à la ligne."""
    text = html_lib.unescape(str(value or "")).replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return ""
    # Les doubles sauts créent des paragraphes ; les simples deviennent des <br>.
    paragraphs = re.split(r"\n\s*\n", text.strip())
    rendered = []
    for paragraph in paragraphs:
        escaped = (
            paragraph.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#39;")
        )
        rendered.append(f"<p>{escaped.replace(chr(10), '<br>')}</p>")
    return "".join(rendered)


def decode_html_content(value):
    """Décode le contenu du cahier de texte et conserve une mise en forme HTML sûre."""
    text = decode_smart(value)
    if not text:
        return ""

    # Certains retours de l'API ont plusieurs niveaux d'entités HTML.
    # Deux passes suffisent dans la pratique sans décoder arbitrairement du texte utilisateur.
    text = html_lib.unescape(html_lib.unescape(text))

    # Le cahier de textes peut renvoyer un contenu parfaitement valide mais
    # en texte brut (sans balises HTML). Dans ce cas, conserver les sauts de
    # ligne tels quels ne suffit pas avec innerHTML : on construit explicitement
    # des paragraphes et des <br>.
    if not re.search(r'<\s*[a-zA-Z][^>]*>', text):
        return plain_text_to_rich_html(text)

    def clean_opening_tag(match):
        tag = match.group(1).lower()
        attrs = match.group(2) or ""
        classes = []

        # Classes existantes : elles seront filtrées par bleach ensuite.
        class_match = re.search(r'\bclass\s*=\s*(["\'])(.*?)\1', attrs, flags=re.I | re.S)
        if class_match:
            classes.extend(re.findall(r'[A-Za-z0-9_-]+', class_match.group(2)))

        style_match = re.search(r'\bstyle\s*=\s*(["\'])(.*?)\1', attrs, flags=re.I | re.S)
        if style_match:
            style = style_match.group(2)
            for prop, cls in (
                (r'text-align\s*:\s*(center|justify|right|left)\b', lambda v: f'ed-align-{v.lower()}'),
                (r'font-weight\s*:\s*(bold|700|800|900)\b', lambda v: 'ed-bold'),
                (r'font-style\s*:\s*italic\b', lambda v: 'ed-italic'),
                (r'text-decoration(?:-line)?\s*:\s*[^;]*\bunderline\b', lambda v: 'ed-underline'),
            ):
                m = re.search(prop, style, flags=re.I)
                if m:
                    value_m = m.group(1) if m.groups() else ''
                    candidate = cls(value_m)
                    if candidate not in classes:
                        classes.append(candidate)

        # Garder uniquement les attributs d'affichage utiles.
        new_attrs = re.sub(r'\s+(?:style|class)\s*=\s*(["\']).*?\1', '', attrs, flags=re.I | re.S)
        if classes:
            new_attrs += ' class="' + ' '.join(sorted(set(classes))) + '"'
        return f'<{tag}{new_attrs}>'

    # Les mails/devoirs ED contiennent surtout p/div/span mais parfois aussi strong/em/a/listes.
    text = re.sub(
        r'<(p|div|span|strong|b|em|i|u|s|li|blockquote|a|h[1-6]|td|th)([^>]*)>',
        clean_opening_tag,
        text,
        flags=re.I,
    )

    # Le HTML d'ÉcoleDirecte peut aussi contenir des\n    # à l'intérieur même des paragraphes. Un navigateur les fusionne
    # visuellement ; on les transforme donc en vrais retours <br>.
    def html_text_newlines(match):
        chunk = match.group(1)
        return '>' + re.sub(r'\n+', '<br>', chunk) + '<'

    text = re.sub(r'>([^<]*\n[^<]*)<', html_text_newlines, text)

    if bleach is not None:
        return bleach.clean(
            text,
            tags=[
                'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's',
                'ul', 'ol', 'li', 'blockquote', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'
            ],
            attributes={
                '*': ['class'],
                'a': ['href', 'title', 'target', 'rel'],
                'img': ['src', 'alt', 'title']
            },
            protocols=['http', 'https', 'mailto'],
            strip=True,
        ).strip()

    return text.strip()

def strip_html(value):
    """Transforme un contenu ED encodé en texte lisible."""
    text = decode_html_content(value)
    if not text:
        return ""

    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<\s*/\s*(p|div|li|tr|h[1-6])\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<\s*li[^>]*>", "• ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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

    # Le détail ED met souvent directement le texte dans `contenu`.
    work = (
        item.get("travail")
        or item.get("contenu")
        or item.get("description")
        or item.get("texte")
        or ""
    )
    title = item.get("titre") or item.get("libelle") or item.get("title") or ""

    # IMPORTANT : dans `aFaire`, `donneLe` correspond à la date où le
    # travail a été donné, pas à la date où il doit être rendu.
    # Lorsqu'on vient du endpoint de détail, `date_hint` est la vraie
    # date du cahier de textes (= date programmée / à faire).
    date_value = (
        date_hint
        or item.get("date")
        or item.get("dateDevoir")
        or item.get("dateTravail")
        or ""
    )
    given_date = item.get("donneLe") or item.get("dateDonne") or item.get("dateDonnee") or ""

    api_id = item.get("idDevoir") or item.get("id") or item.get("id_devoir")
    completed = item.get("effectue")
    if completed is None:
        completed = item.get("completed", False)
    completed = parse_bool(completed)

    if api_id is not None:
        api_id = str(api_id)

    local_id = str(
        item.get("id_local")
        or item.get("_local_id")
        or api_id
        or f"api_{date_value}_{subject}_{title}"
    )

    clean_title = strip_html(title)
    clean_work = strip_html(work)
    work_html = decode_html_content(work)
    # Certains retours de l'API sont du texte brut après décodage Base64.
    # Dans ce cas, innerHTML supprimerait visuellement les retours à la ligne :
    # on fabrique donc un HTML minimal qui les conserve.
    if work_html and not re.search(r"<\s*(p|br|div|ul|ol|li|table|h[1-6])\b", work_html, flags=re.I):
        work_html = plain_text_to_html(work_html)

    # Dans le CDT, il n'y a souvent pas de titre séparé : le contenu détaillé
    # constitue directement le travail à effectuer.
    if not clean_title and not clean_work:
        clean_work = ""

    return {
        "id": local_id,
        "api_id": api_id,
        "matiere": canonical_subject_key(str(subject).strip()),
        "date": str(date_value)[:10],
        "donne_le": str(given_date)[:10] if given_date else "",
        "titre": clean_title,
        "travail": clean_work,
        "travail_html": work_html,
        "completed": bool(completed),
        "source": "api",
    }


def _extract_homework_overview_dates(data):
    """Extrait les dates du retour de l'aperçu ED, quelle que soit sa variante."""
    result = {}

    def add(day, entries):
        day = str(day or "")[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            return
        if isinstance(entries, list):
            result.setdefault(day, []).extend(e for e in entries if isinstance(e, dict))
        elif isinstance(entries, dict):
            for key in ("matieres", "devoirs", "items", "homeworks"):
                value = entries.get(key)
                if isinstance(value, list):
                    result.setdefault(day, []).extend(e for e in value if isinstance(e, dict))
                    return

    if isinstance(data, dict):
        # Forme officielle : {"YYYY-MM-DD": [...]}
        for key, value in data.items():
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(key)):
                add(key, value)

        # Variantes encapsulées.
        for key in ("devoirs", "matieres", "items", "homeworks", "dates"):
            value = data.get(key)
            if isinstance(value, dict):
                for day, entries in value.items():
                    add(day, entries)
            elif isinstance(value, list):
                for entry in value:
                    if not isinstance(entry, dict):
                        continue
                    day = (entry.get("date") or entry.get("dateDevoir") or entry.get("donneLe") or "")
                    add(day, [entry])

    elif isinstance(data, list):
        for entry in data:
            if not isinstance(entry, dict):
                continue
            day = entry.get("date") or entry.get("dateDevoir") or entry.get("donneLe") or ""
            add(day, [entry])

    return result


def _extract_detail_homeworks(detail_data, day):
    """Extrait récursivement les objets aFaire du détail d'une journée ED."""
    result = []
    seen = set()

    def walk(node, subject_hint=None):
        if isinstance(node, dict):
            subject = (
                node.get("nomMatiere")
                or node.get("matiere")
                or node.get("codeMatiere")
                or subject_hint
            )

            a_faire = node.get("aFaire")
            if isinstance(a_faire, dict):
                print(
                    f"[ED][HOMEWORK] {day} matiere={subject!r} aFaire_keys={list(a_faire.keys())} "
                    f"idDevoir={a_faire.get('idDevoir')!r} effectue={a_faire.get('effectue')!r}"
                )
                normalized = normalize_homework(a_faire, day, subject)
                if normalized:
                    # La clé de journée du endpoint de détail est la vraie date programmée.
                    normalized["date"] = day
                    key = str(normalized.get("api_id") or normalized.get("id"))
                    if key not in seen:
                        seen.add(key)
                        result.append(normalized)
            elif isinstance(a_faire, list):
                for child in a_faire:
                    if isinstance(child, dict):
                        normalized = normalize_homework(child, day, subject)
                        if normalized:
                            normalized["date"] = day
                            key = str(normalized.get("api_id") or normalized.get("id"))
                            if key not in seen:
                                seen.add(key)
                                result.append(normalized)

            for key, child in node.items():
                # Laisser le nom de matière circuler dans les sous-objets pertinents.
                next_subject = subject if key not in ("aFaire",) else subject_hint
                walk(child, next_subject)

        elif isinstance(node, list):
            for child in node:
                walk(child, subject_hint)

    walk(detail_data)
    return result


def collect_api_homeworks(raw_overview, service=None):
    """Récupère les devoirs API et demande le détail de chaque journée utile."""
    if not isinstance(raw_overview, dict):
        print("[ED][HOMEWORK] Aperçu non-dict:", type(raw_overview).__name__)
        return []

    overview_data = raw_overview.get("data", {})
    overview_by_date = _extract_homework_overview_dates(overview_data)
    result = []

    print(
        f"[ED][HOMEWORK] overview code={raw_overview.get('code')} "
        f"dates={sorted(overview_by_date)}"
    )

    # Le retour officiel contient les dates/IDs ; le détail contient le texte.
    days_to_probe = list(overview_by_date.keys())
    if service and not days_to_probe:
        today = datetime.now().date()
        days_to_probe = [(today + timedelta(days=i)).isoformat() for i in range(0, 31)]
        print("[ED][HOMEWORK] Aucune date dans l'aperçu -> test direct de 31 jours")

    if service:
        for day in days_to_probe:
            try:
                detail = service.get_homework_detail(day)
                detail_data = detail.get("data", {}) if isinstance(detail, dict) else {}
                detailed = _extract_detail_homeworks(detail_data, day)
                print(
                    f"[ED][HOMEWORK] detail {day}: code={detail.get('code') if isinstance(detail, dict) else '?'} "
                    f"items={len(detailed)} keys={list(detail_data.keys())[:12] if isinstance(detail_data, dict) else type(detail_data).__name__}"
                )
                if detailed:
                    result.extend(detailed)
                    continue

                # S'il n'y a rien dans le détail, on conserve les métadonnées d'aperçu.
                for entry in overview_by_date.get(day, []):
                    normalized = normalize_homework(entry, day)
                    if normalized:
                        result.append(normalized)
            except Exception as exc:
                print(f"[ED][HOMEWORK] detail {day}: EXCEPTION {exc!r}")
                for entry in overview_by_date.get(day, []):
                    normalized = normalize_homework(entry, day)
                    if normalized:
                        result.append(normalized)
    else:
        for day, entries in overview_by_date.items():
            for entry in entries:
                normalized = normalize_homework(entry, day)
                if normalized:
                    result.append(normalized)

    dedup = {}
    for item in result:
        key = str(item.get("api_id") or item.get("id"))
        if key:
            dedup[key] = item

    final = list(dedup.values())
    print(f"[ED][HOMEWORK] total normalisé={len(final)}")
    return final


def fetch_homeworks_from_ed():
    service = get_ed_service()
    overview = service.get_homework_overview()
    return collect_api_homeworks(overview, service)

def merge_homeworks(api_items, local_state):
    local_items = local_state.get("items", [])
    deleted = {str(x) for x in local_state.get("deleted_api_ids", [])}

    merged = {}

    # API d'abord.
    for item in api_items:
        key = str(item.get("api_id") or item.get("id"))
        if key in deleted:
            continue
        merged[key] = item

    # Les entrées locales écrasent les API.
    for item in local_items:
        if not isinstance(item, dict):
            continue

        api_id = item.get("api_id")
        key = str(api_id or item.get("id"))

        if api_id is not None and str(api_id) in deleted:
            continue

        entry = {
            "id": str(item.get("id") or f"local_{key}"),
            "api_id": str(api_id) if api_id is not None else None,
            "matiere": str(item.get("matiere", "autre")).lower(),
            "date": str(item.get("date", ""))[:10],
            "donne_le": str(item.get("donne_le", ""))[:10] if item.get("donne_le") else "",
            "titre": str(item.get("titre", "")),
            "travail": str(item.get("travail", "")),
            "travail_html": str(item.get("travail_html", "")),
            "completed": parse_bool(item.get("completed", False)),
            "source": "local" if api_id is None else "local_override",
        }
        merged[key] = entry

    return list(merged.values())


# ---------------------------------------------------------------------------
# EMPLOI DU TEMPS : API ÉcoleDirecte uniquement côté backend
# ---------------------------------------------------------------------------

def get_schedule_payload():
    api_schedule = {}
    api_ok = False
    api_error = None

    try:
        service = get_ed_service()
        today = datetime.now().date()
        monday = today - timedelta(days=today.weekday())
        end = monday + timedelta(days=34)
        raw = service.get_schedule_range(monday.isoformat(), end.isoformat())
        if isinstance(raw, dict) and raw.get("code") not in (None, 200):
            raise RuntimeError(raw.get("message") or f"ÉcoleDirecte code {raw.get('code')}")
        api_schedule = api_schedule_to_dates(raw)
        api_ok = True
    except Exception as exc:
        api_error = str(exc)

    return {
        "default": {},
        "api": api_schedule,
        "overrides": {},
        "api_ok": api_ok,
        "api_error": api_error,
        "priority": ["firestore_override", "api", "local_default"],
    }


# ---------------------------------------------------------------------------
# MESSAGERIE
# ---------------------------------------------------------------------------

def get_messages():
    raw = ed_call("get_messages_list")
    if isinstance(raw, dict) and raw.get("code") not in (None, 200):
        raise RuntimeError(raw.get("message") or f"ÉcoleDirecte code {raw.get('code')}")
    data = raw.get("data", {}) if isinstance(raw, dict) else {}
    messages = []

    if isinstance(data, dict):
        box = data.get("messages", data)
        if isinstance(box, dict):
            received = box.get("received", [])
        elif isinstance(box, list):
            received = box
        else:
            received = []
    elif isinstance(data, list):
        received = data
    else:
        received = []

    for message in received:
        if not isinstance(message, dict):
            continue
        sender = message.get("from") or message.get("expediteur") or {}
        if isinstance(sender, dict):
            sender_name = sender.get("nom") or sender.get("name") or "Inconnu"
        else:
            sender_name = str(sender)

        messages.append({
            "id": str(message.get("id", "")),
            "subject": message.get("subject") or message.get("objet") or "Sans sujet",
            "date": message.get("date") or "",
            "read": bool(message.get("read", message.get("lu", False))),
            "sender": sender_name,
        })

    return messages


def extract_message_content(value):
    """Trouve récursivement le corps du message et le convertit en texte."""
    preferred = ("content", "corps", "contenu", "texte", "body", "message")

    if isinstance(value, dict):
        for key in preferred:
            candidate = value.get(key)
            if candidate not in (None, "", False):
                if isinstance(candidate, (str, int, float)):
                    text = strip_html(candidate)
                    if text:
                        return text
                else:
                    found = extract_message_content(candidate)
                    if found:
                        return found
        for child in value.values():
            found = extract_message_content(child)
            if found:
                return found

    elif isinstance(value, list):
        for child in value:
            found = extract_message_content(child)
            if found:
                return found

    elif isinstance(value, (str, int, float)):
        return strip_html(value)

    return ""


def find_raw_message_content(value):
    """Trouve la première valeur scalaire représentant le corps d'un message."""
    preferred = ("content", "corps", "contenu", "texte", "body", "message")

    if isinstance(value, dict):
        for key in preferred:
            candidate = value.get(key)
            if isinstance(candidate, (str, int, float)) and candidate not in ("", None):
                return str(candidate)
            if isinstance(candidate, (dict, list)):
                found = find_raw_message_content(candidate)
                if found:
                    return found
        for child in value.values():
            found = find_raw_message_content(child)
            if found:
                return found

    elif isinstance(value, list):
        for child in value:
            found = find_raw_message_content(child)
            if found:
                return found

    return ""


def get_message_detail(message_id):
    raw = ed_call("get_message_content", message_id)
    if not isinstance(raw, dict):
        raise RuntimeError("Réponse invalide de l'API ÉcoleDirecte.")
    if raw.get("code") not in (None, 200):
        raise RuntimeError(raw.get("message") or f"Erreur ÉcoleDirecte {raw.get('code')}")

    data = raw.get("data", {})
    if isinstance(data, list):
        data = data[0] if data else {}
    if not isinstance(data, dict):
        data = {}

    sender = data.get("from") or data.get("expediteur") or data.get("sender") or {}
    if isinstance(sender, dict):
        sender = sender.get("nom") or sender.get("name") or "Inconnu"

    raw_content = find_raw_message_content(data)
    content_html = decode_html_content(raw_content) if raw_content else ""
    content = strip_html(content_html) if content_html else extract_message_content(data)

    print(
        f"[ED][MESSAGE] id={message_id} code={raw.get('code')} "
        f"raw_len={len(raw_content)} html_len={len(content_html)} text_len={len(content)}"
    )

    return {
        "id": str(message_id),
        "subject": data.get("subject") or data.get("objet") or "Sans sujet",
        "date": data.get("date") or "",
        "sender": sender,
        "content": content,
        "content_html": content_html,
        "raw": data,
    }


# ---------------------------------------------------------------------------
# CONTEXTE IA LOCAL — envoyé uniquement si nécessaire
# ---------------------------------------------------------------------------

def load_ai_workflow():
    default = """Tu es l'assistant local de School Workspace.\nUtilise uniquement les informations nécessaires et suis les utilitaires date, devoirs, edt et mails.\nRéponds en français et en Markdown. Ne révèle pas ton raisonnement interne détaillé ; l'interface peut afficher les actions effectuées."""
    try:
        text = AI_WORKFLOW_FILE.read_text(encoding="utf-8").strip()
        return text or default
    except OSError:
        return default


def _normalize_ai_text(text):
    return re.sub(r"\s+", " ", (text or "").lower()).strip()


def extract_ai_date_targets(question, now=None):
    """Retourne les dates explicitement/rélativement visées par la question."""
    now = now or datetime.now().astimezone()
    q = _normalize_ai_text(question)
    targets = set()

    relative = {
        "aujourd hui": 0,
        "aujourd'hui": 0,
        "demain": 1,
        "apres demain": 2,
        "apres-demain": 2,
        "hier": -1,
    }
    for phrase, delta in relative.items():
        if phrase in q:
            targets.add((now + timedelta(days=delta)).date().isoformat())

    # Formats explicites : 17/09, 17-09, 17/09/2026, 17 septembre, 17 sept.
    month_names = {
        "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5,
        "juin": 6, "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10,
        "novembre": 11, "decembre": 12,
        "fevr": 2, "avr": 4, "juill": 7, "aout": 8, "sept": 9, "oct": 10,
        "nov": 11, "dec": 12,
    }

    for m in re.finditer(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", q):
        day, month = int(m.group(1)), int(m.group(2))
        year = int(m.group(3)) if m.group(3) else now.year
        if year < 100:
            year += 2000
        try:
            targets.add(datetime(year, month, day).date().isoformat())
        except ValueError:
            pass

    month_pattern = "|".join(sorted(month_names, key=len, reverse=True))
    for m in re.finditer(rf"\b(\d{{1,2}})\s+(?:de\s+)?({month_pattern})(?:\s+(\d{{4}}))?\b", q):
        day = int(m.group(1))
        month = month_names[m.group(2)]
        year = int(m.group(3)) if m.group(3) else now.year
        try:
            targets.add(datetime(year, month, day).date().isoformat())
        except ValueError:
            pass

    # « le 17 » : dans le contexte d'une question calendaire, on suppose
    # le mois courant. Cela évite que « qu'est-ce que j'ai le 17 ? »
    # n'interroge que l'utilitaire date.
    if not any(t[8:10] == q for t in targets):
        m = re.search(r"\b(?:le|pour|du)\s+(\d{1,2})(?:er)?\b", q)
        if m:
            day = int(m.group(1))
            try:
                candidate = datetime(now.year, now.month, day).date()
                targets.add(candidate.isoformat())
            except ValueError:
                pass

    weekdays = {
        "lundi": 0, "mardi": 1, "mercredi": 2, "jeudi": 3,
        "vendredi": 4, "samedi": 5, "dimanche": 6,
    }
    for name, wd in weekdays.items():
        if re.search(rf"\b{name}\b", q):
            delta = (wd - now.weekday()) % 7
            targets.add((now + timedelta(days=delta)).date().isoformat())

    return sorted(targets)


def parse_ai_plan(question):
    q = _normalize_ai_text(question)
    now = datetime.now().astimezone()
    tags = []
    reasons = []
    date_targets = extract_ai_date_targets(question, now)
    has_explicit_date = bool(date_targets)

    # La date/heure actuelle est injectée directement dans le prompt système.
    # Elle n'est donc PAS un utilitaire affiché ni une source d'événements scolaires.

    explicit_hw = any(x in q for x in (
        "devoir", "devoirs", "dm", "ds", "exercice", "travail à faire",
        "travail a faire", "rendre", "fait", "fais", "terminé", "termine"
    ))
    explicit_edt = any(x in q for x in (
        "emploi du temps", "edt", "cours", "horaire", "classe", "matière",
        "matiere", "prof", "quelle heure"
    ))
    explicit_mail = any(x in q for x in (
        "mail", "mails", "message", "messages", "messagerie", "notification",
        "courriel", "ecrit", "écrit"
    ))
    generic_calendar = has_explicit_date and any(x in q for x in (
        "quelque chose", "qqc", "quoi", "qu est ce", "qu'est ce", "y a",
        "prévu", "prevu", "programmé", "programme", "quelque", "truc", "événement", "evenement"
    ))

    if explicit_hw:
        tags.append("devoirs")
        reasons.append("Rechercher les devoirs à la date demandée et vérifier leur statut")
    if explicit_edt:
        tags.append("edt")
        reasons.append("Rechercher les cours à la date demandée")
    if explicit_mail:
        tags.append("mails")
        reasons.append("Rechercher les messages pertinents, y compris leur contenu")

    # Question calendaire vague : il faut balayer les trois sources scolaires.
    if generic_calendar:
        for tag, reason in (
            ("devoirs", "Vérifier les devoirs correspondant à cette date"),
            ("edt", "Vérifier l'emploi du temps de cette date"),
            ("mails", "Chercher une mention de cette date dans les messages"),
        ):
            if tag not in tags:
                tags.append(tag)
                reasons.append(reason)

    if not tags and any(x in q for x in ("école", "ecole", "lycée", "lycee", "scolaire", "school")):
        tags.extend(["devoirs", "edt"])
        reasons.extend(["Vérifier les devoirs", "Vérifier l'emploi du temps"])

    if not tags:
        reasons.append("Répondre sans récupérer de données scolaires supplémentaires")

    tags = list(dict.fromkeys(tags))
    return {"tags": tags, "reasons": reasons, "date_targets": date_targets}

def should_include_context(question):
    return {tag: tag in parse_ai_plan(question)["tags"] for tag in ("devoirs", "edt", "mails")}


def _get_relevant_homework_context(question, items):
    targets = set(extract_ai_date_targets(question))
    if targets:
        return [i for i in items if str(i.get("date", ""))[:10] in targets]
    return sorted(items, key=lambda i: (str(i.get("date", "")), str(i.get("matiere", ""))))[:30]



def _get_relevant_schedule_context(question, schedule):
    target_dates = extract_ai_date_targets(question)
    if not target_dates:
        target_dates = sorted(list(schedule.get("api", {}).keys()))[:7]

    return {
        "api": {d: schedule.get("api", {}).get(d, []) for d in target_dates},
        "overrides": {d: schedule.get("overrides", {}).get(d) for d in target_dates if d in schedule.get("overrides", {})},
        "default": schedule.get("default", {}),
        "priority": schedule.get("priority", ["local_override", "api", "local_default"]),
    }



def _get_relevant_messages_context(question, detailed_messages):
    q = _normalize_ai_text(question)
    target_dates = set(extract_ai_date_targets(question))
    month_names = {
        "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5,
        "juin": 6, "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10,
        "novembre": 11, "decembre": 12, "fevr": 2, "avr": 4, "sept": 9,
        "oct": 10, "nov": 11, "dec": 12,
    }

    tokens = [t for t in re.findall(r"[a-zà-ÿ0-9]{3,}", q) if t not in {
        "dans", "avec", "pour", "quelle", "quel", "quels", "quelles",
        "mail", "mails", "message", "messages", "messagerie", "quelque",
        "chose", "truc", "prévu", "prevu", "avoir", "est", "les", "des",
    }]

    scored = []
    for msg in detailed_messages:
        raw_hay = " ".join([
            str(msg.get("subject", "")), str(msg.get("sender", "")), str(msg.get("content", ""))
        ])
        hay = _normalize_ai_text(raw_hay)
        score = sum(1 for token in tokens if token in hay)

        for target in target_dates:
            dt = datetime.fromisoformat(target)
            day, month = dt.day, dt.month
            month_label = next((name for name, num in month_names.items() if num == month and len(name) > 3), "")
            date_regexes = [
                rf"\b0?{day}\s+{month_label}(?:\s+{dt.year})?\b",
                rf"\b0?{day}[\s/.-]+0?{month}[\s/.-]+{dt.year}\b",
                rf"\b0?{day}[\s/.-]+0?{month}\b",
            ]
            if any(re.search(pattern, hay) for pattern in date_regexes):
                score += 30
            # Pour « le 17 », le jour seul est un signal secondaire.
            if re.search(rf"\b0?{day}\b", hay):
                score += 2
            if str(msg.get("date", ""))[:10] == target:
                score += 8

        if score:
            scored.append((score, msg))

    scored.sort(key=lambda x: (-x[0], str(x[1].get("date", ""))))
    if target_dates:
        return [msg for score, msg in scored[:20] if score > 0]
    return [msg for _, msg in scored[:20]] if scored else detailed_messages[:20]


def build_ai_context(question):
    plan = parse_ai_plan(question)
    context = {"plan": plan}

    if "devoirs" in plan["tags"]:
        try:
            api_items = fetch_homeworks_from_ed()
        except Exception:
            api_items = []
        merged = merge_homeworks(api_items, load_homework_local())
        context["devoirs"] = _get_relevant_homework_context(question, merged)

    if "edt" in plan["tags"]:
        context["edt"] = _get_relevant_schedule_context(question, get_schedule_payload())

    if "mails" in plan["tags"]:
        try:
            messages = get_messages()
            detailed_messages = []
            for msg in messages[:30]:
                try:
                    detail = get_message_detail(msg["id"])
                    detailed_messages.append({
                        "id": detail["id"], "subject": detail["subject"], "date": detail["date"],
                        "sender": detail["sender"], "read": msg.get("read", False),
                        "content": detail["content"],
                    })
                except Exception as exc:
                    detailed_messages.append({**msg, "content": "", "content_error": str(exc)})
            context["mails"] = _get_relevant_messages_context(question, detailed_messages)
        except Exception:
            context["mails"] = []

    return context, plan


def clean_ai_response(text):
    """Retire les wrappers parasites produits parfois par les modèles locaux."""
    text = str(text or "").strip()
    for fence in ("'''", '"""'):
        if text.startswith(fence) and text.endswith(fence) and len(text) >= 6:
            text = text[3:-3].strip()
            if re.match(r"^markdown\s*\n", text, re.I):
                text = re.sub(r"^markdown\s*\n", "", text, count=1, flags=re.I)
            break
    return text.strip()


def call_local_ai(message, context):
    ollama_url = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
    model = os.getenv("OLLAMA_MODEL", "qwen3:8b")
    workflow = load_ai_workflow()
    now = datetime.now().astimezone()
    current_date_fr = f"{['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'][now.weekday()]} {now.strftime('%d/%m/%Y à %H:%M')}"

    system_prompt = workflow + (
        f"\n\nNOUS SOMMES LE {current_date_fr}. "
        "La date/heure actuelle est fournie directement dans ce prompt et n'est pas un utilitaire. "
        "Ne traite jamais la date seule comme une preuve d'événement scolaire. "
        "Pour toute date explicite dans une question vague, consulte systématiquement devoirs + edt + mails et recoupe les résultats. "
        "Pour les mails, recherche les dates dans le contenu, l'objet, l'expéditeur et la date d'envoi. "
        "N'affirme jamais avoir trouvé quelque chose sans l'avoir dans les données fournies. "
        "Réponds en Markdown valide uniquement, sans entourer toute la réponse de triples apostrophes ou de triples guillemets."
    )
    payload = {
        "model": model,
        "stream": False,
        "keep_alive": "10m",
        "options": {"temperature": 0.2, "num_ctx": 8192},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"DONNÉES DISPONIBLES :\n{json.dumps(context, ensure_ascii=False, indent=2)}\n\nQUESTION :\n{message}"},
        ],
    }

    response = requests.post(ollama_url, json=payload, timeout=(10, 300))
    response.raise_for_status()
    data = response.json()
    reply = clean_ai_response(data.get("message", {}).get("content") or data.get("response") or "")
    if not reply:
        raise RuntimeError("L'IA locale n'a renvoyé aucun texte.")
    return reply


def chat_stream_events(message):
    plan = parse_ai_plan(message)
    yield {"type": "plan", "plan": plan}

    # Construire le contexte étape par étape pour fournir un retour réel à l'interface.
    context = {"plan": plan}

    if "devoirs" in plan["tags"]:
        yield {"type": "step", "tag": "devoirs", "label": "Recherche des devoirs pertinents…"}
        try:
            api_items = fetch_homeworks_from_ed()
        except Exception:
            api_items = []
        merged = merge_homeworks(api_items, load_homework_local())
        context["devoirs"] = _get_relevant_homework_context(message, merged)

    if "edt" in plan["tags"]:
        yield {"type": "step", "tag": "edt", "label": "Lecture de l'emploi du temps pertinent…"}
        context["edt"] = _get_relevant_schedule_context(message, get_schedule_payload())

    if "mails" in plan["tags"]:
        yield {"type": "step", "tag": "mails", "label": "Recherche dans les messages récents…"}
        try:
            messages = get_messages()
            detailed_messages = []
            for msg in messages[:30]:
                try:
                    detail = get_message_detail(msg["id"])
                    detailed_messages.append({"id": detail["id"], "subject": detail["subject"], "date": detail["date"], "sender": detail["sender"], "read": msg.get("read", False), "content": detail["content"]})
                except Exception:
                    pass
            context["mails"] = _get_relevant_messages_context(message, detailed_messages)
        except Exception:
            context["mails"] = []

    yield {"type": "step", "tag": "ai", "label": "Analyse des informations utiles…"}

    ollama_url = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
    model = os.getenv("OLLAMA_MODEL", "qwen3:8b")
    workflow = load_ai_workflow()
    now = datetime.now().astimezone()
    current_date_fr = f"{['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'][now.weekday()]} {now.strftime('%d/%m/%Y à %H:%M')}"
    payload = {
        "model": model,
        "stream": False,
        "keep_alive": "10m",
        "options": {"temperature": 0.2, "num_ctx": 8192},
        "messages": [
            {"role": "system", "content": workflow + (f"\n\nNOUS SOMMES LE {current_date_fr}. La date/heure actuelle est fournie directement dans ce prompt et n'est pas un utilitaire. Pour toute date explicite dans une question vague, recoupe systématiquement devoirs + edt + mails. Recherche les dates dans le contenu, l'objet, l'expéditeur et la date d'envoi des mails. Réponds en Markdown valide uniquement, sans wrappers de triples apostrophes ou triples guillemets.")},
            {"role": "user", "content": f"DONNÉES DISPONIBLES :\n{json.dumps(context, ensure_ascii=False, indent=2)}\n\nQUESTION :\n{message}"},
        ],
    }
    response = requests.post(ollama_url, json=payload, timeout=(10, 300))
    response.raise_for_status()
    data = response.json()
    reply = clean_ai_response(data.get("message", {}).get("content") or data.get("response") or "")
    if not reply:
        raise RuntimeError("L'IA locale n'a renvoyé aucun texte.")
    yield {"type": "done", "reply": reply, "context_used": [k for k in context if k not in ("plan",)]}


# ---------------------------------------------------------------------------
# ROUTES PAGE / FICHIERS
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


@app.route("/data/<path:filename>")
def serve_data(filename):
    return send_from_directory(DATA_DIR, filename)


# ---------------------------------------------------------------------------
# API APPLICATION
# ---------------------------------------------------------------------------

@app.route("/api/data", methods=["GET", "POST"])
def api_data():
    username, password = _credentials_for_request()
    if not username or not password:
        return jsonify({
            "success": False,
            "error_type": "credentials_missing",
            "error": "Identifiants ÉcoleDirecte manquants.",
            "generated_at": datetime.now().isoformat(),
        }), 401

    try:
        # Un seul service ED est créé/réutilisé pour toute la requête.
        service = get_ed_service(username, password)

        # L'authentification doit être valide avant de demander les données.
        api_homeworks = fetch_homeworks_from_ed()
        messages = get_messages()
        schedule = get_schedule_payload()

        login_data = service.last_login_data or {}
        accounts = login_data.get("data", {}).get("accounts", [])
        account = accounts[0] if accounts else {}

        return jsonify({
            "success": True,
            "account": account,
            "schedule": schedule,
            "homeworks": {
                "items": api_homeworks,
                "api_ok": True,
                "api_error": None,
                "local": {"items": [], "deleted_api_ids": []},
            },
            "messages": {
                "items": messages,
                "api_ok": True,
                "api_error": None,
            },
            "generated_at": datetime.now().isoformat(),
        })
    except Exception as exc:
        message = str(exc)
        if isinstance(exc, EcoleDirecteCooldownError):
            return jsonify({
                "success": False,
                "error_type": "ecoledirecte_cooldown",
                "error": message,
                "generated_at": datetime.now().isoformat(),
            }), 429
        auth_like = any(token in message for token in (
            "(505)", "code=505", "Mot de passe invalide",
            "Identifiant et/ou mot de passe invalide", "Identifiants ÉcoleDirecte"
        ))
        return jsonify({
            "success": False,
            "error_type": "ecoledirecte_authentication" if auth_like else "backend_error",
            "error": message,
            "generated_at": datetime.now().isoformat(),
        }), (401 if auth_like else 502)


@app.route("/api/schedule_changes", methods=["GET", "POST"])
def api_schedule_changes():
    if request.method == "GET":
        return jsonify(load_schedule_overrides())

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"success": False, "error": "Objet JSON attendu."}), 400

    write_json(SCHEDULE_CHANGES_FILE, payload)
    return jsonify({"success": True})


@app.route("/api/homeworks", methods=["GET", "POST"])
def api_homeworks():
    if request.method == "GET":
        return jsonify(load_homework_local())

    payload = request.get_json(silent=True)

    # Compatibilité : l'ancien front envoyait directement une liste.
    if isinstance(payload, list):
        payload = {"items": payload, "deleted_api_ids": []}

    if not isinstance(payload, dict):
        return jsonify({"success": False, "error": "Objet JSON attendu."}), 400

    items = payload.get("items", [])
    deleted = payload.get("deleted_api_ids", [])

    if not isinstance(items, list) or not isinstance(deleted, list):
        return jsonify({"success": False, "error": "Format de devoirs invalide."}), 400

    cleaned_items = []
    for item in items:
        if isinstance(item, dict):
            copied = dict(item)
            if copied.get("api_id") is not None:
                copied["api_id"] = str(copied["api_id"])
            copied["id"] = str(copied.get("id") or f"local_{len(cleaned_items)}")
            copied["completed"] = parse_bool(copied.get("completed", False))
            cleaned_items.append(copied)

    state = {
        "items": cleaned_items,
        "deleted_api_ids": [str(x) for x in deleted],
    }
    write_json(HOMEWORK_LOCAL_FILE, state)

    return jsonify({"success": True, "data": state})


@app.route("/api/homeworks/status", methods=["POST"])
def api_homework_status():
    payload = request.get_json(silent=True) or {}
    try:
        completed = [int(x) for x in payload.get("completed_ids", [])]
        uncompleted = [int(x) for x in payload.get("uncompleted_ids", [])]
    except (TypeError, ValueError):
        return jsonify({"success": False, "error": "IDs de devoir invalides."}), 400

    if not completed and not uncompleted:
        return jsonify({"success": True, "api": False, "message": "Aucun changement à envoyer."})

    try:
        result = ed_call("set_homework_status", completed, uncompleted)
        ok = isinstance(result, dict) and result.get("code") == 200
        return jsonify({"success": ok, "api": True, "data": result}), (200 if ok else 502)
    except Exception as exc:
        return jsonify({"success": False, "api": True, "error": str(exc)}), 502


@app.route("/api/messages", methods=["GET"])
def api_messages():
    try:
        messages = get_messages()
        unread = sum(1 for message in messages if not message["read"])
        return jsonify({"success": True, "messages": messages, "unread": unread})
    except Exception as exc:
        return jsonify({"success": False, "messages": [], "unread": 0, "error": str(exc)}), 502


@app.route("/api/messages/<message_id>", methods=["GET"])
def api_message_detail(message_id):
    try:
        return jsonify({"success": True, "message": get_message_detail(message_id)})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


@app.route("/api/debug/homeworks", methods=["GET"])
def api_debug_homeworks():
    """Endpoint de diagnostic local pour comprendre exactement ce que renvoie ED."""
    try:
        service = get_ed_service()
        overview = service.get_homework_overview()
        overview_data = overview.get("data", {}) if isinstance(overview, dict) else {}

        dates = sorted(_extract_homework_overview_dates(overview_data).keys())
        if not dates:
            today = datetime.now().date()
            dates = [(today + timedelta(days=i)).isoformat() for i in range(0, 7)]

        details = {}
        for day in dates[:10]:
            detail = service.get_homework_detail(day)
            detail_data = detail.get("data") if isinstance(detail, dict) else None
            normalized = _extract_detail_homeworks(detail_data or {}, day) if isinstance(detail_data, (dict, list)) else []
            matieres = detail_data.get("matieres", []) if isinstance(detail_data, dict) else []
            details[day] = {
                "code": detail.get("code") if isinstance(detail, dict) else None,
                "message": detail.get("message") if isinstance(detail, dict) else None,
                "data_type": type(detail_data).__name__,
                "data_keys": list(detail_data.keys())[:50] if isinstance(detail_data, dict) else [],
                "matieres_count": len(matieres) if isinstance(matieres, list) else None,
                "matieres_debug": [
                    {
                        "nomMatiere": m.get("nomMatiere") if isinstance(m, dict) else None,
                        "keys": list(m.keys()) if isinstance(m, dict) else [],
                        "aFaire": m.get("aFaire") if isinstance(m, dict) else None,
                    }
                    for m in matieres if isinstance(m, dict)
                ],
                "normalized_items": normalized,
                "raw": detail,
            }

        return jsonify({
            "success": True,
            "overview": overview,
            "overview_data_type": type(overview_data).__name__,
            "overview_dates": dates,
            "details": details,
        })
    except Exception as exc:
        return jsonify({"success": False, "error": repr(exc)}), 502


@app.route("/api/chat/stream", methods=["POST"])
def api_chat_stream():
    from flask import Response, stream_with_context
    payload = request.get_json(silent=True) or {}
    message = str(payload.get("message", "")).strip()
    if not message:
        return jsonify({"success": False, "error": "Écris une question."}), 400

    def generate():
        try:
            for event in chat_stream_events(message):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "error": str(exc)}, ensure_ascii=False) + "\n"

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")


@app.route("/api/chat", methods=["POST"])
def api_chat():
    payload = request.get_json(silent=True) or {}
    message = str(payload.get("message", "")).strip()
    if not message:
        return jsonify({"success": False, "reply": "Écris une question."}), 400
    try:
        context, plan = build_ai_context(message)
        reply = call_local_ai(message, context)
        return jsonify({"success": True, "reply": reply, "context_used": [k for k in context if k not in ("plan",)], "plan": plan})
    except Exception as exc:
        return jsonify({"success": False, "reply": f"Impossible d'utiliser l'IA locale : {exc}"}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)

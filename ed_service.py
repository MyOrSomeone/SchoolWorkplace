import base64
import json
import os
from datetime import date, timedelta

import requests

BASE_URL = "https://api.ecoledirecte.com/v3"
API_VERSION = "4.91.0"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

QCM_ANSWERS = {
    "Quelle est votre année de naissance ?": "2009",
    "Quel est votre mois de naissance ?": "03",
    "Quelle est votre classe ?": "T2",
    "Quel est votre jour de naissance ?": "21",
    "Quel est le nom de famille de votre professeur principal ?": "PODEUR",
}


class EcoleDirecteService:
    def __init__(self, username, password, token_file="tokens.json"):
        self.username = username
        self.password = password
        self.token_file = token_file
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.token = None
        self.cn = None
        self.cv = None
        self.last_login_data = None
        self.student_id = None
        self._load_tokens()

    # ------------------------------------------------------------------
    # Session / login
    # ------------------------------------------------------------------

    def _load_tokens(self):
        """
        Charge les tokens cn/cv depuis tokens.json ou depuis les variables
        d'environnement Render en nettoyant systématiquement les caractères parasites (\r, \n, espaces).
        """
        loaded_from_file = False
        try:
            with open(self.token_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            cn = data.get("cn")
            cv = data.get("cv")
            if cn and cv:
                self.cn = str(cn).strip()
                self.cv = str(cv).strip()
                loaded_from_file = True
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
    
        # Si aucun token valide n'a été trouvé dans le fichier local, on lit l'environnement Render
        if not (self.cn and self.cv):
            cn_env = os.getenv("ECOLEDIRECTE_CN") or os.getenv("ED_CN")
            cv_env = os.getenv("ECOLEDIRECTE_CV") or os.getenv("ED_CV")
            if cn_env:
                self.cn = str(cn_env).strip()
            if cv_env:
                self.cv = str(cv_env).strip()
    
        source = "tokens.json" if loaded_from_file else ("variables Render" if (self.cn and self.cv) else "aucune")
        print(
            f"[ED][TOKENS] Source={source} | "
            f"CN présent={bool(self.cn)} (longueur={len(self.cn) if self.cn else 0}) | "
            f"CV présent={bool(self.cv)} (longueur={len(self.cv) if self.cv else 0})"
        )

    def _save_tokens(self):
        if self.cn and self.cv:
            with open(self.token_file, "w", encoding="utf-8") as f:
                json.dump({"cn": self.cn, "cv": self.cv}, f)

    def _fetch_gtk(self):
        response = self.session.get(
            f"{BASE_URL}/login.awp?gtk=1&v={API_VERSION}",
            timeout=20,
        )
        gtk = response.cookies.get("GTK")
        if gtk:
            self.session.headers.update({"X-GTK": gtk})
        return gtk

    @staticmethod
    def _decode_smart(value):
        if not value:
            return ""
        text = str(value).strip()
        for _ in range(3):
            compact = __import__("re").sub(r"\s+", "", text)
            compact += "=" * (-len(compact) % 4)
            try:
                decoded = base64.b64decode(compact, validate=False).decode("utf-8")
            except Exception:
                break
            printable = sum(ch.isprintable() or ch in "\n\r\t" for ch in decoded)
            if printable < max(8, int(len(decoded) * 0.90)):
                break
            text = decoded
            if not __import__("re").fullmatch(r"[A-Za-z0-9+/=_\-]+", __import__("re").sub(r"\s+", "", text)):
                break
        return text

    def login(self, ignore_saved_tokens=False):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self._fetch_gtk()

        payload = {
            "identifiant": self.username,
            "motdepasse": self.password,
            "isRelogin": False,
            "uuid": "",
            "sesouvenirdemoi": True,
            "fa": [],
        }

        if not ignore_saved_tokens and self.cn and self.cv:
            payload["cn"] = self.cn
            payload["cv"] = self.cv
            payload["fa"] = [{"cn": self.cn, "cv": self.cv}]

        url = f"{BASE_URL}/login.awp?v={API_VERSION}"
        response = self.session.post(
            url,
            data={"data": json.dumps(payload)},
            timeout=30,
        )
        data = response.json()

        if data.get("code") == 505 and (self.cn or self.cv):
            # Ne pas supprimer les tokens fournis par Render.
            if not (os.getenv("ECOLEDIRECTE_CN") and os.getenv("ECOLEDIRECTE_CV")):
                self.cn = self.cv = None
                try:
                    os.remove(self.token_file)
                except OSError:
                    pass
                return self.login(ignore_saved_tokens=True)

        if data.get("code") == 250:
            temp_token = data.get("token") or response.headers.get("x-token")
            two_fa = response.headers.get("2fa-token") or response.headers.get("2FA-Token")

            self.session.headers.pop("X-GTK", None)
            if temp_token:
                self.session.headers.update({"X-Token": temp_token})
            if two_fa:
                self.session.headers.update({"2fa-Token": two_fa})

            self.cn, self.cv = self._solve_qcm()
            self._save_tokens()

            self._fetch_gtk()
            payload["cn"] = self.cn
            payload["cv"] = self.cv
            payload["fa"] = [{"cn": self.cn, "cv": self.cv}]

            response = self.session.post(
                url,
                data={"data": json.dumps(payload)},
                timeout=30,
            )
            data = response.json()

        if data.get("code") != 200:
            raise RuntimeError(
                f"Échec de connexion ED ({data.get('code')}) : {data.get('message', '')}"
            )

        self.token = data.get("token") or response.headers.get("x-token") or response.headers.get("X-Token")
        if self.token:
            self.session.headers.update({"X-Token": self.token})

        accounts = data.get("data", {}).get("accounts", [])
        if accounts:
            self.student_id = accounts[0].get("id")

        self.last_login_data = data
        return data

    def _solve_qcm(self):
        get_url = f"{BASE_URL}/connexion/doubleauth.awp?verbe=get&v={API_VERSION}"
        response = self.session.post(get_url, data={"data": "{}"}, timeout=30)
        qcm = response.json()

        # La double-auth peut renvoyer les propositions sous forme Base64,
        # même lorsqu'elles ne contiennent qu'une valeur très simple (ex. "21").
        # Pour le QCM, on fait donc un décodage Base64 explicite d'une seule couche
        # au lieu d'utiliser _decode_smart(), qui est volontairement heuristique.
        def decode_qcm_value(value):
            if value is None:
                return ""
            text = str(value).strip()
            compact = re.sub(r"\s+", "", text)
            padded = compact + "=" * (-len(compact) % 4)
            try:
                decoded = base64.b64decode(padded, validate=True).decode("utf-8")
                return decoded.strip()
            except Exception:
                return text

        import re
        question = decode_qcm_value(qcm["data"]["question"])
        propositions_b64 = qcm["data"]["propositions"]
        propositions = [decode_qcm_value(p) for p in propositions_b64]

        # ÉcoleDirecte peut varier légèrement la ponctuation, les espaces ou
        # l'encodage de la question. On normalise donc avant la recherche.
        import re
        import unicodedata

        def norm_text(value):
            value = unicodedata.normalize("NFKD", str(value or ""))
            value = "".join(ch for ch in value if not unicodedata.combining(ch))
            return re.sub(r"\s+", " ", value).strip().casefold()

        answers = {norm_text(k): v for k, v in QCM_ANSWERS.items()}
        nquestion = norm_text(question)
        answer = answers.get(nquestion)

        # Fallback tolérant : certaines installations renvoient une question
        # avec une petite variation de formulation.
        if answer is None:
            for key, value in answers.items():
                if key in nquestion or nquestion in key:
                    answer = value
                    break

        chosen = None

        def answer_matches(expected, proposition):
            expected_n = norm_text(expected)
            prop_n = norm_text(proposition)
            if expected_n == prop_n or expected_n in prop_n:
                return True
            try:
                if expected_n.isdigit():
                    n = int(expected_n)
                    if prop_n.isdigit() and n == int(prop_n):
                        return True
                    months = [
                        "janvier", "fevrier", "mars", "avril", "mai", "juin",
                        "juillet", "aout", "septembre", "octobre", "novembre", "decembre"
                    ]
                    if 1 <= n <= 12 and norm_text(months[n - 1]) == prop_n:
                        return True
                    if n in (1, 21, 2009) and prop_n.isdigit() and n == int(prop_n):
                        return True
            except Exception:
                pass
            return False

        if answer:
            for idx, proposition in enumerate(propositions):
                if answer_matches(answer, proposition):
                    chosen = propositions_b64[idx]
                    break

        if not answer:
            raise RuntimeError(
                f"Question 2FA inconnue : {question!r}. Ajoute sa réponse à QCM_ANSWERS."
            )
        if not chosen:
            raise RuntimeError(
                f"Réponse 2FA configurée mais proposition introuvable pour {question!r}. "
                f"Réponse configurée={answer!r}, propositions_decoded={propositions!r}, "
                f"propositions_brutes={propositions_b64!r}"
            )

        post_url = f"{BASE_URL}/connexion/doubleauth.awp?verbe=post&v={API_VERSION}"
        result = self.session.post(
            post_url,
            data={"data": json.dumps({"choix": chosen})},
            timeout=30,
        ).json()

        if result.get("code") != 200:
            raise RuntimeError(f"Échec validation QCM : {result}")

        return result["data"]["cn"], result["data"]["cv"]

    # ------------------------------------------------------------------
    # Requête générique
    # ------------------------------------------------------------------

    def _post(self, url, payload, retry=True):
        response = self.session.post(
            url,
            data={"data": json.dumps(payload)},
            timeout=30,
        )
        data = response.json()

        new_token = data.get("token") or response.headers.get("x-token") or response.headers.get("X-Token")
        if new_token:
            self.token = new_token
            self.session.headers.update({"X-Token": new_token})

        # Important : 403 n'est PAS traité comme une expiration de token.
        if data.get("code") in (520, 525) and retry:
            self.login()
            return self._post(url, payload, retry=False)

        return data

    # ------------------------------------------------------------------
    # Emploi du temps
    # ------------------------------------------------------------------

    def get_schedule_range(self, start_date, end_date):
        if not self.student_id:
            raise RuntimeError("student_id absent : connecte-toi d'abord.")

        payload = {
            "dateDebut": start_date,
            "dateFin": end_date,
            "avecTrous": False,
            "isCalDAV": False,
        }

        url = (
            f"{BASE_URL}/E/{self.student_id}/emploidutemps.awp"
            f"?verbe=get&v={API_VERSION}"
        )
        return self._post(url, payload)

    # ------------------------------------------------------------------
    # Devoirs
    # ------------------------------------------------------------------

    def get_homework_overview(self):
        if not self.student_id:
            raise RuntimeError("student_id absent.")

        url = (
            f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte.awp"
            f"?verbe=get&v={API_VERSION}"
        )
        result = self._post(url, {})
        print(f"[ED][HOMEWORK] overview -> code={result.get('code')} data_type={type(result.get('data')).__name__}")
        return result

    def get_homework_detail(self, date_str):
        if not self.student_id:
            raise RuntimeError("student_id absent.")

        url = (
            f"{BASE_URL}/Eleves/{self.student_id}/"
            f"cahierdetexte/{date_str}.awp"
            f"?verbe=get&v={API_VERSION}"
        )
        result = self._post(url, {})
        print(f"[ED][HOMEWORK] detail {date_str} -> code={result.get('code')} data_type={type(result.get('data')).__name__}")
        return result


    def set_homework_status(self, completed_ids=None, uncompleted_ids=None):
        """Marque les devoirs indiqués comme faits / non faits côté ÉcoleDirecte."""
        if not self.student_id:
            raise RuntimeError("student_id absent.")

        payload = {
            "idDevoirsEffectues": [int(x) for x in (completed_ids or [])],
            "idDevoirsNonEffectues": [int(x) for x in (uncompleted_ids or [])],
        }
        url = (
            f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte.awp"
            f"?verbe=put&v={API_VERSION}"
        )
        return self._post(url, payload)

    # ------------------------------------------------------------------
    # Messagerie
    # ------------------------------------------------------------------

    def get_messages_list(self):
        if not self.student_id:
            raise RuntimeError("student_id absent.")

        school_year = (
            f"{date.today().year}-{date.today().year + 1}"
            if date.today().month >= 8
            else f"{date.today().year - 1}-{date.today().year}"
        )
        payload = {"anneeMessages": school_year}

        url = (
            f"{BASE_URL}/eleves/{self.student_id}/messages.awp"
            f"?verbe=getall&typeRecuperation=received&orderBy=date"
            f"&order=desc&page=0&itemsPerPage=30&onlyReceived=true"
            f"&v={API_VERSION}"
        )
        return self._post(url, payload)

    def get_message_content(self, message_id):
        if not self.student_id:
            raise RuntimeError("student_id absent.")

        school_year = (
            f"{date.today().year}-{date.today().year + 1}"
            if date.today().month >= 8
            else f"{date.today().year - 1}-{date.today().year}"
        )
        payload = {"anneeMessages": school_year}

        url = (
            f"{BASE_URL}/eleves/{self.student_id}/messages/{message_id}.awp"
            f"?verbe=get&mode=destinataire&v={API_VERSION}"
        )
        return self._post(url, payload)

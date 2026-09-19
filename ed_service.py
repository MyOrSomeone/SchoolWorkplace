import base64
import json
import os
import re
from datetime import date

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
    def __init__(self, username, password, token_file="/tmp/tokens.json"):
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

    def _load_tokens(self):
        try:
            with open(self.token_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.cn = data.get("cn")
            self.cv = data.get("cv")
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

    def _save_tokens(self):
        if self.cn and self.cv:
            try:
                with open(self.token_file, "w", encoding="utf-8") as f:
                    json.dump({"cn": self.cn, "cv": self.cv}, f)
            except OSError:
                pass

    def _fetch_gtk(self):
        response = self.session.get(
            f"{BASE_URL}/login.awp?gtk=1&v={API_VERSION}",
            timeout=20,
        )
        gtk = response.cookies.get("GTK")
        if gtk:
            self.session.headers.update({"X-GTK": gtk})
        return gtk

    def login(self, ignore_saved_tokens=False):
        # L'ordre des tentatives est volontairement explicite : cela permet
        # de distinguer un problème de cn/cv d'un vrai refus des identifiants.
        attempts = []

        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        gtk = self._fetch_gtk()
        print(
            f"[ED AUTH] GTK={'OK' if gtk else 'MISSING'} | "
            f"api_version={API_VERSION} | password_received={'YES' if self.password else 'NO'} | "
            f"password_length={len(self.password or '')}"
        )

        payload = {
            "identifiant": self.username,
            "motdepasse": self.password,
            "isRelogin": False,
            "uuid": "",
            "sesouvenirdemoi": True,
            "fa": [],
        }

        used_saved_tokens = bool(not ignore_saved_tokens and self.cn and self.cv)
        if used_saved_tokens:
            payload["cn"] = self.cn
            payload["cv"] = self.cv
            payload["fa"] = [{"cn": self.cn, "cv": self.cv}]

        print(
            f"[ED AUTH] login attempt | saved_tokens={'YES' if used_saved_tokens else 'NO'} | "
            f"cn_len={len(str(self.cn)) if self.cn else 0} | cv_len={len(str(self.cv)) if self.cv else 0}"
        )

        url = f"{BASE_URL}/login.awp?v={API_VERSION}"
        response = self.session.post(
            url,
            data={"data": json.dumps(payload)},
            timeout=30,
        )
        data = response.json()
        code = data.get("code")
        message = data.get("message", "")
        attempts.append((code, message, used_saved_tokens))
        print(
            f"[ED AUTH] response | code={code} | message={message!r} | "
            f"saved_tokens={'YES' if used_saved_tokens else 'NO'} | "
            f"response_cookies={list(response.cookies.keys())}"
        )

        if code == 505 and used_saved_tokens:
            print("[ED AUTH] 505 avec tokens sauvegardés -> suppression et retry SANS tokens")
            self.cn = self.cv = None
            try:
                os.remove(self.token_file)
            except OSError:
                pass
            return self.login(ignore_saved_tokens=True)

        if code == 250:
            temp_token = data.get("token") or response.headers.get("x-token")
            two_fa = response.headers.get("2fa-token") or response.headers.get("2FA-Token")

            print(
                f"[ED AUTH] 2FA | temp_token={'YES' if temp_token else 'NO'} | "
                f"two_fa_token={'YES' if two_fa else 'NO'}"
            )

            self.session.headers.pop("X-GTK", None)
            if temp_token:
                self.session.headers.update({"X-Token": temp_token})
            if two_fa:
                self.session.headers.update({"2fa-Token": two_fa})

            self.cn, self.cv = self._solve_qcm()
            print("[ED AUTH] QCM OK | new cn/cv received=YES")
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
            code = data.get("code")
            message = data.get("message", "")
            attempts.append((code, message, False))
            print(
                f"[ED AUTH] post-QCM response | code={code} | message={message!r} | "
                f"cn/cv=YES"
            )

        if code != 200:
            attempt_text = "; ".join(
                f"#{i + 1} code={a_code} message={a_msg!r} tokens={'YES' if a_tokens else 'NO'}"
                for i, (a_code, a_msg, a_tokens) in enumerate(attempts)
            )
            raise RuntimeError(
                f"Échec de connexion ED ({code}) : {message} "
                f"[diagnostic: {attempt_text}; api_version={API_VERSION}; "
                f"gtk={'present' if self.session.headers.get('X-GTK') else 'absent'}; "
                f"password_length={len(self.password or '')}]"
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

        question = decode_qcm_value(qcm["data"]["question"])
        propositions_b64 = qcm["data"]["propositions"]
        propositions = [decode_qcm_value(p) for p in propositions_b64]

        answer = QCM_ANSWERS.get(question)
        chosen = None

        if answer:
            for idx, prop in enumerate(propositions):
                if answer in prop or prop in answer:
                    chosen = propositions_b64[idx]
                    break

        if not chosen:
            raise RuntimeError(f"Impossible de résoudre la 2FA pour la question : {question}")

        post_url = f"{BASE_URL}/connexion/doubleauth.awp?verbe=post&v={API_VERSION}"
        result = self.session.post(
            post_url,
            data={"data": json.dumps({"choix": chosen})},
            timeout=30,
        ).json()

        if result.get("code") != 200:
            raise RuntimeError(f"Échec validation QCM : {result}")

        return result["data"]["cn"], result["data"]["cv"]

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

        if data.get("code") in (520, 525) and retry:
            self.login()
            return self._post(url, payload, retry=False)

        return data

    def get_homework_overview(self):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        url = f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte.awp?verbe=get&v={API_VERSION}"
        return self._post(url, {})

    def get_homework_detail(self, date_str):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        url = f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte/{date_str}.awp?verbe=get&v={API_VERSION}"
        return self._post(url, {})

    def set_homework_status(self, completed_ids=None, uncompleted_ids=None):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        payload = {
            "idDevoirsEffectues": [int(x) for x in (completed_ids or [])],
            "idDevoirsNonEffectues": [int(x) for x in (uncompleted_ids or [])],
        }
        url = f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte.awp?verbe=put&v={API_VERSION}"
        return self._post(url, payload)

    def get_messages_list(self):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        school_year = f"{date.today().year}-{date.today().year + 1}" if date.today().month >= 8 else f"{date.today().year - 1}-{date.today().year}"
        payload = {"anneeMessages": school_year}
        url = f"{BASE_URL}/eleves/{self.student_id}/messages.awp?verbe=getall&typeRecuperation=received&orderBy=date&order=desc&page=0&itemsPerPage=30&onlyReceived=true&v={API_VERSION}"
        return self._post(url, payload)

import base64
import json
import os
import hashlib
import re
from datetime import date

import requests

BASE_URL = "https://api.ecoledirecte.com/v3"
API_VERSION = os.getenv("ED_API_VERSION", "4.100.4")
LEGACY_API_VERSION = "4.91.0"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

QCM_ANSWERS = {
    "Quelle est votre année de naissance ?": "2009",
    "Quel est votre mois de naissance ?": "03",
    "Quelle est votre classe ?": "T2",
    "Quel est votre jour de naissance ?": "21",
    "Quel est le nom de famille de votre professeur principal ?": "PODEUR",
}


def password_fingerprint(password):
    if password is None:
        return "NONE"
    return hashlib.sha256(str(password).encode("utf-8")).hexdigest()[:16]


class EcoleDirecteService:
    def __init__(self, username, password, token_file="/tmp/tokens.json", api_version=None):
        self.username = username
        self.password = password
        self.api_version = api_version or API_VERSION
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
            f"{BASE_URL}/login.awp?gtk=1&v={self.api_version}",
            timeout=20,
        )
        gtk = response.cookies.get("GTK")
        if gtk:
            self.session.headers.update({"X-GTK": gtk})
        return gtk

    def _login_once(self, use_saved_tokens):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        gtk = self._fetch_gtk()
        print(
            f"[ED AUTH] prelogin | api_version={self.api_version} | gtk={'OK' if gtk else 'MISSING'} | "
            f"password_received={'YES' if self.password else 'NO'} | password_length={len(self.password or '')} | "
            f"password_sha256_prefix={password_fingerprint(self.password)}"
        )

        payload = {
            "identifiant": self.username,
            "motdepasse": self.password,
            "isRelogin": False,
            "uuid": "",
            "sesouvenirdemoi": True,
            "fa": [],
        }

        if use_saved_tokens and self.cn and self.cv:
            payload["cn"] = self.cn
            payload["cv"] = self.cv
            payload["fa"] = [{"cn": self.cn, "cv": self.cv}]

        print(
            f"[ED AUTH] login attempt | api_version={self.api_version} | saved_tokens={'YES' if use_saved_tokens else 'NO'} | "
            f"cn_len={len(str(self.cn)) if self.cn else 0} | cv_len={len(str(self.cv)) if self.cv else 0}"
        )

        url = f"{BASE_URL}/login.awp?v={self.api_version}"
        response = self.session.post(url, data={"data": json.dumps(payload)}, timeout=30)
        data = response.json()
        code = data.get("code")
        message = data.get("message", "")
        print(
            f"[ED AUTH] response | api_version={self.api_version} | code={code} | message={message!r} | "
            f"saved_tokens={'YES' if use_saved_tokens else 'NO'} | response_cookies={list(response.cookies.keys())}"
        )
        return response, data

    def login(self, ignore_saved_tokens=False, allow_version_fallback=True):
        attempts = []
        use_saved_tokens = bool(not ignore_saved_tokens and self.cn and self.cv)

        response, data = self._login_once(use_saved_tokens)
        attempts.append((self.api_version, data.get("code"), data.get("message", ""), use_saved_tokens))

        # 505 + saved cn/cv : les tokens sont peut-être invalides, on les retire et
        # on refait exactement le même login sans tokens.
        if data.get("code") == 505 and use_saved_tokens:
            print("[ED AUTH] 505 avec cn/cv -> suppression des tokens et retry SANS tokens")
            self.cn = self.cv = None
            try:
                os.remove(self.token_file)
            except OSError:
                pass
            response, data = self._login_once(False)
            attempts.append((self.api_version, data.get("code"), data.get("message", ""), False))

        # Si même le login propre sans cn/cv donne 505, on fait UNE SEULE tentative
        # avec une version de l'API récente. Cela permet de distinguer version/API
        # des credentials sans provoquer une boucle de tentatives.
        if (
            data.get("code") == 505
            and not use_saved_tokens
            and allow_version_fallback
            and self.api_version != LEGACY_API_VERSION
        ):
            old_version = self.api_version
            self.api_version = LEGACY_API_VERSION
            print(
                f"[ED AUTH] 505 sans tokens -> test diagnostic avec version alternative {self.api_version} "
                f"(version principale {old_version})"
            )
            response, data = self._login_once(False)
            attempts.append((self.api_version, data.get("code"), data.get("message", ""), False))
            # Ne garde comme version active que la version qui a effectivement permis le login.
            if data.get("code") != 200 and data.get("code") != 250:
                self.api_version = old_version

        if data.get("code") == 250:
            temp_token = data.get("token") or response.headers.get("x-token")
            two_fa = response.headers.get("2fa-token") or response.headers.get("2FA-Token")
            print(
                f"[ED AUTH] 2FA | api_version={self.api_version} | temp_token={'YES' if temp_token else 'NO'} | "
                f"two_fa_token={'YES' if two_fa else 'NO'}"
            )

            self.session.headers.pop("X-GTK", None)
            if temp_token:
                self.session.headers.update({"X-Token": temp_token})
            if two_fa:
                self.session.headers.update({"2fa-Token": two_fa})

            self.cn, self.cv = self._solve_qcm()
            print(f"[ED AUTH] QCM OK | api_version={self.api_version} | new cn/cv received=YES")
            self._save_tokens()

            # Après le QCM, ED demande un nouveau GTK puis le relogin avec cn/cv.
            self._fetch_gtk()
            payload = {
                "identifiant": self.username,
                "motdepasse": self.password,
                "isRelogin": False,
                "uuid": "",
                "sesouvenirdemoi": True,
                "cn": self.cn,
                "cv": self.cv,
                "fa": [{"cn": self.cn, "cv": self.cv}],
            }
            url = f"{BASE_URL}/login.awp?v={self.api_version}"
            response = self.session.post(url, data={"data": json.dumps(payload)}, timeout=30)
            data = response.json()
            print(
                f"[ED AUTH] post-QCM response | api_version={self.api_version} | code={data.get('code')} | "
                f"message={data.get('message', '')!r} | cn/cv=YES"
            )
            attempts.append((self.api_version, data.get("code"), data.get("message", ""), True))

        if data.get("code") != 200:
            attempt_text = "; ".join(
                f"#{i + 1} version={ver} code={code} message={msg!r} tokens={'YES' if toks else 'NO'}"
                for i, (ver, code, msg, toks) in enumerate(attempts)
            )
            raise RuntimeError(
                f"Échec de connexion ED ({data.get('code')}) : {data.get('message', '')} "
                f"[diagnostic: {attempt_text}; password_length={len(self.password or '')}; "
                f"password_sha256_prefix={password_fingerprint(self.password)}]"
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
        get_url = f"{BASE_URL}/connexion/doubleauth.awp?verbe=get&v={self.api_version}"
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

        post_url = f"{BASE_URL}/connexion/doubleauth.awp?verbe=post&v={self.api_version}"
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
            self.login(allow_version_fallback=True)
            return self._post(url, payload, retry=False)

        return data

    def get_homework_overview(self):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        url = f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte.awp?verbe=get&v={self.api_version}"
        return self._post(url, {})

    def get_homework_detail(self, date_str):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        url = f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte/{date_str}.awp?verbe=get&v={self.api_version}"
        return self._post(url, {})

    def set_homework_status(self, completed_ids=None, uncompleted_ids=None):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        payload = {
            "idDevoirsEffectues": [int(x) for x in (completed_ids or [])],
            "idDevoirsNonEffectues": [int(x) for x in (uncompleted_ids or [])],
        }
        url = f"{BASE_URL}/Eleves/{self.student_id}/cahierdetexte.awp?verbe=put&v={self.api_version}"
        return self._post(url, payload)

    def get_messages_list(self):
        if not self.student_id:
            raise RuntimeError("student_id absent.")
        school_year = f"{date.today().year}-{date.today().year + 1}" if date.today().month >= 8 else f"{date.today().year - 1}-{date.today().year}"
        payload = {"anneeMessages": school_year}
        url = f"{BASE_URL}/eleves/{self.student_id}/messages.awp?verbe=getall&typeRecuperation=received&orderBy=date&order=desc&page=0&itemsPerPage=30&onlyReceived=true&v={self.api_version}"
        return self._post(url, payload)
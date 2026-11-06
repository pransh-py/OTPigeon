import os
from dataclasses import dataclass, fields

from dotenv import load_dotenv


@dataclass(frozen=True)
class GatewaySettings:
    mongodb_url: str = "mongodb://127.0.0.1:27017/?replicaSet=otpigeon"
    mongodb_db_name: str = "otpigeon_gateway"
    secret: str = ""
    expiry_seconds: int = 300
    cooldown_seconds: int = 60
    max_attempts: int = 5
    max_resends: int = 3
    destination_sends_per_hour: int = 5
    destination_guesses_per_hour: int = 10
    project_sends_per_hour: int = 1000
    enable_legacy: bool = False
    legacy_admin_token: str = ""
    admin_token: str = ""
    public_base_url: str = "http://localhost:8000"
    allow_live_delivery: bool = False
    dispatch_mock: bool = False
    worker_lease_seconds: int = 30
    worker_max_attempts: int = 3
    history_retention_days: int = 30
    max_body_bytes: int = 65536

    @classmethod
    def from_env(cls):
        load_dotenv()
        names = {
            "mongodb_url": "MONGODB_URL",
            "mongodb_db_name": "MONGODB_DB_NAME",
            "secret": "OTPIGEON_SECRET",
            "enable_legacy": "OTPIGEON_ENABLE_LEGACY",
            "legacy_admin_token": "OTPIGEON_LEGACY_ADMIN_TOKEN",
        }
        values = {}
        for field in fields(cls):
            raw = os.getenv(names.get(field.name, "OTPIGEON_" + field.name.upper()))
            if raw is not None:
                if field.type is bool and raw.lower() not in ("true", "false"):
                    raise ValueError(f"Invalid boolean setting: {field.name}")
                values[field.name] = (
                    raw.lower() == "true" if field.type is bool else int(raw) if field.type is int else raw
                )
        return cls(**values)

    def validate(self):
        if len(self.secret) < 32 or self.secret.lower().startswith(("change", "placeholder", "replace")):
            raise ValueError("OTPIGEON_SECRET must be a generated secret of at least 32 characters")
        for name in (
            "expiry_seconds",
            "cooldown_seconds",
            "max_attempts",
            "max_resends",
            "destination_sends_per_hour",
            "destination_guesses_per_hour",
            "project_sends_per_hour",
        ):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be positive")
        if self.enable_legacy and (len(self.legacy_admin_token) < 32 or self.legacy_admin_token == self.secret):
            raise ValueError("Legacy routes require a separate admin token of at least 32 characters")
        if self.admin_token and (len(self.admin_token) < 32 or self.admin_token == self.secret):
            raise ValueError("OTPIGEON_ADMIN_TOKEN must be a separate secret of at least 32 characters")
        from urllib.parse import urlsplit

        origin = urlsplit(self.public_base_url)
        if (
            origin.scheme not in ("http", "https")
            or not origin.netloc
            or origin.username
            or origin.password
            or origin.query
            or origin.fragment
            or origin.path not in ("", "/")
        ):
            raise ValueError("OTPIGEON_PUBLIC_BASE_URL must be an HTTP(S) origin")
        if self.allow_live_delivery and origin.scheme != "https":
            raise ValueError("Live delivery requires an HTTPS OTPIGEON_PUBLIC_BASE_URL")
        if (
            self.worker_lease_seconds < 5
            or self.worker_max_attempts < 1
            or self.history_retention_days < 1
            or self.max_body_bytes < 1024
        ):
            raise ValueError("Worker, retention, and request limits are invalid")

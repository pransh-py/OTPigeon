import hashlib
import hmac
import json
import math
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from .providers import MockDelivery
from .crypto import Vault
from .management import ProjectManagement


def utcnow():
    return datetime.now(timezone.utc)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def identifier(*parts):
    return digest(json.dumps(parts, separators=(",", ":")))


def error(code, status=409, retry_after=None):
    body = {"error": {"code": code, "message": code.replace("_", " ")}}
    if retry_after is not None:
        body["error"]["retry_after"] = retry_after
    return status, body


class GatewayService(ProjectManagement):
    def __init__(self, database, config, *, provider=None, clock=utcnow):
        self.db, self.config = database, config
        self.provider = provider or MockDelivery()
        self.vault = Vault(config.secret)

        # BSON dates have millisecond precision; responses and persistence must
        # share that precision, including injected clocks and idempotent replays.
        def database_clock():
            value = clock()
            return value.replace(microsecond=(value.microsecond // 1000) * 1000)

        self.clock = database_clock

    async def initialize(self):
        hello = await self.db.client.admin.command("hello")
        if not hello.get("setName"):
            raise RuntimeError("OTPigeon requires a MongoDB replica set for transactional guarantees")
        await self.db.api_keys.create_index("digest", unique=True)
        await self.db.challenges.create_index("scope_id", unique=True, partialFilterExpression={"status": "pending"})
        await self.db.challenges.create_index([("project_id", 1), ("environment", 1)])
        await self.db.events.create_index([("project_id", 1), ("environment", 1), ("sequence", 1)], unique=True)
        await self.db.idempotency.create_index("expires_at", expireAfterSeconds=0)
        # TTL cleanup is eventual; outbox reads independently enforce exact expiry.
        await self.db.outbox.create_index("expires_at", expireAfterSeconds=0)
        await self.db.jobs.create_index([("state", 1), ("available_at", 1)])
        await self.db.jobs.create_index([("state", 1), ("lease_until", 1)])
        await self.db.challenges.create_index([("status", 1), ("expires_at", 1)])
        await self.db.challenges.create_index([("project_id", 1), ("environment", 1), ("created_at", -1), ("_id", -1)])
        await self.db.worker_heartbeats.create_index("seen_at", expireAfterSeconds=86400)
        await self.db.jobs.create_index([("project_id", 1), ("message_id", 1)])
        await self.db.login_limits.create_index("expires_at", expireAfterSeconds=0)
        await self.db.operator_sessions.create_index("expires_at", expireAfterSeconds=0)

    async def create_project(self, name):
        if not name.strip() or len(name) > 120:
            raise ValueError("Project name must contain 1–120 characters")
        document = {
            "_id": uuid4().hex,
            "name": name.strip(),
            "created_at": self.clock(),
            "environments": {"test": {"provider": "mock"}, "live": {"provider": None}},
        }
        await self.db.projects.insert_one(document)
        return {"project_id": document["_id"], "name": document["name"]}

    async def issue_key(self, project_id, environment):
        if environment not in ("test", "live"):
            raise ValueError("Environment must be test or live")
        if not await self.db.projects.find_one({"_id": project_id}):
            raise ValueError("Project not found")
        key = f"otpg_{environment}_" + secrets.token_urlsafe(32)
        document = {
            "_id": uuid4().hex,
            "digest": digest(key),
            "prefix": key[:18],
            "project_id": project_id,
            "environment": environment,
            "created_at": self.clock(),
            "revoked_at": None,
        }
        await self.db.api_keys.insert_one(document)
        return {"key_id": document["_id"], "api_key": key, "environment": environment}

    async def list_keys(self, project_id):
        documents = await self.db.api_keys.find(
            {"project_id": project_id, "internal": {"$ne": True}}, {"digest": 0}
        ).to_list(None)
        return [
            {
                "key_id": d["_id"],
                "prefix": d["prefix"],
                "environment": d["environment"],
                "created_at": d["created_at"].isoformat(),
                "revoked_at": d["revoked_at"].isoformat() if d["revoked_at"] else None,
            }
            for d in documents
        ]

    async def revoke_key(self, key_id):
        key = await self.db.api_keys.find_one({"_id": key_id})
        if not key:
            return False
        gate_id = identifier(key["project_id"], key["environment"])
        await self._ensure_gate(gate_id)

        async def revoke(session):
            await self.db.gates.update_one({"_id": gate_id}, {"$inc": {"revision": 1}}, session=session)
            result = await self.db.api_keys.update_one(
                {"_id": key_id, "revoked_at": None}, {"$set": {"revoked_at": self.clock()}}, session=session
            )
            return bool(result.matched_count)

        return await self._transaction(revoke)

    async def authenticate(self, key):
        return await self.db.api_keys.find_one({"digest": digest(key), "revoked_at": None}) if key else None

    async def _ensure_gate(self, gate_id):
        try:
            await self.db.gates.update_one(
                {"_id": gate_id}, {"$setOnInsert": {"revision": 0, "event_sequence": 0}}, upsert=True
            )
        except DuplicateKeyError:
            # Concurrent first requests may race to create the same gate.
            pass

    async def _transaction(self, callback):
        async with self.db.client.start_session() as session:
            return await session.with_transaction(
                callback, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority")
            )

    async def execute(self, actor, operation, *, challenge_id=None, body=None, idempotency_key=None):
        gate_id = identifier(actor["project_id"], actor["environment"])
        await self._ensure_gate(gate_id)

        async def transact(session):
            # This write makes every operation in one project/environment conflict
            # and retry across processes, preventing write skew in budgets and scopes.
            await self.db.gates.update_one({"_id": gate_id}, {"$inc": {"revision": 1}}, session=session)
            fresh_key = await self.db.api_keys.find_one({"_id": actor["_id"], "revoked_at": None}, session=session)
            if not fresh_key:
                return error("invalid_api_key", 401)
            now = self.clock()
            idem_id = identifier(gate_id, operation, challenge_id or "", idempotency_key) if idempotency_key else None
            body_hash = digest(json.dumps(body or {}, sort_keys=True, separators=(",", ":")))
            if idem_id:
                previous = await self.db.idempotency.find_one({"_id": idem_id}, session=session)
                if previous and previous["expires_at"] > now:
                    return (
                        (previous["http_status"], previous["response"])
                        if previous["body_hash"] == body_hash
                        else error("idempotency_conflict")
                    )
                if previous:
                    await self.db.idempotency.delete_one({"_id": idem_id}, session=session)
            challenge = None
            if challenge_id:
                challenge = await self.db.challenges.find_one(
                    {"_id": challenge_id, "project_id": actor["project_id"], "environment": actor["environment"]},
                    session=session,
                )
                if not challenge:
                    return error("challenge_not_found", 404)
                await self._expire(actor, challenge, now, session)
            if operation == "create":
                result = await self._create(actor, body, now, session)
            elif operation == "get":
                result = 200, self.response(challenge)
            elif operation == "resend":
                result = await self._resend(actor, challenge, now, session)
            elif operation == "verify":
                result = await self._verify(actor, challenge, body["code"], now, session)
            elif operation == "record_delivery":
                result = await self._record_delivery(actor, challenge, body, now, session)
            elif operation == "outbox":
                entry = await self.db.outbox.find_one(
                    {"_id": challenge_id, "expires_at": {"$gt": now}}, session=session
                )
                result = (
                    (
                        200,
                        {"challenge_id": challenge_id, "environment": "test", "simulated": True, "code": entry["code"]},
                    )
                    if entry and challenge["status"] == "pending"
                    else error("test_code_unavailable", 404)
                )
            else:
                raise ValueError("Unknown operation")
            if idem_id:
                await self.db.idempotency.insert_one(
                    {
                        "_id": idem_id,
                        "body_hash": body_hash,
                        "http_status": result[0],
                        "response": result[1],
                        "created_at": now,
                        "expires_at": now + timedelta(hours=24),
                    },
                    session=session,
                )
            return result

        return await self._transaction(transact)

    def code_hash(self, challenge, code):
        message = json.dumps([challenge["_id"], challenge["generation"], code], separators=(",", ":"))
        return hmac.new(self.config.secret.encode(), message.encode(), hashlib.sha256).hexdigest()

    def response(self, challenge):
        return {
            "challenge_id": challenge["_id"],
            "project_id": challenge["project_id"],
            "environment": challenge["environment"],
            "purpose": challenge["purpose"],
            "destination": challenge["destination"],
            "status": challenge["status"],
            "delivery": challenge["delivery"],
            "created_at": challenge["created_at"].isoformat(),
            "expires_at": challenge["expires_at"].isoformat(),
            "resend_available_at": challenge["resend_available_at"].isoformat(),
            "attempts_remaining": max(0, self.config.max_attempts - challenge["attempts"]),
        }

    async def _event(self, actor, challenge, kind, reason, now, session, *, destination=None):
        sequence = await self.db.gates.find_one_and_update(
            {"_id": identifier(actor["project_id"], actor["environment"])},
            {"$inc": {"event_sequence": 1}},
            return_document=ReturnDocument.AFTER,
            session=session,
        )
        destination = destination or (challenge["destination"] if challenge else "")
        await self.db.events.insert_one(
            {
                "_id": uuid4().hex,
                "project_id": actor["project_id"],
                "environment": actor["environment"],
                "sequence": sequence["event_sequence"],
                "timestamp": now,
                "challenge_id": challenge["_id"] if challenge else None,
                "generation": challenge.get("generation") if challenge else None,
                "type": kind,
                "reason": reason,
                "purpose": challenge["purpose"] if challenge else None,
                "provider": challenge.get("delivery", {}).get("provider")
                if challenge
                else ("mock" if actor["environment"] == "test" else None),
                "simulated": actor["environment"] == "test",
                "destination": "***" + destination[-4:],
            },
            session=session,
        )

    async def _terminal(self, actor, challenge, status, now, session):
        if challenge["status"] != "pending":
            return
        challenge["status"] = status
        challenge["updated_at"] = now
        await self.db.challenges.replace_one({"_id": challenge["_id"]}, challenge, session=session)
        await self.db.outbox.delete_one({"_id": challenge["_id"]}, session=session)
        await self.db.jobs.update_many(
            {"challenge_id": challenge["_id"], "state": {"$in": ["queued", "leased"]}},
            {"$set": {"state": "canceled", "reason": status}, "$unset": {"payload": ""}},
            session=session,
        )
        await self._event(actor, challenge, status, status, now, session)

    async def _expire(self, actor, challenge, now, session):
        if challenge["status"] == "pending" and now >= challenge["expires_at"]:
            await self._terminal(actor, challenge, "expired", now, session)

    async def _budget(self, actor, destination, now, session):
        scope = identifier(actor["project_id"], actor["environment"])
        dest_id = identifier(scope, destination)
        project = await self.db.budgets.find_one({"_id": scope}, session=session) or {"_id": scope, "sends": []}
        dest = await self.db.budgets.find_one({"_id": dest_id}, session=session) or {
            "_id": dest_id,
            "sends": [],
            "guesses": [],
        }
        cutoff = now - timedelta(hours=1)
        project["sends"] = [t for t in project["sends"] if t > cutoff]
        for field in ("sends", "guesses"):
            dest[field] = [t for t in dest[field] if t > cutoff]
        return project, dest

    async def _send_limit(self, actor, destination, challenge, now, session):
        project, dest = await self._budget(actor, destination, now, session)
        for timestamps, maximum, code in (
            (dest["sends"], self.config.destination_sends_per_hour, "destination_send_limit"),
            (project["sends"], self.config.project_sends_per_hour, "project_send_limit"),
        ):
            if len(timestamps) >= maximum:
                await self._event(actor, challenge, "rate_limited", code, now, session, destination=destination)
                return error(code, 429, max(1, math.ceil((min(timestamps) + timedelta(hours=1) - now).total_seconds())))
        project["sends"].append(now)
        dest["sends"].append(now)
        await self.db.budgets.replace_one({"_id": project["_id"]}, project, upsert=True, session=session)
        await self.db.budgets.replace_one({"_id": dest["_id"]}, dest, upsert=True, session=session)
        return None

    async def _deliver(self, actor, challenge, code, now, session):
        if actor["environment"] == "live" or self.config.dispatch_mock:
            project = await self.db.projects.find_one({"_id": actor["project_id"]}, session=session)
            selected = project["environments"][actor["environment"]]
            config = self.vault.decrypt(selected["sealed"]) if actor["environment"] == "live" else {"provider": "mock"}
            provider = config["provider"]
            job_id = identifier(challenge["_id"], challenge["generation"])
            challenge["delivery"] = {
                "status": "queued",
                "provider": provider,
                "simulated": actor["environment"] == "test",
                "reason": None,
            }
            await self.db.challenges.replace_one({"_id": challenge["_id"]}, challenge, session=session)
            await self.db.jobs.insert_one(
                {
                    "_id": job_id,
                    "project_id": actor["project_id"],
                    "environment": actor["environment"],
                    "key_id": actor["_id"],
                    "provider": provider,
                    "provider_revision": selected.get("revision"),
                    "challenge_id": challenge["_id"],
                    "generation": challenge["generation"],
                    "state": "queued",
                    "attempts": 0,
                    "created_at": now,
                    "expires_at": challenge["expires_at"],
                    "available_at": now,
                    "provider_snapshot": self.vault.encrypt(config),
                    "payload": self.vault.encrypt({"code": code}),
                    "message_id": None,
                },
                session=session,
            )
            await self._event(actor, challenge, "queued", "delivery_queued", now, session)
            return
        prepared = self.provider.prepare()
        if prepared.status not in ("provider_accepted", "provider_failed", "unknown"):
            raise ValueError("Invalid delivery outcome")
        # Expose only bounded reasons, never an adapter exception or credentials.
        reasons = {None, "provider_rejected", "provider_timeout"}
        reason = prepared.reason if prepared.reason in reasons else "provider_rejected"
        challenge["delivery"] = {"status": prepared.status, "provider": "mock", "simulated": True, "reason": reason}
        await self.db.challenges.replace_one({"_id": challenge["_id"]}, challenge, session=session)
        if prepared.status != "provider_failed":
            await self.db.outbox.replace_one(
                {"_id": challenge["_id"]},
                {
                    "_id": challenge["_id"],
                    "code": code,
                    "generation": challenge["generation"],
                    "expires_at": challenge["expires_at"],
                },
                upsert=True,
                session=session,
            )
        else:
            await self.db.outbox.delete_one({"_id": challenge["_id"]}, session=session)
        kind = "provider_unknown" if prepared.status == "unknown" else prepared.status
        await self._event(actor, challenge, kind, reason, now, session)

    async def _create(self, actor, body, now, session):
        if actor["environment"] == "live" and not self.config.allow_live_delivery:
            return error("live_delivery_disabled", 503)
        project = await self.db.projects.find_one({"_id": actor["project_id"]}, session=session)
        if not project["environments"][actor["environment"]]["provider"]:
            return error("provider_not_configured", 503)
        scope_id = identifier(actor["project_id"], actor["environment"], body["destination"], body["purpose"])
        previous = await self.db.challenges.find_one({"scope_id": scope_id, "status": "pending"}, session=session)
        if previous:
            await self._expire(actor, previous, now, session)
            if previous["status"] == "pending" and now < previous["resend_available_at"]:
                await self._event(actor, previous, "rate_limited", "cooldown", now, session)
                return error("cooldown", 429, math.ceil((previous["resend_available_at"] - now).total_seconds()))
        limited = await self._send_limit(actor, body["destination"], previous, now, session)
        if limited:
            return limited
        if previous and previous["status"] == "pending":
            await self._terminal(actor, previous, "superseded", now, session)
        challenge = {
            "_id": uuid4().hex,
            "project_id": actor["project_id"],
            "environment": actor["environment"],
            **body,
            "scope_id": scope_id,
            "generation": uuid4().hex,
            "status": "pending",
            "attempts": 0,
            "resends": 0,
            "expires_at": now + timedelta(seconds=self.config.expiry_seconds),
            "resend_available_at": now + timedelta(seconds=self.config.cooldown_seconds),
            "created_at": now,
            "updated_at": now,
            "delivery": {"status": "not_attempted", "provider": "mock", "simulated": True, "reason": None},
        }
        code = f"{secrets.randbelow(1_000_000):06d}"
        challenge["otp_hash"] = self.code_hash(challenge, code)
        await self.db.challenges.insert_one(challenge, session=session)
        await self._event(actor, challenge, "requested", "create", now, session)
        await self._deliver(actor, challenge, code, now, session)
        return 201, self.response(challenge)

    async def _resend(self, actor, challenge, now, session):
        if actor["environment"] == "live" and not self.config.allow_live_delivery:
            return error("live_delivery_disabled", 503)
        if challenge["status"] != "pending":
            return error("challenge_" + challenge["status"])
        if now < challenge["resend_available_at"]:
            await self._event(actor, challenge, "rate_limited", "cooldown", now, session)
            return error("cooldown", 429, math.ceil((challenge["resend_available_at"] - now).total_seconds()))
        if challenge["resends"] >= self.config.max_resends:
            return error("resend_limit")
        limited = await self._send_limit(actor, challenge["destination"], challenge, now, session)
        if limited:
            return limited
        while True:
            code = f"{secrets.randbelow(1_000_000):06d}"
            if not hmac.compare_digest(self.code_hash(challenge, code), challenge["otp_hash"]):
                break
        challenge["generation"] = uuid4().hex
        await self.db.jobs.update_many(
            {"challenge_id": challenge["_id"], "state": {"$in": ["queued", "leased"]}},
            {"$set": {"state": "canceled", "reason": "superseded_generation"}, "$unset": {"payload": ""}},
            session=session,
        )
        challenge["otp_hash"] = self.code_hash(challenge, code)
        challenge["resends"] += 1
        challenge["resend_available_at"] = now + timedelta(seconds=self.config.cooldown_seconds)
        challenge["updated_at"] = now
        await self._event(actor, challenge, "requested", "resend", now, session)
        await self._deliver(actor, challenge, code, now, session)
        return 200, self.response(challenge)

    async def _verify(self, actor, challenge, code, now, session):
        if challenge["status"] != "pending":
            return 200, {
                **self.response(challenge),
                "verified": False,
                "reason": "already_verified" if challenge["status"] == "verified" else challenge["status"],
            }
        project, dest = await self._budget(actor, challenge["destination"], now, session)
        if len(dest["guesses"]) >= self.config.destination_guesses_per_hour:
            await self._event(actor, challenge, "rate_limited", "destination_verify_limit", now, session)
            return error(
                "destination_verify_limit",
                429,
                max(1, math.ceil((min(dest["guesses"]) + timedelta(hours=1) - now).total_seconds())),
            )
        if hmac.compare_digest(self.code_hash(challenge, code), challenge["otp_hash"]):
            await self._terminal(actor, challenge, "verified", now, session)
            return 200, {**self.response(challenge), "verified": True, "reason": "verified"}
        challenge["attempts"] += 1
        dest["guesses"].append(now)
        await self.db.budgets.replace_one({"_id": dest["_id"]}, dest, upsert=True, session=session)
        await self._event(actor, challenge, "verify_failed", "invalid_code", now, session)
        if challenge["attempts"] >= self.config.max_attempts:
            await self._terminal(actor, challenge, "locked", now, session)
        else:
            await self.db.challenges.replace_one({"_id": challenge["_id"]}, challenge, session=session)
        return 200, {
            **self.response(challenge),
            "verified": False,
            "reason": "locked" if challenge["status"] == "locked" else "invalid_code",
        }

    async def _record_delivery(self, actor, challenge, body, now, session):
        """Internal receipt boundary; no HTTP endpoint exposes it in M1."""
        if body["generation"] != challenge["generation"]:
            return error("stale_delivery_generation")
        status = body["status"]
        if status not in ("provider_accepted", "provider_failed", "unknown"):
            return error("invalid_delivery_status", 400)
        if challenge["delivery"]["status"] == status:
            return 200, self.response(challenge)
        if challenge["delivery"]["status"] not in ("unknown", "not_attempted"):
            return error("delivery_already_final")
        challenge["delivery"]["status"] = status
        challenge["delivery"]["reason"] = None
        # Use the fresh record inside the serialized transaction. A delayed result
        # updates delivery only, never restores a terminal verification state.
        await self.db.challenges.update_one(
            {"_id": challenge["_id"]}, {"$set": {"delivery": challenge["delivery"]}}, session=session
        )
        await self._event(actor, challenge, "provider_unknown" if status == "unknown" else status, None, now, session)
        return 200, self.response(challenge)

    async def events(self, actor, *, challenge_id=None, kind=None, after=0, limit=50):
        if challenge_id:
            status, body = await self.execute(actor, "get", challenge_id=challenge_id)
            if status != 200:
                return status, body
        query = {"project_id": actor["project_id"], "environment": actor["environment"], "sequence": {"$gt": after}}
        if challenge_id:
            query["challenge_id"] = challenge_id
        if kind:
            query["type"] = kind
        documents = await self.db.events.find(query).sort("sequence", 1).limit(limit + 1).to_list(None)
        more = len(documents) > limit
        items = []
        for doc in documents[:limit]:
            doc["event_id"] = doc.pop("_id")
            doc["timestamp"] = doc["timestamp"].isoformat()
            items.append(doc)
        return 200, {"items": items, "next_cursor": items[-1]["sequence"] if more else None}

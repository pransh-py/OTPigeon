"""Lease-based dispatch. Ambiguous sends are never automatically re-sent."""

import asyncio
import socket
from datetime import timedelta
from uuid import uuid4

import httpx
from pymongo import AsyncMongoClient, ReturnDocument

from otpigeon.gateway.adapters import Outcome, send
from otpigeon.gateway.config import GatewaySettings
from otpigeon.gateway.service import GatewayService, identifier


class Worker:
    def __init__(self, service, *, client=None):
        self.service, self.client = service, client
        self.worker_id = uuid4().hex
        self.last_heartbeat = None

    async def claim(self):
        s, now = self.service, self.service.clock()
        ready = {
            "$or": [
                {"state": "queued", "available_at": {"$lte": now}},
                {"state": "leased", "lease_until": {"$lte": now}},
            ]
        }
        if not s.config.allow_live_delivery:
            ready["provider"] = "mock"
        return await s.db.jobs.find_one_and_update(
            ready,
            {
                "$set": {
                    "state": "leased",
                    "lease_token": uuid4().hex,
                    "worker_id": self.worker_id,
                    "lease_until": now + timedelta(seconds=s.config.worker_lease_seconds),
                }
            },
            sort=[("available_at", 1)],
            return_document=ReturnDocument.AFTER,
        )

    async def begin(self, job):
        s = self.service
        gate_id = identifier(job["project_id"], job["environment"])
        await s._ensure_gate(gate_id)

        async def transaction(session):
            now = s.clock()
            await s.db.gates.update_one({"_id": gate_id}, {"$inc": {"revision": 1}}, session=session)
            current = await s.db.jobs.find_one(
                {"_id": job["_id"], "state": "leased", "lease_token": job["lease_token"], "lease_until": {"$gt": now}},
                session=session,
            )
            if not current:
                return False
            actor = self.actor(current)
            challenge = await s.db.challenges.find_one({"_id": current["challenge_id"]}, session=session)
            if challenge:
                await s._expire(actor, challenge, now, session)
            project = await s.db.projects.find_one({"_id": current["project_id"]}, session=session)
            selected = project["environments"][current["environment"]] if project else {}
            valid_key = await s.db.api_keys.find_one({"_id": current["key_id"], "revoked_at": None}, session=session)
            valid_provider = selected.get("revision") == current.get("provider_revision")
            enabled = current["environment"] == "test" or s.config.allow_live_delivery
            if (
                not valid_key
                or not valid_provider
                or not enabled
                or not challenge
                or challenge["status"] != "pending"
                or challenge["generation"] != current["generation"]
            ):
                await s.db.jobs.update_one(
                    {"_id": current["_id"]},
                    {"$set": {"state": "canceled", "reason": "dispatch_invalidated"}, "$unset": {"payload": ""}},
                    session=session,
                )
                if challenge and challenge["generation"] == current["generation"] and challenge["status"] == "pending":
                    challenge["delivery"].update(status="provider_failed", reason="dispatch_invalidated")
                    await s.db.challenges.update_one(
                        {"_id": challenge["_id"]}, {"$set": {"delivery": challenge["delivery"]}}, session=session
                    )
                    await s._event(actor, challenge, "provider_failed", "dispatch_invalidated", now, session)
                return False
            await s.db.jobs.update_one(
                {"_id": current["_id"]},
                {"$set": {"state": "sending", "started_at": now}, "$inc": {"attempts": 1}},
                session=session,
            )
            challenge["delivery"].update(status="sending", reason=None)
            await s.db.challenges.update_one(
                {"_id": challenge["_id"]}, {"$set": {"delivery": challenge["delivery"]}}, session=session
            )
            await s._event(actor, challenge, "dispatch_started", None, now, session)
            return True

        return await s._transaction(transaction)

    @staticmethod
    def actor(job):
        return {"_id": job["key_id"], "project_id": job["project_id"], "environment": job["environment"]}

    async def finish(self, job, outcome, *, code=None):
        s = self.service
        gate_id = identifier(job["project_id"], job["environment"])
        await s._ensure_gate(gate_id)

        async def transaction(session):
            now = s.clock()
            await s.db.gates.update_one({"_id": gate_id}, {"$inc": {"revision": 1}}, session=session)
            current = await s.db.jobs.find_one(
                {
                    "_id": job["_id"],
                    "lease_token": job["lease_token"],
                    "state": {"$in": ["sending", "unknown", "completed"]},
                },
                session=session,
            )
            if not current or (current.get("result") and current["result"] != "unknown"):
                return False
            if current.get("result") == "unknown" and outcome.status == "unknown":
                return False
            challenge = await s.db.challenges.find_one({"_id": current["challenge_id"]}, session=session)
            actor = self.actor(current)
            if challenge:
                await s._expire(actor, challenge, now, session)
            if not challenge:
                await s.db.jobs.update_one(
                    {"_id": current["_id"]},
                    {"$set": {"state": "canceled", "reason": "challenge_removed"}, "$unset": {"payload": ""}},
                    session=session,
                )
                return False
            same_generation = challenge["generation"] == current["generation"]
            status, reason = outcome.status, outcome.reason
            can_retry = (
                status == "retry"
                and current["state"] == "sending"
                and "payload" in current
                and not current.get("receipt_status")
                and current["attempts"] < s.config.worker_max_attempts
                and same_generation
                and challenge["status"] == "pending"
                and now + timedelta(seconds=outcome.retry_after) < current["expires_at"]
            )
            if can_retry:
                await s.db.jobs.update_one(
                    {"_id": current["_id"]},
                    {
                        "$set": {
                            "state": "queued",
                            "available_at": now + timedelta(seconds=outcome.retry_after),
                            "reason": reason,
                        }
                    },
                    session=session,
                )
                challenge["delivery"].update(status="queued", reason=reason)
                await s.db.challenges.update_one(
                    {"_id": challenge["_id"]}, {"$set": {"delivery": challenge["delivery"]}}, session=session
                )
                await s._event(actor, challenge, "retry_scheduled", reason, now, session)
                return True
            if status == "retry":
                status, reason = "provider_failed", "retry_exhausted"
            if current.get("receipt_status"):
                status, reason = current["receipt_status"], "confirmed_receipt"
            message_id = current.get("message_id") or outcome.message_id
            await s.db.jobs.update_one(
                {"_id": current["_id"]},
                {
                    "$set": {
                        "state": "unknown" if status == "unknown" else "completed",
                        "result": status,
                        "reason": reason,
                        "message_id": message_id,
                        "completed_at": now,
                    },
                    "$unset": {"payload": ""},
                },
                session=session,
            )
            if same_generation and challenge["delivery"]["status"] != "delivered" and not current.get("receipt_status"):
                challenge["delivery"].update(status=status, reason=reason)
                await s.db.challenges.update_one(
                    {"_id": challenge["_id"]}, {"$set": {"delivery": challenge["delivery"]}}, session=session
                )
            if (
                current["environment"] == "test"
                and code
                and same_generation
                and challenge["status"] == "pending"
                and status == "provider_accepted"
            ):
                await s.db.outbox.replace_one(
                    {"_id": challenge["_id"]},
                    {
                        "_id": challenge["_id"],
                        "code": code,
                        "generation": current["generation"],
                        "expires_at": challenge["expires_at"],
                    },
                    upsert=True,
                    session=session,
                )
            event_challenge = {
                **challenge,
                "generation": current["generation"],
                "delivery": {**challenge["delivery"], "provider": current["provider"]},
            }
            if not current.get("receipt_status"):
                await s._event(
                    actor, event_challenge, "provider_unknown" if status == "unknown" else status, reason, now, session
                )
            return True

        return await s._transaction(transaction)

    async def reap(self):
        s, now = self.service, self.service.clock()
        expired = await s.db.challenges.find({"status": "pending", "expires_at": {"$lte": now}}).limit(25).to_list(None)
        for challenge in expired:
            gate = identifier(challenge["project_id"], challenge["environment"])
            await s._ensure_gate(gate)

            async def expire(session):
                await s.db.gates.update_one({"_id": gate}, {"$inc": {"revision": 1}}, session=session)
                current = await s.db.challenges.find_one({"_id": challenge["_id"]}, session=session)
                if current:
                    await s._expire(challenge, current, s.clock(), session)

            await s._transaction(expire)
        abandoned = await s.db.jobs.find({"state": "sending", "lease_until": {"$lte": now}}).limit(25).to_list(None)
        for job in abandoned:
            await self.finish(job, Outcome("unknown", "worker_lost_after_dispatch"))

    async def run_once(self):
        s = self.service
        if self.last_heartbeat is None or (s.clock() - self.last_heartbeat).total_seconds() >= 5:
            await s.db.worker_heartbeats.update_one(
                {"_id": self.worker_id}, {"$set": {"seen_at": s.clock(), "hostname": socket.gethostname()}}, upsert=True
            )
            self.last_heartbeat = s.clock()
        await self.reap()
        job = await self.claim()
        if not job:
            return False
        if not await self.begin(job):
            return True
        challenge = await s.db.challenges.find_one({"_id": job["challenge_id"]})
        config = s.vault.decrypt(job["provider_snapshot"])
        code = s.vault.decrypt(job["payload"])["code"]
        remaining = max(0.1, (challenge["expires_at"] - s.clock()).total_seconds())
        timeout = max(0.1, min(15, s.config.worker_lease_seconds - 2, remaining))
        try:
            async with asyncio.timeout(timeout):
                if self.client:
                    result = await send(
                        self.client, config, job, challenge, code, s.config.public_base_url, timeout, remaining
                    )
                else:
                    async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as client:
                        result = await send(
                            client, config, job, challenge, code, s.config.public_base_url, timeout, remaining
                        )
        except TimeoutError:
            result = Outcome("unknown", "provider_timeout")
        await self.finish(job, result, code=code)
        return True


async def run_worker(*, once=False):
    config = GatewaySettings.from_env()
    config.validate()
    async with AsyncMongoClient(config.mongodb_url, tz_aware=True, serverSelectionTimeoutMS=5000) as client:
        service = GatewayService(client[config.mongodb_db_name], config)
        await service.initialize()
        worker = Worker(service)
        while True:
            worked = await worker.run_once()
            if once:
                return
            if not worked:
                await asyncio.sleep(0.25)


if __name__ == "__main__":
    try:
        asyncio.run(run_worker())
    except KeyboardInterrupt:
        pass

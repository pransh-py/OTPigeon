"""Real process death at dispatch boundaries; no accounts or external messages."""

import asyncio
import os
import sys

import httpx
import pytest

from test_release import live_challenge
from otpigeon.worker import Worker

CHILD = r"""
import asyncio, os, sys
from pymongo import AsyncMongoClient
from otpigeon.gateway.config import GatewaySettings
from otpigeon.gateway.service import GatewayService
from otpigeon.worker import Worker
import httpx
async def run():
    config = GatewaySettings.from_env()
    async with AsyncMongoClient(config.mongodb_url, tz_aware=True) as client:
        service = GatewayService(client[config.mongodb_db_name], config)
        worker = Worker(service)
        if sys.argv[1] == 'lease':
            job = await worker.claim()
            await service.db.probe_state.insert_one({'_id': 'ready', 'job_id': job['_id']})
            await asyncio.sleep(60)
        else:
            async def accept(request):
                await service.db.provider_calls.insert_one({'accepted': True})
                await service.db.probe_state.insert_one({'_id': 'ready'})
                await asyncio.sleep(60)
            async with httpx.AsyncClient(transport=httpx.MockTransport(accept)) as transport:
                await Worker(service, client=transport).run_once()
asyncio.run(run())
"""


@pytest.mark.parametrize("boundary", ["lease", "sending"])
async def test_killed_worker_recovers_safely(gateway, boundary):
    challenge, _ = await live_challenge(gateway)
    service, clock = gateway[1], gateway[3]
    env = {
        **os.environ,
        "MONGODB_URL": service.config.mongodb_url,
        "MONGODB_DB_NAME": service.config.mongodb_db_name,
        "OTPIGEON_SECRET": service.config.secret,
        "OTPIGEON_PUBLIC_BASE_URL": "https://otpigeon.test",
        "OTPIGEON_ALLOW_LIVE_DELIVERY": "true",
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        CHILD,
        boundary,
        env=env,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        for _ in range(100):
            if await service.db.probe_state.find_one({"_id": "ready"}):
                break
            if process.returncode is not None:
                raise AssertionError("Child failed before the dispatch boundary")
            await asyncio.sleep(0.05)
        else:
            raise AssertionError("Worker did not reach the dispatch boundary")
        process.kill()
        await process.wait()
        clock.advance(31)

        async def accepted(request):
            await service.db.provider_calls.insert_one({"accepted": True})
            return httpx.Response(201, json={"sid": "SMfixture"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(accepted)) as client:
            survivor = Worker(service, client=client)
            await survivor.run_once()
            await survivor.run_once()
        job = await service.db.jobs.find_one({"challenge_id": challenge["challenge_id"]})
        assert await service.db.provider_calls.count_documents({}) == 1
        assert job["state"] == ("completed" if boundary == "lease" else "unknown")
        assert "payload" not in job
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_retry_policy_and_revocation(gateway):
    challenge, headers = await live_challenge(gateway)
    service, clock = gateway[1], gateway[3]
    attempts = []

    async def limited(request):
        attempts.append(1)
        return httpx.Response(429, headers={"Retry-After": "2"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(limited)) as client:
        worker = Worker(service, client=client)
        for _ in range(3):
            assert await worker.run_once()
            clock.advance(3)
        assert not await worker.run_once()
    job = await service.db.jobs.find_one({"challenge_id": challenge["challenge_id"]})
    assert len(attempts) == 3 and job["reason"] == "retry_exhausted" and "payload" not in job


@pytest.mark.parametrize("invalidate", ["key", "provider"])
async def test_revoked_key_and_rotated_config_cancel_before_dispatch(gateway, invalidate):
    challenge, headers = await live_challenge(gateway)
    service = gateway[1]
    worker = Worker(service)
    job = await worker.claim()
    key = await service.authenticate(headers["Authorization"].split(" ")[1])
    if invalidate == "key":
        assert await service.revoke_key(key["_id"])
    else:
        from test_release import TWILIO

        await service.configure_provider(
            challenge["project_id"], "live", {**TWILIO, "auth_token": "rotated-fictional-token"}
        )
    assert not await worker.begin(job)
    assert (await service.db.jobs.find_one({"_id": job["_id"]}))["state"] == "canceled"


async def test_retention_preview_preserves_pending_and_inflight(gateway):
    from conftest import create, outbox
    from otpigeon.maintenance import prune

    app, service, http, clock, project, key, config = gateway
    response = await create(http)
    cid = response.json()["challenge_id"]
    code = await outbox(http, cid)
    assert (await http.post(f"/v1/challenges/{cid}/verify", json={"code": code})).json()["verified"]
    clock.advance(32 * 86400)
    assert (await prune(service))["eligible_challenges"] == 1
    assert await service.db.challenges.count_documents({}) == 1
    assert (await prune(service, apply=True))["eligible_challenges"] == 1
    assert await service.db.challenges.count_documents({}) == 0

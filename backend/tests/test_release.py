import asyncio
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest


TWILIO = {
    "provider": "twilio_sms",
    "account_sid": "AC" + "a" * 32,
    "auth_token": "fixture-auth-token-" + "b" * 32,
    "from_number": "+12025550100",
}
META = {
    "provider": "meta_whatsapp",
    "phone_number_id": "1234567890",
    "api_version": "v23.0",
    "access_token": "fixture-access-" + "c" * 40,
    "app_secret": "fixture-app-" + "d" * 32,
    "verify_token": "fixture-verify-" + "e" * 32,
    "template_name": "login_code",
    "language": "en_US",
}


async def live_challenge(gateway, provider=TWILIO):
    app, service, http, clock, project, issued, config = gateway
    service.config = replace(config, allow_live_delivery=True, public_base_url="https://otpigeon.test")
    await service.configure_provider(project["project_id"], "live", provider)
    key = await service.issue_key(project["project_id"], "live")
    headers = {"Authorization": "Bearer " + key["api_key"], "Idempotency-Key": uuid4().hex}
    result = await http.post(
        "/v1/challenges", json={"destination": "+12025550123", "purpose": "login"}, headers=headers
    )
    assert result.status_code == 201, result.text
    return result.json(), headers


async def test_live_dispatch_is_durable_encrypted_and_worker_owned(gateway):
    from otpigeon.worker import Worker

    challenge, headers = await live_challenge(gateway)
    service = gateway[1]
    cid = challenge["challenge_id"]
    assert challenge["delivery"]["status"] == "queued"
    job = await service.db.jobs.find_one({"challenge_id": cid})
    assert "code" not in job and TWILIO["auth_token"] not in str(job)
    assert TWILIO["auth_token"] not in str(await service.db.projects.find_one({"_id": challenge["project_id"]}))
    seen = []

    async def provider(request):
        seen.append(request)
        assert request.url.host == "api.twilio.com"
        assert request.headers["Authorization"].startswith("Basic ")
        return httpx.Response(201, json={"sid": "SM" + "f" * 32, "status": "queued"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        workers = [Worker(service, client=client) for _ in range(2)]
        await asyncio.gather(*(w.run_once() for w in workers))
    assert len(seen) == 1
    current = await service.db.challenges.find_one({"_id": cid})
    assert current["delivery"]["status"] == "provider_accepted"
    assert current["delivery"]["provider"] == "twilio_sms"
    completed = await service.db.jobs.find_one({"_id": job["_id"]})
    assert completed["state"] == "completed" and "payload" not in completed


async def test_reserved_lease_recovers_but_sending_crash_becomes_unknown(gateway):
    from otpigeon.worker import Worker

    challenge, _ = await live_challenge(gateway)
    service, clock = gateway[1], gateway[3]
    first, second = Worker(service), Worker(service)
    job = await first.claim()
    assert job
    clock.advance(31)
    recovered = await second.claim()
    assert recovered and recovered["_id"] == job["_id"] and recovered["lease_token"] != job["lease_token"]
    assert not await first.begin(job)
    assert await second.begin(recovered)
    clock.advance(31)
    await first.reap()
    stored = await service.db.challenges.find_one({"_id": challenge["challenge_id"]})
    assert stored["delivery"]["status"] == "unknown"
    assert not await first.claim()


async def test_expired_or_superseded_generation_is_not_dispatched(gateway):
    from otpigeon.worker import Worker

    challenge, headers = await live_challenge(gateway)
    service, clock, http = gateway[1], gateway[3], gateway[2]
    old = await service.db.jobs.find_one({"challenge_id": challenge["challenge_id"]})
    clock.advance(61)
    headers["Idempotency-Key"] = uuid4().hex
    assert (
        await http.post(f"/v1/challenges/{challenge['challenge_id']}/resend", json={}, headers=headers)
    ).status_code == 200
    assert (await service.db.jobs.find_one({"_id": old["_id"]}))["state"] == "canceled"
    clock.advance(301)

    async def forbidden(request):
        raise AssertionError("Expired code reached the provider")

    async with httpx.AsyncClient(transport=httpx.MockTransport(forbidden)) as client:
        worker = Worker(service, client=client)
        await worker.run_once()
    assert (await service.db.challenges.find_one({"_id": challenge["challenge_id"]}))["status"] == "expired"


async def test_provider_credentials_are_redacted_and_test_provider_is_fixed(gateway):
    service, project = gateway[1], gateway[4]
    await service.configure_provider(project["project_id"], "live", TWILIO)
    public = await service.project_detail(project["project_id"])
    assert TWILIO["auth_token"] not in str(public)
    assert public["environments"]["live"]["provider"] == "twilio_sms"
    with pytest.raises(ValueError):
        await service.configure_provider(project["project_id"], "test", TWILIO)
    with pytest.raises(ValueError):
        await service.configure_provider(project["project_id"], "live", {**TWILIO, "base_url": "http://127.0.0.1"})


@pytest.mark.parametrize(
    "failure,expected",
    [("connect", "retry"), ("read", "unknown"), ("500", "unknown"), ("401", "provider_failed"), ("bad", "unknown")],
)
async def test_provider_uncertainty_is_never_blindly_retried(failure, expected):
    from otpigeon.gateway.adapters import send

    async def provider(request):
        if failure == "connect":
            raise httpx.ConnectError("fictional connection failure")
        if failure == "read":
            raise httpx.ReadTimeout("fictional lost reply")
        return httpx.Response(int(failure) if failure.isdigit() else 201, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        outcome = await send(
            client,
            TWILIO,
            {"_id": "fictional"},
            {"destination": "+15555550123"},
            "123456",
            "https://gateway.test",
            5,
            300,
        )
    assert outcome.status == expected

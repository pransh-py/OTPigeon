import asyncio
import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest

from app.main import create_app
from conftest import create, outbox


async def test_complete_developer_flow_and_safe_events(gateway):
    app, service, http, clock, project, issued, config = gateway
    response = await create(http)
    assert response.status_code == 201, response.text
    challenge = response.json()
    cid = challenge["challenge_id"]
    assert challenge["project_id"] == project["project_id"]
    assert challenge["delivery"] == {"status": "provider_accepted", "provider": "mock", "simulated": True, "reason": None}
    code = await outbox(http, cid)
    stored = await service.db.challenges.find_one({"_id": cid})
    assert stored["otp_hash"] != code
    assert "code" not in stored
    stored_key = await service.db.api_keys.find_one({"_id": issued["key_id"]})
    assert issued["api_key"] not in json.dumps(stored_key, default=str)
    wrong = "000000" if code != "000000" else "000001"
    failed = await http.post(f"/v1/challenges/{cid}/verify", json={"code": wrong})
    assert failed.json()["reason"] == "invalid_code"
    assert failed.json()["attempts_remaining"] == 4
    verified = await http.post(f"/v1/challenges/{cid}/verify", json={"code": code})
    assert verified.json()["verified"] is True
    assert verified.json()["status"] == "verified"
    replay = await http.post(f"/v1/challenges/{cid}/verify", json={"code": code})
    assert replay.json()["verified"] is False
    events = (await http.get(f"/v1/challenges/{cid}/events")).json()["items"]
    assert [e["type"] for e in events] == ["requested", "provider_accepted", "verify_failed", "verified"]
    assert all(e["simulated"] and e["environment"] == "test" for e in events)
    assert "+12025550123" not in json.dumps(events)
    assert code not in json.dumps(events)
    assert issued["api_key"] not in json.dumps(events)
    assert await service.db.challenges.count_documents({"_id": cid}) == 1


async def test_authentication_quarantine_live_and_revocation(gateway):
    app, service, http, clock, project, issued, config = gateway
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as anonymous:
        assert (await create(anonymous)).status_code == 401
        assert (await anonymous.get("/v1/events")).status_code == 401
        for route in ("/otp/request", "/set-sender", "/senders"):
            response = await anonymous.request("GET" if route == "/senders" else "POST", route, json={})
            assert response.status_code == 404
    live = await service.issue_key(project["project_id"], "live")
    headers = {"Authorization": "Bearer " + live["api_key"], "Idempotency-Key": uuid4().hex}
    disabled = await http.post("/v1/challenges", json={"destination": "+12025550123", "purpose": "login"}, headers=headers)
    assert disabled.status_code == 503
    assert disabled.json()["error"]["code"] == "live_delivery_disabled"
    assert await service.db.challenges.count_documents({}) == 0
    keys = await service.list_keys(project["project_id"])
    assert "api_key" not in json.dumps(keys) and "digest" not in json.dumps(keys)
    assert await service.revoke_key(issued["key_id"])
    assert (await create(http)).status_code == 401


async def test_project_environment_and_purpose_isolation(gateway):
    app, service, http, clock, project, issued, config = gateway
    cid = (await create(http)).json()["challenge_id"]
    other = await service.create_project("other")
    for owner, env in ((other["project_id"], "test"), (project["project_id"], "live")):
        key = (await service.issue_key(owner, env))["api_key"]
        headers = {"Authorization": "Bearer " + key, "Idempotency-Key": uuid4().hex}
        for method, endpoint, body in (
            ("GET", f"/v1/challenges/{cid}", None),
            ("GET", f"/v1/challenges/{cid}/events", None),
            ("POST", f"/v1/challenges/{cid}/verify", {"code": "123456"}),
            ("POST", f"/v1/challenges/{cid}/resend", {}),
        ):
            assert (await http.request(method, endpoint, json=body, headers=headers)).status_code == 404
        result = await http.get("/v1/test/outbox", params={"challenge_id": cid}, headers=headers)
        assert result.status_code == (403 if env == "live" else 404)
        assert (await http.get("/v1/events", headers=headers)).json()["items"] == []
    second = await create(http, purpose="phone_change")
    assert second.status_code == 201
    assert (await http.get(f"/v1/challenges/{cid}")).json()["status"] == "pending"


async def test_idempotency_concurrent_replay_conflict_and_resend_resource_scope(gateway):
    app, service, http, clock, project, issued, config = gateway
    key = uuid4().hex
    results = await asyncio.gather(*[create(http, key=key) for _ in range(16)])
    assert all(r.status_code == 201 for r in results)
    assert len({json.dumps(r.json(), sort_keys=True) for r in results}) == 1
    cid = results[0].json()["challenge_id"]
    assert await service.db.outbox.count_documents({}) == 1
    assert await service.db.events.count_documents({"challenge_id": cid}) == 2
    assert (await create(http, purpose="signup", key=key)).status_code == 409
    clock.advance(61)
    replay_key = uuid4().hex
    resend = await asyncio.gather(*[http.post(f"/v1/challenges/{cid}/resend", json={}, headers={"Idempotency-Key": replay_key}) for _ in range(12)])
    assert all(r.status_code == 200 for r in resend)
    assert len({json.dumps(r.json(), sort_keys=True) for r in resend}) == 1
    assert await service.db.events.count_documents({"challenge_id": cid, "reason": "resend"}) == 1
    second = (await create(http, destination="+12025550124")).json()["challenge_id"]
    clock.advance(61)
    assert (await http.post(f"/v1/challenges/{second}/resend", json={}, headers={"Idempotency-Key": replay_key})).status_code == 200
    record = await service.db.idempotency.find_one({})
    assert (record["expires_at"] - record["created_at"]).total_seconds() >= 86400


async def test_parallel_correct_wrong_and_create_across_workers(gateway):
    app, service, http, clock, project, issued, config = gateway
    second_app = create_app(config, clock=clock)
    async with second_app.router.lifespan_context(second_app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=second_app), base_url="http://worker2", headers=http.headers) as worker2:
            clients = [http, worker2] * 12
            results = await asyncio.gather(*[create(h) for h in clients])
            assert sum(r.status_code == 201 for r in results) == 1
            assert sum(r.status_code == 429 for r in results) == 23
            cid = next(r.json()["challenge_id"] for r in results if r.status_code == 201)
            code = await outbox(http, cid)
            consumes = await asyncio.gather(*[h.post(f"/v1/challenges/{cid}/verify", json={"code": code}) for h in clients])
            assert sum(r.json()["verified"] for r in consumes) == 1
            assert await service.db.events.count_documents({"challenge_id": cid, "type": "verified"}) == 1
            wrong_id = (await create(http, destination="+12025550124")).json()["challenge_id"]
            correct = await outbox(http, wrong_id)
            wrong = "000000" if correct != "000000" else "000001"
            guesses = await asyncio.gather(*[h.post(f"/v1/challenges/{wrong_id}/verify", json={"code": wrong}) for h in clients])
            stored = await service.db.challenges.find_one({"_id": wrong_id})
            assert stored["attempts"] == 5 and stored["status"] == "locked"
            assert await service.db.events.count_documents({"challenge_id": wrong_id, "type": "verify_failed"}) == 5
            assert await service.db.events.count_documents({"challenge_id": wrong_id, "type": "locked"}) == 1


async def test_cooldown_supersede_resend_code_and_expiry(gateway):
    app, service, http, clock, project, issued, config = gateway
    cid = (await create(http)).json()["challenge_id"]
    original_code = await outbox(http, cid)
    blocked = await create(http)
    assert blocked.status_code == 429 and blocked.json()["error"]["retry_after"] == 60
    clock.advance(61)
    resend = await http.post(f"/v1/challenges/{cid}/resend", json={}, headers={"Idempotency-Key": uuid4().hex})
    assert resend.status_code == 200
    assert await outbox(http, cid) != original_code
    assert (await http.post(f"/v1/challenges/{cid}/verify", json={"code": original_code})).json()["verified"] is False
    clock.advance(61)
    replacement = await create(http)
    assert replacement.status_code == 201
    assert (await http.get(f"/v1/challenges/{cid}")).json()["status"] == "superseded"
    new_id = replacement.json()["challenge_id"]
    clock.advance(301)
    assert (await http.get(f"/v1/challenges/{new_id}")).json()["status"] == "expired"
    assert (await http.get(f"/v1/challenges/{new_id}")).json()["status"] == "expired"
    assert await service.db.events.count_documents({"challenge_id": new_id, "type": "expired"}) == 1
    assert await service.db.challenges.count_documents({}) == 2


async def test_send_and_guess_budgets_survive_new_challenges(gateway):
    app, service, http, clock, project, issued, config = gateway
    for index in range(5):
        result = await create(http)
        assert result.status_code == 201
        clock.advance(61)
    blocked = await create(http)
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "destination_send_limit"
    clock.advance(3601)
    assert (await create(http)).status_code == 201
    for index in range(2):
        response = await create(http, destination="+12025550124")
        cid = response.json()["challenge_id"]
        code = await outbox(http, cid)
        wrong = "000000" if code != "000000" else "000001"
        for _ in range(5):
            await http.post(f"/v1/challenges/{cid}/verify", json={"code": wrong})
        clock.advance(61)
    cid = (await create(http, destination="+12025550124")).json()["challenge_id"]
    code = await outbox(http, cid)
    blocked = await http.post(f"/v1/challenges/{cid}/verify", json={"code": code})
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "destination_verify_limit"
    assert (await http.get(f"/v1/challenges/{cid}")).json()["attempts_remaining"] == 5


async def test_project_budget_and_resend_cap(gateway):
    app, service, http, clock, project, issued, config = gateway
    service.config = replace(config, project_sends_per_hour=1)
    assert (await create(http)).status_code == 201
    assert (await create(http, destination="+12025550124")).json()["error"]["code"] == "project_send_limit"
    service.config = config
    cid = (await create(http, destination="+12025550124")).json()["challenge_id"]
    for _ in range(3):
        clock.advance(61)
        assert (await http.post(f"/v1/challenges/{cid}/resend", json={}, headers={"Idempotency-Key": uuid4().hex})).status_code == 200
    clock.advance(61)
    result = await http.post(f"/v1/challenges/{cid}/resend", json={}, headers={"Idempotency-Key": uuid4().hex})
    assert result.status_code == 409 and result.json()["error"]["code"] == "resend_limit"


async def test_event_pagination_filter_and_terminal_immutability(gateway):
    app, service, http, clock, project, issued, config = gateway
    cid = (await create(http)).json()["challenge_id"]
    code = await outbox(http, cid)
    await http.post(f"/v1/challenges/{cid}/verify", json={"code": code})
    first = (await http.get("/v1/events", params={"limit": 2})).json()
    second = (await http.get("/v1/events", params={"limit": 2, "after": first["next_cursor"]})).json()
    assert [e["type"] for e in first["items"] + second["items"]] == ["requested", "provider_accepted", "verified"]
    assert len((await http.get("/v1/events", params={"type": "verified"})).json()["items"]) == 1
    clock.advance(500)
    assert (await http.get(f"/v1/challenges/{cid}")).json()["status"] == "verified"
    assert (await http.post(f"/v1/challenges/{cid}/resend", json={}, headers={"Idempotency-Key": uuid4().hex})).status_code == 409
    assert await service.db.events.count_documents({"challenge_id": cid, "type": "expired"}) == 0


@pytest.mark.parametrize("payload", [
    {"destination": "555123", "purpose": "login"},
    {"destination": "+12025550123", "purpose": ""},
    {"destination": "+12025550123", "purpose": "LOGIN"},
    {"destination": "+12025550123", "purpose": "login", "sender_phone": "+12025550100"},
])
async def test_invalid_request_contract(gateway, payload):
    http = gateway[2]
    assert (await http.post("/v1/challenges", json=payload, headers={"Idempotency-Key": uuid4().hex})).status_code == 422


async def test_missing_idempotency_key_and_invalid_code(gateway):
    http = gateway[2]
    assert (await http.post("/v1/challenges", json={"destination": "+12025550123", "purpose": "login"})).status_code == 400
    cid = (await create(http)).json()["challenge_id"]
    for code in (123456, "12345", "abcdef", "１２３４５６"):
        assert (await http.post(f"/v1/challenges/{cid}/verify", json={"code": code})).status_code == 422


async def test_expired_idempotency_record_and_error_replay(gateway):
    app, service, http, clock, project, issued, config = gateway
    first_key = uuid4().hex
    created = await create(http, key=first_key)
    blocked_key = uuid4().hex
    blocked = await create(http, key=blocked_key)
    assert blocked.status_code == 429
    count = await service.db.events.count_documents({"type": "rate_limited"})
    assert (await create(http, key=blocked_key)).json() == blocked.json()
    assert await service.db.events.count_documents({"type": "rate_limited"}) == count
    clock.advance(86401)
    replacement = await create(http, purpose="signup", key=first_key)
    assert replacement.status_code == 201
    assert replacement.json()["challenge_id"] != created.json()["challenge_id"]

from dataclasses import replace
from uuid import uuid4

import httpx
import pytest

from app.gateway.providers import DeliveryResult
from app.main import create_app
from conftest import create, outbox


class FaultDelivery:
    def __init__(self, status):
        self.status = status

    def prepare(self):
        return DeliveryResult(self.status, "provider_timeout" if self.status == "unknown" else "provider_rejected")


async def test_unknown_outcome_remains_verifiable_and_late_receipt_preserves_terminal(gateway):
    app, service, http, clock, project, issued, config = gateway
    service.provider = FaultDelivery("unknown")
    response = await create(http)
    assert response.status_code == 201 and response.json()["delivery"]["status"] == "unknown"
    cid = response.json()["challenge_id"]
    code = await outbox(http, cid)
    stored = await service.db.challenges.find_one({"_id": cid})
    assert (await http.post(f"/v1/challenges/{cid}/verify", json={"code": code})).json()["verified"]
    owner = await service.authenticate(issued["api_key"])
    receipt = {"generation": stored["generation"], "status": "provider_accepted"}
    status, result = await service.execute(owner, "record_delivery", challenge_id=cid, body=receipt)
    assert status == 200 and result["status"] == "verified"
    assert result["delivery"]["status"] == "provider_accepted"
    await service.execute(owner, "record_delivery", challenge_id=cid, body=receipt)
    assert await service.db.events.count_documents({"challenge_id": cid, "type": "provider_accepted"}) == 1
    clock.advance(500)
    assert (await http.get(f"/v1/challenges/{cid}")).json()["status"] == "verified"
    assert await service.db.events.count_documents({"challenge_id": cid, "type": "provider_unknown"}) == 1


async def test_failed_delivery_resend_and_stale_receipt(gateway):
    app, service, http, clock, project, issued, config = gateway
    service.provider = FaultDelivery("provider_failed")
    result = await create(http)
    cid = result.json()["challenge_id"]
    assert result.json()["delivery"]["status"] == "provider_failed"
    assert (await http.get("/v1/test/outbox", params={"challenge_id": cid})).status_code == 404
    generation = (await service.db.challenges.find_one({"_id": cid}))["generation"]
    clock.advance(61)
    service.provider = FaultDelivery("unknown")
    assert (await http.post(f"/v1/challenges/{cid}/resend", json={}, headers={"Idempotency-Key": uuid4().hex})).status_code == 200
    owner = await service.authenticate(issued["api_key"])
    status, body = await service.execute(owner, "record_delivery", challenge_id=cid,
        body={"generation": generation, "status": "provider_accepted"})
    assert status == 409 and body["error"]["code"] == "stale_delivery_generation"


@pytest.mark.parametrize("secret", ["", "short", "replace-with-a-generated-secret-at-least-32-characters"])
async def test_startup_rejects_missing_weak_or_placeholder_secret(gateway, secret):
    config = replace(gateway[6], secret=secret)
    app = create_app(config)
    with pytest.raises(ValueError, match="OTPIGEON_SECRET"):
        async with app.router.lifespan_context(app):
            pass


async def test_legacy_opt_in_requires_separate_admin_token(gateway):
    config = replace(gateway[6], enable_legacy=True)
    with pytest.raises(ValueError, match="Legacy"):
        config.validate()
    with pytest.raises(ValueError, match="Legacy"):
        replace(config, legacy_admin_token=config.secret).validate()


async def test_opted_in_legacy_routes_reject_project_key(gateway, monkeypatch):
    from app import legacy
    class EmptyAdmin:
        async def list_senders(self):
            return []
    monkeypatch.setattr(legacy, "get_sender_admin", lambda: EmptyAdmin())
    config = replace(gateway[6], enable_legacy=True, legacy_admin_token="admin-test-" + "a" * 64)
    # The boundary is tested without running legacy startup or creating senders.
    app = create_app(config)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as http:
        for auth in (None, "Bearer " + gateway[5]["api_key"]):
            headers = {"Authorization": auth} if auth else {}
            assert (await http.get("/senders", headers=headers)).status_code == 401
        authorized = await http.get("/senders", headers={"Authorization": "Bearer " + config.legacy_admin_token})
        assert authorized.status_code == 200 and authorized.json() == {"senders": []}


async def test_resend_does_not_reset_attempts_or_extend_expiry(gateway):
    service, http, clock = gateway[1:4]
    created = (await create(http)).json()
    cid = created["challenge_id"]
    code = await outbox(http, cid)
    wrong = "000000" if code != "000000" else "000001"
    await http.post(f"/v1/challenges/{cid}/verify", json={"code": wrong})
    clock.advance(61)
    resent = (await http.post(f"/v1/challenges/{cid}/resend", json={}, headers={"Idempotency-Key": uuid4().hex})).json()
    assert resent["attempts_remaining"] == 4
    assert resent["expires_at"] == created["expires_at"]

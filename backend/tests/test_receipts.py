import hashlib
import hmac
import json
from urllib.parse import parse_qs

import httpx
import pytest
from twilio.request_validator import RequestValidator

from test_release import META, TWILIO, live_challenge
from otpigeon.worker import Worker


async def test_twilio_signed_receipts_replay_ordering_and_verified_state(gateway):
    challenge, headers = await live_challenge(gateway)
    service, http = gateway[1:3]
    seen = []

    async def provider(request):
        seen.append(parse_qs(request.content.decode()))
        return httpx.Response(201, json={"sid": "SM" + "f" * 32})

    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        await Worker(service, client=client).run_once()
    cid = challenge["challenge_id"]
    code = seen[0]["Body"][0].split()[4].rstrip(".")
    assert (await http.post(f"/v1/challenges/{cid}/verify", json={"code": code}, headers=headers)).json()["verified"]
    job = await service.db.jobs.find_one({"challenge_id": cid})
    path = f"/webhooks/twilio/{job['_id']}"
    params = {
        "AccountSid": TWILIO["account_sid"],
        "MessageSid": "SM" + "f" * 32,
        "MessageStatus": "delivered",
        "NewFutureField": "supported",
    }
    signature = RequestValidator(TWILIO["auth_token"]).compute_signature("https://otpigeon.test" + path, params)
    assert (await http.post(path, data=params)).status_code == 403
    for _ in range(2):
        assert (await http.post(path, data=params, headers={"X-Twilio-Signature": signature})).status_code == 204
    params["MessageStatus"] = "sent"
    signature = RequestValidator(TWILIO["auth_token"]).compute_signature("https://otpigeon.test" + path, params)
    await http.post(path, data=params, headers={"X-Twilio-Signature": signature})
    current = await service.db.challenges.find_one({"_id": cid})
    assert current["status"] == "verified" and current["delivery"]["status"] == "delivered"
    assert await service.db.events.count_documents({"challenge_id": cid, "type": "delivered"}) == 1


async def test_meta_authentication_template_and_signed_receipt(gateway):
    challenge, _ = await live_challenge(gateway, META)
    service, http = gateway[1:3]
    seen = []

    async def provider(request):
        body = json.loads(request.content)
        seen.append(body)
        assert body["type"] == "template"
        assert (
            body["template"]["components"][0]["parameters"][0]["text"]
            == body["template"]["components"][1]["parameters"][0]["text"]
        )
        return httpx.Response(200, json={"messages": [{"id": "wamid.fixture"}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        await Worker(service, client=client).run_once()
    pid = challenge["project_id"]
    path = f"/webhooks/meta/{pid}"
    check = await http.get(
        path, params={"hub.mode": "subscribe", "hub.verify_token": META["verify_token"], "hub.challenge": "12345"}
    )
    assert check.status_code == 200 and check.text == "12345"
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "metadata": {"phone_number_id": META["phone_number_id"]},
                            "statuses": [
                                {
                                    "id": "wamid.fixture",
                                    "status": "delivered",
                                    "biz_opaque_callback_data": seen[0]["biz_opaque_callback_data"],
                                }
                            ],
                        }
                    }
                ]
            }
        ],
    }
    raw = json.dumps(payload).encode()
    signature = "sha256=" + hmac.new(META["app_secret"].encode(), raw, hashlib.sha256).hexdigest()
    assert (await http.post(path, content=raw)).status_code == 403
    for _ in range(2):
        assert (await http.post(path, content=raw, headers={"X-Hub-Signature-256": signature})).status_code == 200
    stored = await service.db.challenges.find_one({"_id": challenge["challenge_id"]})
    assert stored["delivery"]["status"] == "delivered"
    assert (
        await service.db.events.count_documents({"challenge_id": challenge["challenge_id"], "type": "delivered"}) == 1
    )


async def test_malformed_callbacks_do_not_mutate_or_crash(gateway):
    challenge, _ = await live_challenge(gateway, META)
    http, service = gateway[2], gateway[1]
    endpoint = "/webhooks/meta/" + challenge["project_id"]
    for value in [
        [],
        {"object": "whatsapp_business_account", "entry": None},
        {"object": "whatsapp_business_account", "entry": [None]},
    ]:
        response = await http.post(endpoint, json=value)
        assert response.status_code == 400
    response = await http.post(
        endpoint, json={"object": "whatsapp_business_account"}, headers={"X-Hub-Signature-256": "not-a-signature"}
    )
    assert response.status_code == 403
    before = await service.db.jobs.find_one({"challenge_id": challenge["challenge_id"]})
    assert before["state"] == "queued" and "receipt_status" not in before


@pytest.mark.parametrize("late,finish_status", [(False, "unknown"), (False, "retry"), (True, "provider_accepted")])
async def test_receipt_resolves_unknown_and_wins_over_late_http_result(gateway, late, finish_status):
    from otpigeon.gateway.receipts import record_receipt
    from otpigeon.gateway.adapters import Outcome

    challenge, _ = await live_challenge(gateway)
    service, clock = gateway[1], gateway[3]
    worker = Worker(service)
    job = await worker.claim()
    assert await worker.begin(job)
    if late:
        clock.advance(31)
        await worker.reap()
    assert await record_receipt(service, job, "SMfixture", "delivered")
    await worker.finish(job, Outcome(finish_status, "fixture_result", message_id="SMfixture", retry_after=2))
    current = await service.db.jobs.find_one({"_id": job["_id"]})
    assert current["state"] == "completed" and "payload" not in current
    assert (await service.db.challenges.find_one({"_id": challenge["challenge_id"]}))["delivery"][
        "status"
    ] == "delivered"
    assert not await worker.claim()

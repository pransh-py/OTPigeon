import hashlib
import hmac
import json
from urllib.parse import parse_qsl

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from starlette.datastructures import FormData
from twilio.request_validator import RequestValidator

from .service import identifier


def signed(secret, raw, signature):
    expected = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return bool(signature) and hmac.compare_digest(expected.encode(), signature.encode())


async def record_receipt(service, job, message_id, status):
    if not isinstance(message_id, str) or not 1 <= len(message_id) <= 512:
        return False
    ranks = {"provider_accepted": 1, "provider_failed": 2, "delivered": 3}
    if status not in ranks:
        return False
    gate = identifier(job["project_id"], job["environment"])
    await service._ensure_gate(gate)

    async def transaction(session):
        await service.db.gates.update_one({"_id": gate}, {"$inc": {"revision": 1}}, session=session)
        current = await service.db.jobs.find_one(
            {"_id": job["_id"], "state": {"$in": ["sending", "unknown", "completed"]}}, session=session
        )
        if not current or (current.get("message_id") and current["message_id"] != message_id):
            return False
        if ranks.get(current.get("receipt_status"), 0) >= ranks[status]:
            return False
        await service.db.jobs.update_one(
            {"_id": current["_id"]},
            {"$set": {"message_id": message_id, "receipt_status": status, "receipt_at": service.clock()}},
            session=session,
        )
        if current["state"] == "unknown":
            await service.db.jobs.update_one(
                {"_id": current["_id"]},
                {"$set": {"state": "completed", "result": status, "reason": "confirmed_receipt"}},
                session=session,
            )
        challenge = await service.db.challenges.find_one({"_id": current["challenge_id"]}, session=session)
        if not challenge:
            return False
        if challenge["generation"] == current["generation"]:
            delivery = {
                "status": status,
                "provider": current["provider"],
                "simulated": False,
                "reason": "provider_receipt" if status == "provider_failed" else None,
            }
            await service.db.challenges.update_one(
                {"_id": challenge["_id"]}, {"$set": {"delivery": delivery}}, session=session
            )
        evidence = {**challenge, "generation": current["generation"], "delivery": {"provider": current["provider"]}}
        actor = {"project_id": current["project_id"], "environment": current["environment"]}
        await service._event(actor, evidence, status, "confirmed_receipt", service.clock(), session)
        return True

    return await service._transaction(transaction)


def router():
    routes = APIRouter(prefix="/webhooks", include_in_schema=False)

    @routes.post("/twilio/{job_id}")
    async def twilio(job_id: str, request: Request):
        service = request.app.state.gateway
        job = await service.db.jobs.find_one({"_id": job_id, "provider": "twilio_sms"})
        if not job:
            return Response(status_code=404)
        config = service.vault.decrypt(job["provider_snapshot"])
        try:
            params = FormData(
                parse_qsl((await request.body()).decode("utf-8"), keep_blank_values=True, max_num_fields=100)
            )
        except (UnicodeError, ValueError):
            return Response(status_code=400)
        url = service.config.public_base_url.rstrip("/") + request.url.path
        if request.url.query:
            url += "?" + request.url.query
        signature = request.headers.get("X-Twilio-Signature", "")
        if (
            not RequestValidator(config["auth_token"]).validate(url, params, signature)
            or params.get("AccountSid") != config["account_sid"]
        ):
            return Response(status_code=403)
        statuses = {
            "accepted": "provider_accepted",
            "queued": "provider_accepted",
            "sending": "provider_accepted",
            "sent": "provider_accepted",
            "delivered": "delivered",
            "failed": "provider_failed",
            "undelivered": "provider_failed",
        }
        status = statuses.get(params.get("MessageStatus"))
        if status:
            await record_receipt(service, job, params.get("MessageSid"), status)
        return Response(status_code=204)

    @routes.get("/meta/{project_id}")
    async def meta_verify(project_id: str, request: Request):
        service = request.app.state.gateway
        project = await service.db.projects.find_one({"_id": project_id})
        provider = project["environments"]["live"] if project else {}
        if provider.get("provider") != "meta_whatsapp":
            return Response(status_code=404)
        config = service.vault.decrypt(provider["sealed"])
        supplied = request.query_params.get("hub.verify_token", "")
        challenge = request.query_params.get("hub.challenge", "")
        if (
            request.query_params.get("hub.mode") != "subscribe"
            or not hmac.compare_digest(config["verify_token"].encode(), supplied.encode())
            or not challenge.isdigit()
            or len(challenge) > 128
        ):
            return Response(status_code=403)
        return PlainTextResponse(challenge)

    @routes.post("/meta/{project_id}")
    async def meta(project_id: str, request: Request):
        service = request.app.state.gateway
        raw = await request.body()
        signature = request.headers.get("X-Hub-Signature-256", "")
        project = await service.db.projects.find_one({"_id": project_id})
        selected = project["environments"]["live"] if project else {}
        current_config = (
            service.vault.decrypt(selected["sealed"]) if selected.get("provider") == "meta_whatsapp" else None
        )
        authenticated = bool(current_config and signed(current_config["app_secret"], raw, signature))
        try:
            payload = json.loads(raw)
            receipts = []
            if not isinstance(payload, dict) or payload.get("object") != "whatsapp_business_account":
                return Response(status_code=400)
            for entry in payload.get("entry", [])[:20]:
                for change in entry.get("changes", [])[:20]:
                    value = change.get("value", {})
                    for status in value.get("statuses", [])[:50]:
                        receipts.append((status, value.get("metadata", {}).get("phone_number_id")))
            if len(receipts) > 50:
                return Response(status_code=400)
        except (ValueError, TypeError, AttributeError, RecursionError):
            return Response(status_code=400)
        valid = []
        for receipt, phone_id in receipts:
            if not isinstance(receipt, dict):
                return Response(status_code=400)
            message_id, opaque = receipt.get("id"), receipt.get("biz_opaque_callback_data")
            query = {"project_id": project_id, "provider": "meta_whatsapp"}
            query["_id" if isinstance(opaque, str) else "message_id"] = (
                opaque if isinstance(opaque, str) else message_id
            )
            if not isinstance(query.get("_id", message_id), str):
                continue
            job = await service.db.jobs.find_one(query)
            if not job:
                continue
            config = service.vault.decrypt(job["provider_snapshot"])
            if signed(config["app_secret"], raw, signature) and phone_id == config["phone_number_id"]:
                authenticated = True
                valid.append((job, message_id, receipt.get("status")))
        if not authenticated:
            return Response(status_code=403)
        statuses = {
            "sent": "provider_accepted",
            "delivered": "delivered",
            "read": "delivered",
            "failed": "provider_failed",
        }
        for job, message_id, status in valid:
            if isinstance(status, str) and status in statuses:
                await record_receipt(service, job, message_id, statuses[status])
        return JSONResponse({"received": True})

    return routes

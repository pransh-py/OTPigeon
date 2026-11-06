"""Single-operator dashboard. Credentials stay in HttpOnly cookies or encrypted storage."""

import base64
import hashlib
import hmac
import json
import secrets
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ReturnDocument

from otpigeon.gateway.service import identifier


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=1, max_length=256)


class ProjectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)


class KeyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    environment: str = Field(pattern="^(test|live)$")


def encode(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def session_signature(config, payload):
    return hmac.new(
        config.secret.encode(), ("admin-session:" + config.admin_token + ":" + payload).encode(), hashlib.sha256
    ).hexdigest()


async def session(request):
    service = request.app.state.gateway
    config = service.config
    cookie = request.cookies.get("otpigeon_session", "")
    if not config.admin_token or len(cookie) > 1024:
        raise HTTPException(401, detail={"code": "operator_login_required", "message": "Operator login required"})
    try:
        payload, signature = cookie.split(".")
        if not hmac.compare_digest(session_signature(config, payload), signature):
            raise ValueError
        value = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if value["expires"] <= service.clock().timestamp():
            raise ValueError
        if not await service.db.operator_sessions.find_one(
            {"_id": hashlib.sha256(payload.encode()).hexdigest(), "expires_at": {"$gt": service.clock()}}
        ):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise HTTPException(
            401, detail={"code": "operator_login_required", "message": "Operator login required"}
        ) from None
    return payload


def check_origin(request):
    origin = request.headers.get("origin")
    public = request.app.state.gateway.config.public_base_url.rstrip("/")
    local = request.url.hostname in ("localhost", "127.0.0.1", "::1")
    if origin and origin != public and not (local and origin == str(request.base_url).rstrip("/")):
        raise HTTPException(403, detail={"code": "invalid_origin", "message": "Request origin is not allowed"})
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, detail={"code": "invalid_origin", "message": "Cross-site request rejected"})


def csrf(config, payload):
    return hmac.new(config.secret.encode(), ("csrf:" + payload).encode(), hashlib.sha256).hexdigest()


async def operator(request: Request):
    payload = await session(request)
    if request.method not in ("GET", "HEAD"):
        check_origin(request)
        expected = csrf(request.app.state.gateway.config, payload)
        if not hmac.compare_digest(expected.encode(), request.headers.get("X-CSRF-Token", "").encode()):
            raise HTTPException(
                403, detail={"code": "csrf_required", "message": "Refresh the dashboard before submitting"}
            )
    return payload


async def actor(service, project_id, environment):
    if environment not in ("test", "live") or not await service.db.projects.find_one({"_id": project_id}):
        raise HTTPException(404, detail={"code": "project_not_found", "message": "Project not found"})
    key_id = identifier("internal_operator", project_id, environment)
    await service.db.api_keys.update_one(
        {"_id": key_id},
        {
            "$setOnInsert": {
                "digest": "internal:" + key_id,
                "prefix": "operator",
                "project_id": project_id,
                "environment": environment,
                "created_at": service.clock(),
                "revoked_at": None,
                "internal": True,
            }
        },
        upsert=True,
    )
    return await service.db.api_keys.find_one({"_id": key_id})


def router():
    from fastapi import Depends
    from otpigeon.gateway.schemas import CreateChallenge, VerifyChallenge
    from otpigeon.main import reply

    routes = APIRouter(prefix="/admin", include_in_schema=False)

    @routes.post("/login")
    async def login(body: Login, request: Request):
        check_origin(request)
        service = request.app.state.gateway
        config = service.config
        if not config.admin_token:
            raise HTTPException(
                503,
                detail={
                    "code": "operator_not_configured",
                    "message": "Set OTPIGEON_ADMIN_TOKEN to enable the dashboard",
                },
            )
        now = service.clock()
        bucket = int(now.timestamp()) // 300
        key = identifier("operator-login", request.client.host if request.client else "unknown", bucket)
        limit = await service.db.login_limits.find_one_and_update(
            {"_id": key},
            {"$inc": {"attempts": 1}, "$setOnInsert": {"expires_at": now + timedelta(minutes=10)}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        if limit["attempts"] > 10:
            return JSONResponse(
                {"error": {"code": "login_rate_limited", "message": "Wait before trying again"}},
                status_code=429,
                headers={"Retry-After": "300"},
            )
        if not hmac.compare_digest(
            hashlib.sha256(body.token.encode()).digest(), hashlib.sha256(config.admin_token.encode()).digest()
        ):
            raise HTTPException(
                401, detail={"code": "invalid_operator_token", "message": "Operator token is incorrect"}
            )
        payload = encode(
            json.dumps({"nonce": secrets.token_urlsafe(24), "expires": int(now.timestamp()) + 28800}).encode()
        )
        await service.db.operator_sessions.insert_one(
            {"_id": hashlib.sha256(payload.encode()).hexdigest(), "expires_at": now + timedelta(hours=8)}
        )
        response = JSONResponse({"csrf_token": csrf(config, payload)})
        response.set_cookie(
            "otpigeon_session",
            payload + "." + session_signature(config, payload),
            max_age=28800,
            httponly=True,
            secure=config.public_base_url.startswith("https://"),
            samesite="strict",
            path="/",
        )
        return response

    @routes.get("/session")
    async def current_session(request: Request, payload=Depends(operator)):
        return {"csrf_token": csrf(request.app.state.gateway.config, payload)}

    @routes.post("/logout")
    async def logout(request: Request, payload=Depends(operator)):
        await request.app.state.gateway.db.operator_sessions.delete_one(
            {"_id": hashlib.sha256(payload.encode()).hexdigest()}
        )
        response = JSONResponse({"logged_out": True})
        response.delete_cookie("otpigeon_session", path="/", httponly=True, samesite="strict")
        return response

    @routes.get("/projects")
    async def projects(request: Request, payload=Depends(operator)):
        return {"items": await request.app.state.gateway.list_projects()}

    @routes.post("/projects", status_code=201)
    async def create_project(body: ProjectBody, request: Request, payload=Depends(operator)):
        try:
            return await request.app.state.gateway.create_project(body.name)
        except ValueError as exc:
            raise HTTPException(400, detail={"code": "invalid_project", "message": str(exc)}) from None

    @routes.post("/projects/{project_id}/provider")
    async def configure(project_id: str, request: Request, payload=Depends(operator)):
        try:
            return await request.app.state.gateway.configure_provider(project_id, "live", await request.json())
        except (ValueError, TypeError):
            raise HTTPException(
                400, detail={"code": "invalid_provider_config", "message": "Check provider fields and project ID"}
            ) from None

    @routes.delete("/projects/{project_id}/provider")
    async def disable(project_id: str, request: Request, payload=Depends(operator)):
        try:
            return await request.app.state.gateway.disable_provider(project_id)
        except ValueError:
            raise HTTPException(404, detail={"code": "project_not_found", "message": "Project not found"}) from None

    @routes.get("/projects/{project_id}/keys")
    async def keys(project_id: str, request: Request, payload=Depends(operator)):
        return {"items": await request.app.state.gateway.list_keys(project_id)}

    @routes.post("/projects/{project_id}/keys", status_code=201)
    async def issue(project_id: str, body: KeyBody, request: Request, payload=Depends(operator)):
        try:
            return await request.app.state.gateway.issue_key(project_id, body.environment)
        except ValueError:
            raise HTTPException(404, detail={"code": "project_not_found", "message": "Project not found"}) from None

    @routes.delete("/keys/{key_id}")
    async def revoke(key_id: str, request: Request, payload=Depends(operator)):
        return {"revoked": await request.app.state.gateway.revoke_key(key_id)}

    @routes.get("/projects/{project_id}/challenges")
    async def challenges(
        project_id: str,
        request: Request,
        environment: str = "test",
        before: str | None = None,
        payload=Depends(operator),
    ):
        service = request.app.state.gateway
        owner = await actor(service, project_id, environment)
        try:
            return await service.list_challenges(owner, before=before)
        except ValueError:
            raise HTTPException(
                400, detail={"code": "invalid_cursor", "message": "Invalid pagination cursor"}
            ) from None

    @routes.get("/projects/{project_id}/events")
    async def events(
        project_id: str,
        request: Request,
        environment: str = "test",
        challenge_id: str | None = None,
        after: int = 0,
        payload=Depends(operator),
    ):
        service = request.app.state.gateway
        owner = await actor(service, project_id, environment)
        return reply(await service.events(owner, challenge_id=challenge_id, after=max(0, after)))

    @routes.get("/projects/{project_id}/metrics")
    async def metrics(project_id: str, request: Request, environment: str = "test", payload=Depends(operator)):
        service = request.app.state.gateway
        await actor(service, project_id, environment)
        query = {"project_id": project_id, "environment": environment}
        groups = await service.db.challenges.aggregate(
            [
                {"$match": query},
                {
                    "$group": {
                        "_id": {
                            "$cond": [
                                {"$and": [{"$eq": ["$status", "pending"]}, {"$lte": ["$expires_at", service.clock()]}]},
                                "expired",
                                "$status",
                            ]
                        },
                        "count": {"$sum": 1},
                    }
                },
            ]
        )
        values = {d["_id"]: d["count"] async for d in groups}
        return {
            "requested": sum(values.values()),
            "verified": values.get("verified", 0),
            "pending": values.get("pending", 0),
            "expired": values.get("expired", 0),
            "locked": values.get("locked", 0),
            "delivered": await service.db.challenges.count_documents({**query, "delivery.status": "delivered"}),
            "failed": await service.db.challenges.count_documents({**query, "delivery.status": "provider_failed"}),
        }

    @routes.post("/projects/{project_id}/test-challenges", status_code=201)
    async def test_challenge(project_id: str, body: CreateChallenge, request: Request, payload=Depends(operator)):
        service = request.app.state.gateway
        owner = await actor(service, project_id, "test")
        return reply(
            await service.execute(
                owner,
                "create",
                body=body.model_dump(),
                idempotency_key=request.headers.get("Idempotency-Key") or secrets.token_hex(16),
            )
        )

    @routes.get("/projects/{project_id}/test-challenges/{challenge_id}/code")
    async def test_code(project_id: str, challenge_id: str, request: Request, payload=Depends(operator)):
        service = request.app.state.gateway
        owner = await actor(service, project_id, "test")
        return reply(await service.execute(owner, "outbox", challenge_id=challenge_id))

    @routes.post("/projects/{project_id}/test-challenges/{challenge_id}/verify")
    async def test_verify(
        project_id: str, challenge_id: str, body: VerifyChallenge, request: Request, payload=Depends(operator)
    ):
        service = request.app.state.gateway
        owner = await actor(service, project_id, "test")
        return reply(await service.execute(owner, "verify", challenge_id=challenge_id, body=body.model_dump()))

    @routes.get("/status")
    async def status(request: Request, payload=Depends(operator)):
        service = request.app.state.gateway
        cutoff = service.clock() - timedelta(seconds=service.config.worker_lease_seconds * 2)
        return {
            "live_enabled": service.config.allow_live_delivery,
            "workers": await service.db.worker_heartbeats.count_documents({"seen_at": {"$gt": cutoff}}),
            "queued": await service.db.jobs.count_documents({"state": "queued"}),
            "unknown": await service.db.jobs.count_documents({"state": "unknown"}),
        }

    return routes

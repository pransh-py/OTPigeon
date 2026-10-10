import hmac
import re
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pymongo import AsyncMongoClient
from pymongo.errors import PyMongoError

from app.gateway.config import GatewaySettings
from app.gateway.schemas import (ChallengeResponse, CreateChallenge, EventPage, EventType,
                                 OutboxResponse, ResendChallenge, VerificationResponse, VerifyChallenge)
from app.gateway.service import GatewayService, utcnow


class LegacyAdminGate:
    def __init__(self, app, token):
        self.app, self.token = app, token

    async def __call__(self, scope, receive, send):
        headers = dict(scope.get("headers", []))
        expected = ("Bearer " + self.token).encode()
        if scope["type"] == "http" and not hmac.compare_digest(headers.get(b"authorization", b""), expected):
            response = JSONResponse({"error": {"code": "legacy_admin_required", "message": "Legacy admin token required"}}, status_code=401)
            return await response(scope, receive, send)
        await self.app(scope, receive, send)


def reply(result):
    status, body = result
    retry = body.get("error", {}).get("retry_after")
    return JSONResponse(body, status_code=status, headers={"Retry-After": str(retry)} if retry is not None else None)


def create_app(config=None, *, provider=None, clock=utcnow):
    config = config or GatewaySettings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        config.validate()
        client = AsyncMongoClient(config.mongodb_url, tz_aware=True, serverSelectionTimeoutMS=5000)
        try:
            service = GatewayService(client[config.mongodb_db_name], config, provider=provider, clock=clock)
            await service.initialize()
            app.state.gateway = service
            if config.enable_legacy:
                from app import legacy
                async with legacy.app.router.lifespan_context(legacy.app):
                    yield
                from app.db import client as legacy_client
                await legacy_client.close()
            else:
                yield
        finally:
            await client.close()

    app = FastAPI(title="OTPigeon", version="0.1.0", lifespan=lifespan,
                  description="Self-hosted verification gateway. M1 supports simulated test delivery only.")
    security = HTTPBearer(auto_error=False)

    def service(request: Request):
        return request.app.state.gateway

    async def actor(credentials: HTTPAuthorizationCredentials | None = Depends(security), gateway=Depends(service)):
        key = await gateway.authenticate(credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else None)
        if not key:
            raise HTTPException(401, detail={"code": "invalid_api_key", "message": "Missing, invalid, or revoked API key"}, headers={"WWW-Authenticate": "Bearer"})
        return key

    def idempotency(value: str | None = Header(default=None, alias="Idempotency-Key")):
        if not value:
            raise HTTPException(400, detail={"code": "idempotency_key_required", "message": "Idempotency-Key is required"})
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
            raise HTTPException(400, detail={"code": "invalid_idempotency_key", "message": "Use 1–128 ASCII letters, digits, dots, underscores, colons or hyphens"})
        return value

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(PyMongoError)
    async def database_error(request, exc):
        return JSONResponse({"error": {"code": "storage_unavailable", "message": "Storage temporarily unavailable"}}, status_code=503)

    @app.get("/health")
    async def health(gateway=Depends(service)):
        await gateway.db.command("ping")
        return {"status": "ok", "mode": "test_only"}

    @app.post("/v1/challenges", status_code=201, response_model=ChallengeResponse)
    async def create(body: CreateChallenge, owner=Depends(actor), key=Depends(idempotency), gateway=Depends(service)):
        return reply(await gateway.execute(owner, "create", body=body.model_dump(), idempotency_key=key))

    @app.get("/v1/challenges/{challenge_id}", response_model=ChallengeResponse)
    async def get(challenge_id: str, owner=Depends(actor), gateway=Depends(service)):
        return reply(await gateway.execute(owner, "get", challenge_id=challenge_id))

    @app.post("/v1/challenges/{challenge_id}/resend", response_model=ChallengeResponse)
    async def resend(challenge_id: str, body: ResendChallenge = Body(default=ResendChallenge()),
                     owner=Depends(actor), key=Depends(idempotency), gateway=Depends(service)):
        return reply(await gateway.execute(owner, "resend", challenge_id=challenge_id, body=body.model_dump(), idempotency_key=key))

    @app.post("/v1/challenges/{challenge_id}/verify", response_model=VerificationResponse)
    async def verify(challenge_id: str, body: VerifyChallenge, owner=Depends(actor), gateway=Depends(service)):
        return reply(await gateway.execute(owner, "verify", challenge_id=challenge_id, body=body.model_dump()))

    @app.get("/v1/challenges/{challenge_id}/events", response_model=EventPage)
    async def challenge_events(challenge_id: str, after: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100),
                               owner=Depends(actor), gateway=Depends(service)):
        return reply(await gateway.events(owner, challenge_id=challenge_id, after=after, limit=limit))

    @app.get("/v1/events", response_model=EventPage)
    async def events(challenge_id: str | None = None, type: EventType | None = None,
                     after: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100),
                     owner=Depends(actor), gateway=Depends(service)):
        return reply(await gateway.events(owner, challenge_id=challenge_id, kind=type, after=after, limit=limit))

    @app.get("/v1/test/outbox", response_model=OutboxResponse)
    async def outbox(challenge_id: str, owner=Depends(actor), gateway=Depends(service)):
        if owner["environment"] != "test":
            raise HTTPException(403, detail={"code": "test_key_required", "message": "Outbox requires a test key"})
        return reply(await gateway.execute(owner, "outbox", challenge_id=challenge_id))

    if config.enable_legacy:
        from app import legacy
        app.mount("/", LegacyAdminGate(legacy.app, config.legacy_admin_token))
    return app


app = create_app()

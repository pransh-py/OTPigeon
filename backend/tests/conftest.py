import os
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import pytest_asyncio

from app.gateway.config import GatewaySettings
from app.main import create_app


class Clock:
    def __init__(self):
        self.now = datetime.now(timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


@pytest_asyncio.fixture
async def gateway():
    uri = os.environ.get("OTPIGEON_TEST_MONGODB_URL")
    if not uri:
        raise RuntimeError("Set OTPIGEON_TEST_MONGODB_URL to an isolated replica set")
    clock = Clock()
    config = GatewaySettings(
        mongodb_url=uri, mongodb_db_name="otpigeon_test_" + uuid4().hex,
        secret="test-only-" + "x" * 64,
    )
    app = create_app(config, clock=clock)
    async with app.router.lifespan_context(app):
        service = app.state.gateway
        project = await service.create_project("test application")
        issued = await service.issue_key(project["project_id"], "test")
        headers = {"Authorization": "Bearer " + issued["api_key"]}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://gateway",
            headers=headers,
        ) as http:
            yield app, service, http, clock, project, issued, config
        # Only this fixture's random database is removed.
        await service.db.client.drop_database(config.mongodb_db_name)


async def create(http, destination="+12025550123", purpose="login", key=None):
    return await http.post("/v1/challenges", json={"destination": destination, "purpose": purpose},
                           headers={"Idempotency-Key": key or uuid4().hex})


async def outbox(http, challenge_id):
    result = await http.get("/v1/test/outbox", params={"challenge_id": challenge_id})
    assert result.status_code == 200, result.text
    return result.json()["code"]

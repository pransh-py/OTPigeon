from dataclasses import replace

import pytest

from conftest import create
from otpigeon.worker import Worker


@pytest.mark.asyncio
async def test_dashboard_session_csrf_logout_and_secret_redaction(gateway):
    app, service, http, clock, project, issued, config = gateway
    token = "operator-fixture-" + "z" * 40
    service.config = replace(config, admin_token=token)
    assert (await http.get("/admin/projects")).status_code == 401
    assert (
        await http.post("/admin/login", json={"token": token}, headers={"Origin": "https://attacker.test"})
    ).status_code == 403
    login = await http.post("/admin/login", json={"token": token})
    assert login.status_code == 200
    assert "HttpOnly" in login.headers["set-cookie"] and "SameSite=strict" in login.headers["set-cookie"]
    cookie = http.cookies.get("otpigeon_session")
    csrf = login.json()["csrf_token"]
    assert (await http.post("/admin/projects", json={"name": "another"})).status_code == 403
    http.headers["X-CSRF-Token"] = csrf
    new = await http.post("/admin/projects", json={"name": "<script>literal name</script>"})
    assert new.status_code == 201
    metrics = await http.get(f"/admin/projects/{project['project_id']}/metrics")
    assert metrics.status_code == 200 and metrics.json()["requested"] == 0
    assert (await http.get("/dashboard")).status_code == 200
    assert "default-src 'self'" in (await http.get("/dashboard")).headers["Content-Security-Policy"]
    invalid = await http.post("/v1/challenges/nope/verify", json={"code": "private-123456"})
    assert invalid.status_code == 422 and "private-123456" not in invalid.text
    assert (await http.post("/admin/logout")).status_code == 200
    http.cookies.set("otpigeon_session", cookie)
    assert (await http.get("/admin/session")).status_code == 401


@pytest.mark.asyncio
async def test_body_limit_auth_rate_and_key_isolation(gateway):
    app, service, http, clock, project, issued, config = gateway
    service.config = replace(config, admin_token="operator-test-" + "x" * 40)
    response = await http.post("/admin/login", content="x" * (config.max_body_bytes + 1))
    assert response.status_code == 413
    for _ in range(10):
        assert (await http.post("/admin/login", json={"token": "incorrect"})).status_code == 401
    assert (await http.post("/admin/login", json={"token": "incorrect"})).status_code == 429
    assert (
        await http.get("/admin/projects", headers={"Authorization": "Bearer " + issued["api_key"]})
    ).status_code == 401


@pytest.mark.asyncio
async def test_list_is_chronological_paginated_scoped_and_expires(gateway):
    app, service, http, clock, project, issued, config = gateway
    ids = []
    for i in range(3):
        c = await create(http, destination=f"+1555555012{i}")
        ids.append(c.json()["challenge_id"])
        clock.advance(1)
    first = await http.get("/v1/challenges", params={"limit": 2})
    assert [c["challenge_id"] for c in first.json()["items"]] == ids[::-1][:2]
    second = await http.get("/v1/challenges", params={"limit": 2, "before": first.json()["next_cursor"]})
    assert [c["challenge_id"] for c in second.json()["items"]] == ids[:1]
    assert (await http.get("/v1/challenges", params={"before": "!invalid!"})).status_code == 400
    clock.advance(301)
    pending = (await http.get("/v1/challenges", params={"status": "pending"})).json()
    expired = (await http.get("/v1/challenges", params={"status": "expired"})).json()
    assert not pending["items"] and len(expired["items"]) == 3
    assert all(c["status"] == "expired" for c in expired["items"])


@pytest.mark.asyncio
async def test_dashboard_mock_worker_and_metrics(gateway):
    app, service, http, clock, project, issued, config = gateway
    token = "operator-test-" + "x" * 40
    service.config = replace(config, admin_token=token, dispatch_mock=True)
    login = await http.post("/admin/login", json={"token": token})
    http.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    prefix = "/admin/projects/" + project["project_id"]
    challenge = await http.post(prefix + "/test-challenges", json={"destination": "+15555550123", "purpose": "signup"})
    assert challenge.status_code == 201
    cid = challenge.json()["challenge_id"]
    assert (await http.get(prefix + f"/test-challenges/{cid}/code")).status_code == 404
    assert await Worker(service).run_once()
    code = (await http.get(prefix + f"/test-challenges/{cid}/code")).json()["code"]
    verified = await http.post(prefix + f"/test-challenges/{cid}/verify", json={"code": code})
    assert verified.json()["verified"] is True
    assert (await http.get(prefix + "/metrics")).json()["verified"] == 1
    keys = (await http.get(prefix + "/keys")).json()["items"]
    assert len(keys) == 1  # internal dashboard identity is never listed as an application key
    events = (await http.get(prefix + "/events")).json()["items"]
    assert all("code" not in event and "generation" in event for event in events)

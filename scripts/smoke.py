"""Explicit local test flow. Creates a fictional project; never sends a provider message."""

import json
import os
import time
from pathlib import Path
from uuid import uuid4

import httpx


def main():
    token = os.environ.get("OTPIGEON_SMOKE_TOKEN")
    if not token:
        # Only the local development environment file, not an application key.
        token = dict(line.split("=", 1) for line in Path(".env").read_text().splitlines() if "=" in line).get(
            "OTPIGEON_ADMIN_TOKEN"
        )
    if not token:
        raise SystemExit("Set OTPIGEON_SMOKE_TOKEN or initialize the local .env")
    with httpx.Client(base_url=os.environ.get("OTPIGEON_BASE_URL", "http://localhost:8000"), timeout=30) as client:
        login = client.post("/admin/login", json={"token": token})
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        project = client.post("/admin/projects", json={"name": "Disposable release smoke " + uuid4().hex[:8]})
        project.raise_for_status()
        pid = project.json()["project_id"]
        issued = client.post(f"/admin/projects/{pid}/keys", json={"environment": "test"})
        issued.raise_for_status()
        client.headers["Authorization"] = "Bearer " + issued.json()["api_key"]
        created = client.post(
            "/v1/challenges",
            json={"destination": "+15555550123", "purpose": "signup"},
            headers={"Idempotency-Key": uuid4().hex},
        )
        created.raise_for_status()
        cid = created.json()["challenge_id"]
        for _ in range(100):
            received = client.get("/v1/test/outbox", params={"challenge_id": cid})
            if received.status_code != 404:
                break
            time.sleep(0.1)
        received.raise_for_status()
        verified = client.post(f"/v1/challenges/{cid}/verify", json={"code": received.json()["code"]})
        verified.raise_for_status()
        assert verified.json()["verified"] is True
        assert (
            client.post(f"/v1/challenges/{cid}/verify", json={"code": received.json()["code"]}).json()["verified"]
            is False
        )
        print(
            json.dumps(
                {"project_id": pid, "challenge_id": cid, "verified": True, "single_use": True, "simulated": True}
            )
        )
        client.post("/admin/logout").raise_for_status()


if __name__ == "__main__":
    main()

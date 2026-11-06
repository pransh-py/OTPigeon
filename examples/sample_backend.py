"""A server-side integration demo. The application, not OTPigeon, owns sessions."""

import json
import os
import secrets
import time
from uuid import uuid4

import httpx


def main():
    key = os.environ.get("OTPIGEON_API_KEY", "")
    if not key.startswith("otpg_test_"):
        raise SystemExit("Set OTPIGEON_API_KEY to your project's test key")
    destination, purpose = "+12025550123", "login"
    with httpx.Client(
        base_url=os.environ.get("OTPIGEON_BASE_URL", "http://127.0.0.1:8000"),
        headers={"Authorization": "Bearer " + key},
        timeout=15,
    ) as client:
        created = client.post(
            "/v1/challenges",
            json={"destination": destination, "purpose": purpose},
            headers={"Idempotency-Key": uuid4().hex},
        )
        created.raise_for_status()
        challenge = created.json()
        cid = challenge["challenge_id"]
        for _ in range(100):
            received = client.get("/v1/test/outbox", params={"challenge_id": cid})
            if received.status_code != 404:
                break
            time.sleep(0.1)
        received.raise_for_status()
        verified = client.post(f"/v1/challenges/{cid}/verify", json={"code": received.json()["code"]})
        verified.raise_for_status()
        result = verified.json()
        expected = {
            "challenge_id": cid,
            "project_id": challenge["project_id"],
            "environment": "test",
            "destination": destination,
            "purpose": purpose,
        }
        if not result["verified"] or any(result[k] != v for k, v in expected.items()):
            raise SystemExit("Verification did not match the application's pending flow")
        # A real backend binds this to its own pending user/flow and persists a session.
        session = {"user_id": "fictional-demo-user", "session_id": secrets.token_urlsafe(24)}
        events = client.get(f"/v1/challenges/{cid}/events")
        events.raise_for_status()
        print(
            json.dumps(
                {
                    "challenge_id": cid,
                    "status": result["status"],
                    "simulated": True,
                    "application_session_created": bool(session),
                    "events": [e["type"] for e in events.json()["items"]],
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()

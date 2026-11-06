"""Official provider HTTP contracts. No provider I/O runs in a DB transaction."""

import math
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class Outcome:
    status: str
    reason: str | None = None
    message_id: str | None = None
    retry_after: int = 0


async def send(client, config, job, challenge, code, public_url, timeout, expires_in):
    provider = config["provider"]
    if provider == "mock":
        return Outcome("provider_accepted", message_id="mock_" + job["_id"])
    try:
        if provider == "twilio_sms":
            response = await client.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{config['account_sid']}/Messages.json",
                auth=(config["account_sid"], config["auth_token"]),
                data={
                    "To": challenge["destination"],
                    "From": config["from_number"],
                    "Body": f"Your verification code is {code}. It expires in {max(1, math.ceil(expires_in))} seconds.",
                    "ValidityPeriod": str(min(36000, max(1, math.ceil(expires_in)))),
                    "StatusCallback": f"{public_url.rstrip('/')}/webhooks/twilio/{job['_id']}",
                },
                timeout=timeout,
            )
        else:
            response = await client.post(
                f"https://graph.facebook.com/{config['api_version']}/{config['phone_number_id']}/messages",
                headers={"Authorization": "Bearer " + config["access_token"]},
                json={
                    "messaging_product": "whatsapp",
                    "recipient_type": "individual",
                    "to": challenge["destination"].lstrip("+"),
                    "type": "template",
                    "biz_opaque_callback_data": job["_id"],
                    "template": {
                        "name": config["template_name"],
                        "language": {"code": config["language"]},
                        "components": [
                            {"type": "body", "parameters": [{"type": "text", "text": code}]},
                            {
                                "type": "button",
                                "sub_type": "url",
                                "index": "0",
                                "parameters": [{"type": "text", "text": code}],
                            },
                        ],
                    },
                },
                timeout=timeout,
            )
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        return Outcome("retry", "provider_unreachable", retry_after=2)
    except httpx.RequestError:
        return Outcome("unknown", "provider_timeout")
    if response.status_code == 429:
        raw = response.headers.get("Retry-After", "2")
        delay = min(3600, max(1, int(raw))) if raw.isdigit() else 2
        return Outcome("retry", "provider_rate_limited", retry_after=delay)
    if response.status_code >= 500:
        return Outcome("unknown", "provider_error")
    if response.status_code >= 400:
        return Outcome(
            "provider_failed", "provider_auth_rejected" if response.status_code in (401, 403) else "provider_rejected"
        )
    try:
        data = response.json()
        message_id = data["sid"] if provider == "twilio_sms" else data["messages"][0]["id"]
        if not isinstance(message_id, str) or not 1 <= len(message_id) <= 512:
            raise ValueError("Invalid message identifier")
        return Outcome("provider_accepted", message_id=message_id)
    except (ValueError, KeyError, IndexError, TypeError):
        return Outcome("unknown", "invalid_provider_response")

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateChallenge(StrictBody):
    destination: str = Field(pattern=r"^\+[1-9][0-9]{7,14}$")
    purpose: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")


class VerifyChallenge(StrictBody):
    code: str = Field(strict=True, pattern=r"^[0-9]{6}$")


class ResendChallenge(StrictBody):
    pass


EventType = Literal["requested", "provider_accepted", "provider_failed", "provider_unknown",
                    "verify_failed", "verified", "expired", "superseded", "locked", "rate_limited"]


class Delivery(BaseModel):
    status: Literal["not_attempted", "provider_accepted", "provider_failed", "unknown"]
    provider: str
    simulated: bool
    reason: str | None


class ChallengeResponse(BaseModel):
    challenge_id: str
    project_id: str
    environment: Literal["test", "live"]
    destination: str
    purpose: str
    status: Literal["pending", "verified", "expired", "locked", "superseded"]
    delivery: Delivery
    expires_at: datetime
    resend_available_at: datetime
    attempts_remaining: int


class VerificationResponse(ChallengeResponse):
    verified: bool
    reason: Literal["verified", "already_verified", "invalid_code", "locked", "expired", "superseded"]


class Event(BaseModel):
    event_id: str
    project_id: str
    environment: Literal["test", "live"]
    sequence: int
    timestamp: datetime
    challenge_id: str | None
    type: EventType
    reason: str | None
    purpose: str | None
    provider: str | None
    simulated: bool
    destination: str


class EventPage(BaseModel):
    items: list[Event]
    next_cursor: int | None


class OutboxResponse(BaseModel):
    challenge_id: str
    environment: Literal["test"]
    simulated: Literal[True]
    code: str

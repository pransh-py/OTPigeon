# Gateway API and state reference

Version: 0.2.0rc1. See `/docs` and `/openapi.json` for generated request/response schemas.

## Authentication and isolation

Application calls use `Authorization: Bearer otpg_test_…` or `otpg_live_…`.
A key identifies one project and environment. Cross-project/environment lookups return 404.
Revocation is checked again inside the transaction. Live keys cannot read the test outbox.
The single-operator dashboard uses a separate token, revocable eight-hour HttpOnly session,
SameSite=Strict cookies, origin checks, CSRF tokens, and a shared database login limit.
It is an installation administrator, not a multi-user organization/RBAC system.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/v1/challenges` | `{destination, purpose}`; requires Idempotency-Key; 201 |
| GET | `/v1/challenges/{id}` | Current state; materializes expiry if necessary |
| GET | `/v1/challenges` | Newest first; optional status, before cursor, limit 1–100 |
| POST | `/v1/challenges/{id}/resend` | Empty body; new generation, same challenge ID; requires Idempotency-Key |
| POST | `/v1/challenges/{id}/verify` | `{code}` string of six ASCII digits; single-use result |
| GET | `/v1/challenges/{id}/events` | Ascending sequence, after and limit |
| GET | `/v1/events` | Scoped events; optional challenge_id, type, after, limit |
| GET | `/v1/test/outbox?challenge_id=…` | Test key only; pending, unexpired simulated code |
| GET | `/health` | Database connectivity/readiness and live-delivery mode |

Destinations use E.164 (`+` and 8–15 ASCII digits). Purpose is a lowercase identifier
with optional digits/underscores, up to 64 characters. Projects are created through
the operator dashboard or CLI. Provider credentials are installation-operator inputs,
never accepted in application challenge requests.

Errors have `{error: {code, message, …}}`. Validation errors return 422 with field locations
without echoing submitted values. A 503 storage error means the operation's result may be
uncertain; retry create/resend with the same idempotency key. Request bodies are limited to
64 KiB by default. No CORS policy is provided for putting application keys in public clients.

## Verification lifecycle

A challenge is `pending` until `verified`, `expired`, `locked`, or `superseded`.
A new create for the same destination/purpose supersedes the previous pending challenge,
subject to the destination cooldown and send budgets. Resend rotates the code generation,
resets the challenge's guess counter, and preserves the aggregate destination guess budget.
The previous code cannot verify the new generation. Attempts across workers and challenges
remain bounded by shared transaction-protected budgets.

Defaults: expiry 300 s, cooldown 60 s, five attempts/challenge, three resends/challenge,
five destination sends/hour, ten destination guesses/hour, 1,000 project sends/hour.
These are scoped by project and environment. A denied send does not consume send budget.
Use the public configuration variables in [operations](docs/operations.md) to tune them.

A successful consume returns `verified: true` once. Subsequent consumes return
`verified: false, reason: already_verified`. HTTP 200 does not by itself grant access.
Verification is independent of delivery: an accepted message is not evidence that the
recipient received it, and a delivered message is not evidence that its code was verified.

## Delivery lifecycle and jobs

Delivery moves through queued → sending → provider_accepted/provider_failed/unknown,
with `delivered` only from an authenticated provider receipt. Test simulation is explicitly
marked and cannot claim confirmed delivery. Inline test dispatch remains available for
embedded tests (`OTPIGEON_DISPATCH_MOCK=false`); Compose uses the durable worker path.

Challenge + generation + encrypted delivery payload are inserted in one majority-committed
MongoDB transaction. Network calls happen after that transaction. A reserved (`leased`)
job can be reclaimed after its lease expires. A `sending` job is never blindly reclaimed:
a dead worker or uncertain network result records unknown. Known pre-send connection
failures and explicit 429 rejections get bounded retries with expiry checks. Server 5xx,
read/write/network uncertainty, malformed success responses, and dispatch-time crashes
are unknown, without automatic retry. Redirects and environment HTTP proxies are disabled.

The worker checks key revocation, current generation, expiry, provider revision, and live
opt-in immediately before dispatch. Cancellation cannot retract a request already in flight.
Provider rotations invalidate old queued jobs; immutable encrypted snapshots authenticate
late receipts for retained jobs. Receipts never consume/reopen verification challenges.
Receipt replays and backwards status changes do not append duplicate/downgrade events.

## Idempotency and history

Create/resend require 1–128 ASCII letters, numbers, `._:-`. Keys are project/environment/
operation/challenge scoped. Matching bodies replay the stored response for 24 hours;
a different body with the same key returns an idempotency conflict. A replay is the original
response snapshot; GET the challenge for current state. After 24 hours a key may be reused.

Event sequences are monotonically increasing within each project/environment, including
across API/worker replicas. Follow `next_cursor`; sequence gaps after retention are valid.
Challenge cursors order by creation time and ID. Filters see logically expired challenges.
Events mask destinations and contain reasons, provider, generation, timestamp, and simulated
flags. They contain no OTP, provider credentials, or raw provider error bodies.

The gateway retains full destinations in challenge records and encrypted provider snapshots
in jobs. Operators should schedule retention cleanup and apply their own privacy policy.
"Append-only" events describes normal runtime; retention explicitly deletes old history.

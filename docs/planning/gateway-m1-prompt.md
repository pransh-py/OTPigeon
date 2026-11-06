# OTPigeon: first gateway milestone

Use GPT-6.1 Sol (`gpt-6.1-sol`) for planning, orchestration, implementation, diagnosis, and final review. Work in `the repository root` as the single active Codex implementation session.

## Authorization and workflow

- Read the project's `AGENTS.md`. This project's model preference overrides the general Opus-directed development preference. Do not invoke Claude CLI or the Opus-directed-development skill.
- Do not spawn additional workers or nested agents unless the user explicitly requests them.
- First inspect the current repository status and relevant code, then state a bounded implementation plan grounded in what actually exists. The assessment in `docs/planning/current-status.md` is a starting point; verify it against the current checkout.
- Implement M1 below. Work through the complete local developer journey, correct material issues found during verification, and review the actual final diff and evidence yourself.
- During final review, inspect the base/HEAD revisions, full diff, relevant untracked files, affected critical paths, reproduction/replay/test logs, and relevant images. Record a self-review verdict tied to the exact diff fingerprint, with coverage gaps. Re-review changed code or evidence.
- **Delivery authorization updated October 11, 2026:** implement this milestone, commit and push a project branch, and open a GitHub PR. Merge, deployment, paid resources, provider signups, WhatsApp/SMS account linking, and live messages remain outside the request.
- This prompt defines future implementation work. Preparing the prompt has not implemented or validated M1.
- Do not invoke educational Manware skills. M1 has no UI. If a later phase adds one, read `~/.codex/skills/design-taste-frontend/SKILL.md` and inspect it yourself on desktop and mobile.

## Product purpose (settled by the user)

OTPigeon is a self-hostable verification gateway for small app teams. Developers connect their own messaging provider, call one API from their backend, and can see exactly what happened to each verification.

OTPigeon verifies phone possession. It is not an identity or session provider: the developer's application creates its own accounts and sessions.

Intended developer journey:
1. Self-host.
2. Create a project with test and live environments.
3. Configure the project's own provider.
4. Keep API keys on their backend.
5. Create a challenge scoped to a destination and purpose.
6. Submit the code through their backend.
7. Create their own session.
8. Inspect the event timeline.

The accepted roadmap also includes an operator dashboard, a small server SDK, official WhatsApp and one SMS provider (a second real adapter proving providers are swappable), and delivery receipts. These are **later milestones, not dropped requirements**. M1 must not claim them.

## Current state (source-only analysis)

- **Inspected base revision:** `313734d72e6f77513bce6d72fd4e4695f1cab62c`. The tree was clean when assessed; planning documents have since been added. Recheck the working tree before implementation.
- **Checks run so far:** Python parse checks and `node --check` only. No runtime behavior, MongoDB behavior or WhatsApp delivery has been reproduced this session.
- **Earlier validation:** the docs say local backend validation happened earlier. There is no current evidence of that; do not treat it as either proven or disproven.

Existing stack:
- FastAPI, Pydantic and Motor/MongoDB, with pinned dependencies in `backend/requirements.txt`.
- A Node Express plus whatsapp-web.js sender in `whatsapp-sender/`.

Reusable pieces:
- Code generation with `secrets` and comparison with `hmac.compare_digest`: `backend/app/otp_service.py:70,247`
- E.164 validation: `backend/app/schemas.py:44`
- The `OtpSender` boundary: `backend/app/senders/base.py`
- The mock sender: `backend/app/senders/mock_sender.py`

Gaps found by reading the source. The access-control and data-model observations are visible in source; race conditions and delivery behavior require runtime reproduction:
1. **No authentication anywhere in the backend.** All routes are open in `backend/app/main.py:200-365`, including sending, QR retrieval and logout. Callers choose `sender_phone`.
2. **Unauthenticated sender status.** Node `GET /status` (`whatsapp-sender/src/index.js:120`) has no key check and returns sender state including QR payloads (`senderManager.js:161,187-196`).
3. **Network exposure and a public fallback key.** The Node service binds all interfaces (`index.js:529`), and both services fall back to the public dev key (`backend/app/config.py:120`, `index.js:88`).
4. **No scoping by project, environment or purpose.** There is one global record per phone (`backend/app/otp_store.py:77`). Verify returns a bare `verified` (`main.py:355-365`).
5. **Likely races:**
   - Read-then-upsert on request: `otp_service.py:139,175`
   - Check-then-increment on attempts: `:231-257`
   - Delete after compare, which may allow double verification: `:261`
6. **Defenses reset too easily.** Each new code resets attempts (`otp_store.py:137`), and throttling returns HTTP 200 (`otp_service.py:163`).
7. **No event history.** Records are deleted on success, expiry or lockout, and by TTL.
8. **Misleading delivery outcomes.**
   - Node's `sent: true` only means the message was accepted, and the backend discards the provider response (`whatsapp_http_sender.py:178-197`).
   - A timeout deletes the record even though the message may still arrive (`:216-229`, `otp_service.py:198`).
9. **No one-command setup, tests, Compose file, SDK or sample client.** The docs still describe a Flutter POC.

## M1 scope

The gateway product direction and developer journey are settled by the user. M1's API-only boundary and the implementation choices below are recommended defaults for the first bounded slice: project isolation, API keys, a scoped challenge API, mock delivery, basic event history and a local developer journey. Adopt them unless evidence contradicts them, and record any deviation with its reason.

1. **Bootstrap with a local admin command only**
   - Provide separate `python -m app.admin` subcommands for creating a project, issuing a key for a specified environment, listing key metadata, and revoking a key. They must be runnable through `docker compose exec`; do not show secrets in key listings.
   - No unauthenticated HTTP admin API.
   - Keys:
     - Bound to project and environment, with prefixes like `otpg_test_…`.
     - Stored only as hashes and shown once.
     - Sent as `Authorization: Bearer`.
     - Never logged.
2. **Provider configuration per project and environment**
   - `test` may use only the mock provider. `live` delivery is disabled in M1.
   - A live create returns a typed `live_delivery_disabled`/`provider_not_configured` error. It generates no code and sends nothing.
3. **Endpoints, all scoped to the caller's key**
   - `POST /v1/challenges` with `{destination, purpose}`.
   - `GET /v1/challenges/{id}`.
   - `POST /v1/challenges/{id}/resend`.
   - `POST /v1/challenges/{id}/verify` with `{code}`.
   - `GET /v1/challenges/{id}/events` and `GET /v1/events`, filterable and paginated.
   - Event history is API-only; the dashboard comes later.
   - A challenge from another project or environment returns 404.
4. **Response context**
   - Every challenge response includes: `challenge_id`, `project_id`, `environment`, `purpose`, `destination`, `status`, a separate `delivery` object (`status`, `provider`, `simulated`), `expires_at`, `resend_available_at` and `attempts_remaining`.
   - Verify returns `verified`, a reason enum and that same context, so the caller's backend can bind the result to its own user and flow.
5. **Separate challenge and delivery states**
   - Challenge status: `pending|verified|expired|locked|superseded`.
   - Delivery status: `not_attempted|provider_accepted|provider_failed|unknown`.
   - M1 never emits `delivered`, because no provider gives confirming evidence.
   - Mock results are always `simulated: true` with `environment: test`, so a test result can never look like a live one.
6. **Append-only events**
   - Types: `requested`, `provider_accepted`, `provider_failed`, `provider_unknown`, `verify_failed`, `verified`, `expired`, `superseded`, `locked`, `rate_limited`.
   - Events include timestamp, challenge, environment, provider, `simulated` flag, a masked destination and a reason.
   - Events never contain codes, keys or secrets. Challenge records are retained; there is no TTL deletion.
7. **Test outbox**
   - `GET /v1/test/outbox?challenge_id=` returns the simulated code only to a test key of the owning project.
   - It is inaccessible with live keys, and only the mock provider writes to it.
   - Logs never contain codes.
8. **Code hashing**
   - Hash codes with HMAC using a required server secret.
   - Startup fails if the secret is missing or still the placeholder value.
   - A local init script may generate an ignored `.env` file but must never overwrite one.
9. **Quarantine the legacy paths**
   - Do not mount `/otp/*`, `/set-sender` or `/senders*` by default or in Compose. Enable them only with an explicit flag plus a required admin token that has no default. Project keys never authorize them.
   - Node sender changes:
     - Remove the public key fallback (refuse to start without a key).
     - Default to binding `127.0.0.1`.
     - Require the key on `/status`.
   - Preserve all other code and session data. Do not refactor or delete gratuitously.
   - If real existing clients turn up, preserve their contracts and record the compatibility decision.
10. **Docker Compose**
    - Services: the API and a separate Mongo. Pin supported runtime and image versions, and verify that the pinned Python dependencies install on the chosen version.
    - Use a uniquely named Mongo volume. Do not publish Mongo to the host by default, and bind the API to `127.0.0.1`.
    - Update `README.md`, `DOCUMENTATION.md` and the `.env.example` files with OTPigeon setup, limitations and the verification record. A tracked `.local/` ignore rule may be added.
11. **Sample backend script**
    - Flow: create a test challenge, read the outbox, verify, then create a stand-in local session.
    - Use valid fictional fixtures such as `+12025550123`. Never use a real sender or recipient.

Out of scope for M1:
- Dashboard UI, published SDK and real providers
- Delivery receipts and webhooks
- Live sending
- Multiple users, billing, enterprise or identity features
- Public production hardening

## Required semantics and acceptance criteria

- **Isolation.** Keys from another project or the other environment cannot read, verify, resend, list events for, or read the outbox of a challenge. Revoked keys fail.
- **One active challenge per scope.** At most one `pending` challenge per (project, env, destination, purpose).
  - Creating within the cooldown returns 429 with `retry_after`.
  - Creating after the cooldown supersedes the old challenge and emits an event.
- **Per-challenge limits (configurable defaults).** 300 s expiry, 60 s resend cooldown, 3 resends and 5 verify attempts. A resend invalidates the previous code. Expiry is enforced on every read and verify.
- **Budgets across challenges.** Superseding a challenge or creating a new one must not reset defenses. Keep durable rolling budgets:
  - Per (project, env, destination): for example 5 sends per hour and 10 failed verifies per hour.
  - Per (project, env): a send cap.
  - When exceeded, return 429 with an event, and do not compare codes.
  - Docs must say these limits make M1 suitable for local and test use only, not a public production gateway.
- **Idempotency.**
  - `Idempotency-Key` on create and resend: the same key with the same body replays the original response with no new send; the same key with a different body returns a conflict.
  - Idempotency records are scoped to project, environment, operation and resource (including challenge ID for resend) and retained for at least 24 hours. Concurrent retries cannot produce duplicate sends or events.
- **Atomic verification.**
  - N parallel correct verifies produce exactly one `verified: true`.
  - N parallel wrong guesses never exceed the attempt cap.
  - Parallel creates leave exactly one active challenge.
  - Verified, expired, locked or superseded challenges never verify.
  - Terminal states are immutable. Expiry transitions apply to pending challenges; emit each transition event exactly once. Late delivery updates cannot overwrite a verified/locked/expired/superseded challenge state.
- **Unknown send outcomes.**
  - On a provider timeout or ambiguous result, record `delivery.status=unknown` and a `provider_unknown` event. Keep the challenge verifiable until it expires, and allow a resend after the cooldown.
  - Never report this as accepted or delivered. Errors are typed and never leak internals.
- **Local journey.** On a clean machine, Compose plus the admin command plus the sample script complete the journey without touching pre-existing state.

## Verification

- **Test first.** Use pytest over HTTP contracts against a real disposable Mongo with a unique database or volume. Do not use storage mocks for the isolation, concurrency, idempotency, budget or expiry tests.
- **Fault injection.** A fault-injecting provider for failure and unknown outcomes may exist only in tests.
- **Driver migration (recommended, not required).** Migrating from Motor to PyMongo's native async API is advised.
  - First verify MongoDB's current official guidance and compatibility.
  - Primary guidance: https://www.mongodb.com/docs/languages/python/pymongo-driver/current/reference/migration/
  - Limit the change to the store layer, not an unrelated upgrade project.
  - If you do migrate, include driver-level concurrency and expiry evidence.
- **Before/after proof for backend defects.** For each fixed defect (likely candidates: gaps 1–2 and 5), do the following in isolated state:
  1. Reproduce the actual symptom, for example with a detached `git worktree` at the base revision plus a temporary Mongo dbpath or port.
  2. Capture a genuine redacted before picture together with the trigger, environment/version and raw log.
  3. Repair, replay the same trigger, run the relevant checks and capture the after picture.
  4. Post both pictures in this chat.
- **If reproduction fails,** disclose the attempts and what was missing. Never fabricate a baseline. Screenshots of new features must not be presented as reproduced backend failures.
- **Protect existing state.**
  - Preserve every existing MongoDB database, data directory and `.wwebjs_auth` session. Never create senders or link accounts.
  - Never run `docker compose down -v` or any cleanup against state you did not create.
  - Keep binary evidence in ignored `.local/evidence/otpigeon-m1/`.

## Final report

Report:
- Changed paths and the diff fingerprint.
- Tests actually run, with their output.
- Reproduction and replay results, including the before/after pictures.
- Your final self-review verdict, the fingerprint it applies to, and any coverage gaps. Do not describe it as an independent reviewer approval.
- Remaining gaps.

Open a GitHub PR after local verification and final review. Include the verification record and backend before/after evidence. Do not merge or deploy.

# OTPigeon pre-M1 assessment

Assessment date: October 11, 2026. Inspected application revision:
`313734d72e6f77513bce6d72fd4e4695f1cab62c`.

This is a source inspection, supplemented by syntax checks. Runtime API,
MongoDB, concurrency, and WhatsApp behavior were not reproduced in this task.
Earlier README claims about local validation are historical claims, not
verification results from this assessment.

## What exists

- FastAPI backend with Pydantic validation and Motor/MongoDB persistence.
- OTP request, resend, and verify routes, plus sender-management proxy routes.
- Six-digit codes generated with `secrets`, salted hashes, constant-time
  comparison, configurable expiry, cooldown, and attempt limits.
- An `OtpSender` interface, console mock, and HTTP WhatsApp adapter.
- Separate Express/whatsapp-web.js service with per-sender QR authentication
  and persisted WhatsApp sessions. This is third-party WhatsApp Web automation.
- Tracked environment example files and manual setup/testing documentation.

## Gaps visible in source

- FastAPI application routes have no API authentication dependency or middleware.
  Sender administration and OTP requests share the public application surface.
- Node `/status` lacks the shared-key middleware used on other sender routes.
  Status serialization includes sender QR state. Node also has a public fallback
  key and omits the host argument when listening.
- OTP records are keyed only by phone number. There are no projects,
  environments, purposes, challenge IDs, or scoped application API keys.
- Success, expiry, and lockout delete OTP records; a TTL index also deletes
  expired records. There is no durable verification timeline.
- The HTTP sender discards the successful provider response, including the
  message ID. Send exceptions cause OTP deletion, including ambiguous timeouts.
- The mock prints codes. Sender selection is a global setting.
- No automated tests, container setup, dashboard, SDK, or sample integration
  are tracked. The README's Flutter client is still planned.

## Risks that need runtime reproduction

Request uses separate read and upsert operations; verification separately reads,
checks attempts, compares a hash, then increments or deletes. Those paths may
allow concurrent sends, attempt-limit overruns, or multiple successful consumes.
These are hypotheses from source, not reproduced failures.

Creating a fresh code resets the attempt count, and cooldown returns a success
HTTP response containing a message. A failed HTTP send deletes the record even
when a timed-out message could later arrive. Reproduce the observable behavior
in disposable state before claiming these defects are fixed.

## Verification performed

- All backend Python modules passed AST parsing with Python 3.14.8.
- All five sender JavaScript files passed `node --check` with Node v26.5.0.
- These are syntax checks, not dependency-installation or behavior checks.
- Existing databases, environment files, and WhatsApp sessions were untouched.

## Recommended first milestone

Build a test-only gateway foundation: projects and hashed API keys, scoped
challenge IDs, atomic lifecycle rules, a privileged mock outbox, separate
verification/delivery states, append-only events, local Compose setup, and a
sample backend flow. Quarantine the unofficial sender behind explicit admin
configuration. Keep dashboard, SDK, real providers, and delivery receipts as
later milestones.

The product direction is user-approved. This bounded milestone is a proposed
implementation slice, not a claim that the product already has these features.
See `gateway-m1-prompt.md` for the complete implementation prompt.

## Project workflow

Use GPT-6.1 Sol for all working roles. The earlier Opus analysis and draft are
historical evidence in ignored local storage. The Opus final prompt review was
canceled when the user changed the project preference; it produced no approval.
This assessment predates implementation. M1 has since been implemented; see `../verification/m1.md` for actual reproduction, replay, and validation results. Git delivery is now authorized by the user.

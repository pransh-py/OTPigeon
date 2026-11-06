# Contributing

Use Python 3.12+ and Node.js 22+. Install `backend/requirements-dev.txt` and use a disposable
MongoDB replica set through OTPIGEON_TEST_MONGODB_URL. Tests intentionally fail rather than
skip database contracts when that variable is absent. Never point tests at production.

Run the checks in README.md. API/worker changes need meaningful transaction, race, expiry,
retry, and scoping coverage. Keep provider transports fake in automated checks; no paid sends,
account linking, or real contact data. For backend bug fixes, reproduce and record the actual
symptom in isolated state before repair, then replay it. Keep evidence binaries under ignored
`.local/` and record redacted results in `docs/verification/`.

Preserve API key/environment isolation, single consume, destination budgets across resends,
request idempotency, encrypted job payloads, lease fencing, and unknown outcome handling.
Network I/O must not run inside a MongoDB transaction. Never log credential or OTP values.

For dashboard changes inspect desktop/mobile layout, keyboard access, empty/error/loading
states, and secret handling. Use textContent/DOM construction for untrusted strings.
Use `codex/` branch prefixes for automated work. Keep PR descriptions focused on changed
behavior, evidence, limitations, and the actual revision. Publishing/merging is separate.

# International phone formatting — November 7, 2026

Baseline: `dace1b2d3e41141d24423036990eb143baafee5f`. Exact delivered revision and diff
fingerprint are recorded in the PR evidence comment.

## Requirement and diagnosis

The founder requested phone support across countries for the messaging package. Existing
code did not force India or prefix +91, but repeated eight-digit minimums rejected shorter
international plans. The [ITU-published Niue plan](https://www.ituob.org/issues/1148-en/)
includes four-digit PSTN numbers under +683. Its seven-digit international shape was rejected
by both gateway and sender input paths.

## Reproduction and repair

The actual baseline was run against a new native MongoDB replica set at localhost:28481,
with its own data directory under `.local/international-phone-lab/`. A random test database
and test API key were created and removed by the reproduction script. The Node sender ran
in a new temporary directory with a generated API secret and zero loaded WhatsApp sessions.
Existing environments, data directories and authentication sessions were preserved.

Trigger: submit the formatting fixture `+6834002` (no registration or assignment claim).

| Boundary | Before | After |
| --- | --- | --- |
| POST /v1/challenges | 422 invalid_request; no stored challenge | 201; exact destination preserved in MongoDB |
| POST /senders/normalize | 400 invalid_sender_phone | 200; senderId 6834002 |
| POST /send-otp with sender_id 6834002 | 400 invalid_sender_id | 404 sender_not_found, confirming syntax passed and no live session was loaded |

The canonical wire format is a plus sign followed by 2–15 ASCII digits, beginning with a
nonzero calling-code digit. No country, prefix, national length, or formatting cleanup is
inferred. This is syntax validation only: it does not establish that a number is assigned,
valid under its national plan, WhatsApp-registered, or deliverable. Country-specific parsing
of local numbers would require an explicitly supplied country and a separate metadata parser.

Python gateway, optional legacy models and configured SMS sender now share `otpigeon.phone`.
The Node sender uses the same contract, rejects trailing line terminators/Unicode digits,
and reuses the public validator for digits-only sender IDs. Lookup conversion removes only
the leading plus; significant zeros and country codes are preserved. The SDK forwards
international numbers unchanged. No new runtime dependency was added.

Changed paths: backend/otpigeon/phone.py, gateway/schemas.py, gateway/management.py,
legacy schemas.py, whatsapp-sender/src/phone.js, index.js, senderManager.js; shared fixtures,
Python/Node/SDK contracts and HTTP sender regression coverage; API/setup documentation.

## Verification

Before repair, new Python phone contracts failed on the shorter input shapes. Actual HTTP
results were captured before modifying production code, followed by the same trigger replay.
Final local results: **77 backend tests, 30 sender tests, 5 SDK tests passed**. Ruff lint and
format checks, Python wheel/sdist builds, twine metadata checks, and git diff checks passed.
The shared fixture set covers eight country examples, significant zeros, short/min/max wire
shapes, missing prefixes, numeric input, excess length, punctuation/whitespace, Unicode
digits/terminators and provider address suffixes. HTTP tests do not create browser sessions.

Evidence (ignored): `.local/evidence/international-phones-2026-11-07/` contains before/after
JSON and PNG captures, python-before.log, node-before.log, backend.log, sender.log, sdk.log,
lint.log, build.log and twine.log. The pictures render actual captured HTTP/database results,
not passing-test screenshots. Both images are posted in the chat and PR evidence comment.

Self-review covers all phone-entry patterns, sender-ID routing, lookup conversion, SDK
forwarding, schema/OpenAPI exposure and the actual diff/media. Live message delivery across
countries is not tested. General messaging-package connection mode remains a separate
pending design decision; this repair applies independently of that transport choice.

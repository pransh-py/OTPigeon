# OTPigeon

A self-hostable verification gateway for small app teams. Your backend creates a
scoped challenge, submits a code, and reads an event timeline. Your application
owns its users and sessions.

**The first milestone is test-only.** Delivery uses a simulated mock outbox.
Live keys cannot send messages. The original WhatsApp Web automation PoC is
preserved behind explicit operator configuration and is excluded from Compose.

## Start locally

Prerequisites: Docker with Compose and Python 3 for the environment initializer.
From the repository root:

```sh
./scripts/dev.sh
```

This generates a private `.env` only if none exists, gives this checkout a unique
Compose project/volume, builds the API, initializes a single-node MongoDB replica
set, and waits for readiness. The API binds to `127.0.0.1:8000`; MongoDB has no
published host port. Change `OTPIGEON_PORT` in `.env` if the port is already used.
Existing environment files, databases, and WhatsApp sessions are not replaced.

API documentation: <http://127.0.0.1:8000/docs>.

Create your application's project and issue a test key:

```sh
docker compose exec api python -m app.admin create-project --name "My application"
docker compose exec api python -m app.admin issue-key --project PROJECT_ID --environment test
```

Replace `PROJECT_ID` with the returned ID. The second command displays the key
once. Save it privately on your backend. Key listings contain metadata only:

```sh
docker compose exec api python -m app.admin list-keys --project PROJECT_ID
docker compose exec api python -m app.admin revoke-key --key KEY_ID
```

## Complete the developer flow

Read the test key into your terminal without putting it in shell history, then
run the included backend example:

```sh
read -r OTPIGEON_API_KEY
export OTPIGEON_API_KEY
docker compose exec -e OTPIGEON_API_KEY api python examples/sample_backend.py
unset OTPIGEON_API_KEY
```

Paste your key after `read` and press Enter. The example creates a challenge for
the fictional `+12025550123`, reads its simulated code from the test outbox,
verifies it, checks its project/destination/purpose context, creates a stand-in
application session, and prints the event types. It prints neither the key, the
code, nor the session token.

Real integrations put the API key on the application backend. The browser calls
that backend, which binds a challenge ID to its own pending user/flow. The test
outbox is for trusted development code; do not expose it to a browser.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/challenges` | Create from `destination` and `purpose` |
| `GET /v1/challenges/{id}` | Read state and timings |
| `POST /v1/challenges/{id}/resend` | Rotate the code, preserving the challenge |
| `POST /v1/challenges/{id}/verify` | Consume once using `{ "code": "123456" }` |
| `GET /v1/challenges/{id}/events` | Read the challenge timeline |
| `GET /v1/events` | Filter and paginate project/environment events |
| `GET /v1/test/outbox?challenge_id={id}` | Read a pending simulated code with its owner's test key |

All `/v1` endpoints require `Authorization: Bearer YOUR_KEY`. Create and resend
also require an `Idempotency-Key` for each logical operation. Retries of that
operation use the same key and body. Foreign project/environment challenges
return 404. Live creates return `live_delivery_disabled` without generating a code.

## What this milestone guarantees

- Projects and environment-scoped keys stored as hashes, with revocation.
- Challenge IDs scoped to project, environment, destination, and purpose.
- Database transactions enforce single consumption and bounded concurrent
  attempts, sends, cooldowns, and durable rolling budgets across API workers.
- Idempotent create/resend retries replay the original response for 24 hours.
- Separate verification/delivery states and append-only, masked event history.
- Expiry is enforced at request time; challenge history is retained.
- No `delivered` claim: mock acceptance is explicitly simulated.

The project/environment transaction gate favors correctness over throughput.
This milestone is for local and test use, **not public production deployment**.
There is no account system, production abuse protection, automated history
retention, official WhatsApp integration, or SMS integration yet.

## Verification

Install the backend development dependencies and point tests at an isolated
MongoDB replica set. Each fixture creates and removes only its own random database:

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
OTPIGEON_TEST_MONGODB_URL='mongodb://127.0.0.1:27017/?replicaSet=otpigeon_test' \
  .venv/bin/python -m pytest backend/tests -q
PUPPETEER_SKIP_DOWNLOAD=true npm ci --prefix whatsapp-sender
npm test --prefix whatsapp-sender
```

See [technical documentation](DOCUMENTATION.md), the
[verification record](docs/verification/m1.md), and the
[first-milestone prompt](docs/planning/gateway-m1-prompt.md).

## Next milestones

An operator dashboard, a server SDK, official WhatsApp and one SMS adapter, and
confirmed delivery receipts/webhooks. The current repository implements the
bounded test-only foundation, not those later features.

## Original WhatsApp Web PoC

The Node service uses `whatsapp-web.js` browser automation rather than the
paid official Meta messaging API. It remains experimental; reliability and
account-policy risks remain. The legacy API is off by default. If you deliberately
operate it, read the legacy section in [DOCUMENTATION.md](DOCUMENTATION.md).

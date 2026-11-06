# OTPigeon

A self-hostable verification gateway for small app teams. Connect a project's messaging provider, request a phone verification through one API, and follow its delivery and verification history.

**0.2.0rc1 — open-source release candidate.** Python server + bundled operator dashboard + server-side JavaScript SDK. MIT licensed. Registry packages and hosted services have not been published.

- Projects own their test/live keys and live provider configuration.
- Six-digit, single-use challenges are scoped to project, environment, destination, and purpose.
- Mock delivery for development; official Meta WhatsApp Cloud API and Twilio SMS adapters for live delivery.
- Transactional jobs, competing workers, lease recovery, bounded retries, signed delivery receipts, and masked event history.
- A dashboard for keys, providers, test flows, metrics, and challenge timelines.

Your application owns its users and sessions. A successful verification does not create an application account or log a user in automatically.

## Run locally

Requires Docker with Compose v2.24.4+ and Python 3.12+ for the environment generator.

```sh
git clone https://github.com/pransh-py/OTPigeon.git
cd OTPigeon
./scripts/dev.sh
```

Open [localhost:8000/dashboard](http://localhost:8000/dashboard). Sign in with `OTPIGEON_ADMIN_TOKEN` from the generated `.env`, create a project, and try a test verification. The worker delivers a simulated code to the project's test outbox. No external message is sent.

The script creates a private `.env` only when absent, and a project-scoped Docker volume. It preserves existing files, databases, and WhatsApp sessions. If upgrading an M1 installation, add a separate random `OTPIGEON_ADMIN_TOKEN` to its existing `.env`; restarting never generates or replaces your root secret. Do not run `down -v` on a deployment whose data you need.

## Install the Python application

Build and install from source (Python 3.12–3.13 are checked in CI):

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install .
otpigeon init
# Set MONGODB_URL in .env to your MongoDB replica set.
otpigeon serve
# In another terminal, with the same environment:
otpigeon worker
```

A MongoDB **replica set** is required, including for a single database node. Standalone MongoDB is rejected at startup. The Compose setup initializes one automatically. `otpigeon serve` binds localhost by default. Use a TLS reverse proxy and an authenticated external database for a shared installation.

CLI: `otpigeon --help`, `otpigeon admin --help`, `otpigeon worker --once`, and `otpigeon prune` (preview only; `--apply` deletes eligible retained history).

## Integrate from your backend

Issue a test key in the dashboard, or locally:

```sh
docker compose exec api otpigeon admin create-project --name 'My application'
docker compose exec api otpigeon admin issue-key --project PROJECT_ID --environment test
```

The key is displayed once; only its digest is stored. Build the dependency-free SDK tarball with `npm pack ./sdk --pack-destination .local`, then install that tarball in your Node.js 22+ backend. See [SDK documentation](sdk/README.md).

```js
import {OTPigeon} from 'otpigeon-sdk';
const gateway = new OTPigeon({
  baseUrl: 'http://localhost:8000',
  apiKey: process.env.OTPIGEON_API_KEY,
});
const challenge = await gateway.create(
  {destination: '+15555550123', purpose: 'signup'},
  {idempotencyKey: 'your-pending-login-attempt-id'},
);
// Bind challenge.challenge_id to your server-side pending login record.
const result = await gateway.verify(challenge.challenge_id, userSuppliedCode);
if (result.verified) {
  // Check destination/purpose/project against that pending record, then create your session.
}
```

`verified: false` is a normal HTTP 200 result for an unsuccessful verification; check the boolean. A consumed challenge cannot grant another session. Store the successful authentication result in your own flow so a lost HTTP response does not make the same challenge reusable.

Run the complete simulated developer flow:

```sh
export OTPIGEON_API_KEY='YOUR_TEST_KEY'
node examples/sdk-flow.mjs
# Or: python examples/sample_backend.py
```

Use stable idempotency keys when retrying create/resend after a network failure. The SDK never retries a mutation automatically. API keys belong on your backend, never in browser/mobile bundles. See [the API and state reference](DOCUMENTATION.md), interactive `/docs`, and `/openapi.json`.

## Enable real delivery

1. Open Delivery provider in the dashboard and configure the project's live provider.
2. Set `OTPIGEON_PUBLIC_BASE_URL` to the externally reachable HTTPS origin and `OTPIGEON_ALLOW_LIVE_DELIVERY=true` in the API and worker environments, then restart both.
3. Configure the provider's signed delivery callbacks, issue a live key, and perform a controlled delivery to a consenting recipient.

Meta requires your own approved authentication template, sender, supported Graph API version, and credentials. Twilio requires your own sender and credentials. OTPigeon is free software; provider charges, approvals, and account policies still apply. [Provider setup and callback contracts](docs/providers.md) explain the required fields. Live account linking and paid messages are never part of automated checks.

## Multiple API and worker processes

```sh
docker compose -f compose.yaml -f compose.distributed.yaml up --build -d --wait
```

This starts Nginx, two API instances, two workers, and the shared database. APIs keep no challenge/session state in process memory. MongoDB transactions serialize each project/environment's verification decisions; workers claim durable jobs with fencing tokens. A dead worker's reserved job can be reclaimed. A send interrupted after dispatch starts becomes **unknown**, preventing an automatic duplicate send. Confirmed receipts can resolve delivery later.

This Compose demonstration has a **single MongoDB node and one host**. Use an authenticated multi-node replica set across failure domains for database/host resilience. It does not promise exactly-once external delivery, unlimited per-project throughput, or cross-region active/active writes. [Architecture and operations](docs/operations.md) cover the boundaries and recovery steps.

## Verification and contribution

```sh
pip install -r backend/requirements-dev.txt
export OTPIGEON_TEST_MONGODB_URL='mongodb://127.0.0.1:27017/?replicaSet=YOUR_DISPOSABLE_SET'
python -m pytest backend/tests -q
ruff check backend/otpigeon backend/tests scripts
ruff format --check backend/otpigeon backend/tests scripts
npm ci --ignore-scripts --prefix sdk
npm test --prefix sdk
pip-audit -r backend/requirements.txt
python -m build
python -m twine check dist/*
```

Tests create random databases prefixed `otpigeon_test_` and remove only those databases. Use a separate test replica set. See [release verification](docs/verification/release-0.2.md), [contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md), and [release procedure](docs/releasing.md).

## Original proof of concept

The `whatsapp-sender/` WhatsApp Web automation and opt-in legacy Python routes are retained for historical experimentation. They are not the supported delivery path. The Node sender is excluded from server wheels, SDK tarballs, and containers; it has known upstream dependency advisories. Never share its browser-auth sessions between replicas. See [security limitations](SECURITY.md) before running it.

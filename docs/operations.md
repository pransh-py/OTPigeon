# Architecture and operations

```
Application backend / server SDK        Operator dashboard (same origin)
                  \                     /
                    TLS reverse proxy
                           |
                    Stateless API replicas
                           |
                  MongoDB replica set
         projects / keys / challenges / budgets / events
                   encrypted durable jobs
                           |
                 Competing dispatch workers
                    /                \
             Meta Cloud API       Twilio SMS
                    \                /
                    signed webhooks → API
```

MongoDB is authoritative. A project/environment gate serializes decisions so concurrent
requests cannot overspend budgets or consume a challenge twice. This deliberately bounds
per-project throughput. Different project/environments have separate gates. There is no
Redis/RabbitMQ requirement and no in-memory queue to lose on restart.

## Configuration

Environment files load from the working directory without overriding existing environment
variables. Never commit them. `otpigeon init` creates a mode-0600 `.env` exclusively.

| Variable | Default / purpose |
| --- | --- |
| MONGODB_URL | Local replica-set URI; set authenticated URI for production |
| MONGODB_DB_NAME | otpigeon_gateway |
| OTPIGEON_SECRET | Required generated secret, at least 32 characters |
| OTPIGEON_ADMIN_TOKEN | Separate generated secret; empty disables operator login |
| OTPIGEON_PUBLIC_BASE_URL | http://localhost:8000; HTTPS required for live sends |
| OTPIGEON_ALLOW_LIVE_DELIVERY | false |
| OTPIGEON_DISPATCH_MOCK | false in library; true in Compose |
| OTPIGEON_EXPIRY_SECONDS | 300 |
| OTPIGEON_COOLDOWN_SECONDS | 60 |
| OTPIGEON_MAX_ATTEMPTS / MAX_RESENDS | 5 / 3 (both with OTPIGEON_ prefix) |
| OTPIGEON_DESTINATION_SENDS_PER_HOUR | 5 |
| OTPIGEON_DESTINATION_GUESSES_PER_HOUR | 10 |
| OTPIGEON_PROJECT_SENDS_PER_HOUR | 1000 |
| OTPIGEON_WORKER_LEASE_SECONDS | 30, minimum 5 |
| OTPIGEON_WORKER_MAX_ATTEMPTS | 3 |
| OTPIGEON_HISTORY_RETENTION_DAYS | 30 |
| OTPIGEON_MAX_BODY_BYTES | 65536 |
| OTPIGEON_ENABLE_LEGACY | false; independent OTPIGEON_LEGACY_ADMIN_TOKEN required if enabled |

API/worker replicas must share the database, root secret, public origin, and policy values.
Boolean values must be exactly true/false (case-insensitive). Use synchronized host clocks.
Workers are separate processes; `otpigeon serve --workers 2` scales only HTTP handling.

## Local vs production topology

Compose binds only the API/proxy to localhost, leaves MongoDB unexposed, and runs non-root
read-only gateway containers. Its unauthenticated single-node MongoDB is intended for a
private local demonstration. Do not expose its network to untrusted workloads.

For production use a monitored authenticated multi-node MongoDB replica set, encrypted
transport, restricted database roles/network access, durable backups, TLS at the reverse
proxy, and private operator access. Configure the public origin exactly; reverse proxies
must preserve Host, callback paths, and queries. Uvicorn access logs and the example Nginx
access log are disabled because callback query strings can contain verification tokens.
Do not turn on body/header logging for credentials, OTPs, or webhook signatures.

The distributed Compose overlay demonstrates process failure tolerance, not host/database
high availability. Database election/network-partition/multi-region load tests require an
operator-owned infrastructure environment and are outside this local release evidence.

## Recovery and retention

- **API dies:** a healthy replica can serve the shared state. Retry create/resend with the
  same idempotency key when the response is lost. A verify result is single-use; your app
  must reconcile its own pending authentication flow rather than consume the code twice.
- **Worker dies while leased:** another worker reclaims after the lease. The old fencing
  token cannot begin dispatch.
- **Worker dies after sending starts:** job becomes unknown after its lease expires.
  Never reset it to queued blindly. A signed receipt can update delivery, including after
  verification/expiry, without altering the verification decision. Let a user explicitly
  request a new generation after cooldown if needed; it spends the usual budget.
- **Provider 429 / pre-send connection failure:** bounded retries, checked against expiry.
  Unknown/5xx/read/write outcomes are not retried automatically.
- **MongoDB unavailable:** API returns 503 for database operations and startup fails if
  transactions are unavailable. Workers need a supervisor (`restart: unless-stopped` in
  Compose); the durable jobs survive. No verification succeeds from a cache fallback.
- **Retention:** run `otpigeon prune` to preview, then `otpigeon prune --apply` from a
  scheduled maintenance job. It removes terminal challenges only after expiry + retention,
  their events/jobs/outbox, old budget records, and old unassociated events. Pending/in-flight
  work is preserved. Workers/read operations materialize pending expiry. TTL indexes remove
  outbox codes, idempotency snapshots, login buckets, operator sessions and stale heartbeats.

Back up the replica set with an operator-approved MongoDB backup tool and save the matching
root secret separately. Restore into an isolated environment with live sends disabled first.
Verify projects, configuration decryption, key authentication, and a mock flow before switching
traffic. Do not restore/replay already-dispatched jobs as queued. Backups and late receipts
retain personal data and encrypted credential snapshots; include them in your retention policy.

## Upgrading M1

Back up existing state and secrets, keep the same MongoDB DB name and root secret, stop
old application processes, install/build this revision, add a separate operator token, and
start API + worker. Index creation is idempotent. Existing test projects/keys/challenges
continue to work. The Python import namespace is now `otpigeon` instead of `app`; use the
`otpigeon` CLI instead of old `python -m app.admin` commands. Existing test history without
a generation field remains readable. New live jobs require newly configured providers.

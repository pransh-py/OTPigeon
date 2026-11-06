# Optional Node messaging gateway

The main product is `packages/otpigeon`, usable directly in a Node application.
The optional gateway wraps the same client for HTTP integrations in Python/Go/etc.
It is separate from the preserved Python verification gateway. Both may be deployed
independently; the Node messaging gateway does not require Python or MongoDB.

## Start a disposable mock deployment

```sh
npm ci --prefix packages/otpigeon
node packages/otpigeon/examples/gateway.js
# Follow the printed commands to set generated test secrets, then run it again.
```

Keep `OTPIGEON_PROJECT_KEY`, `OTPIGEON_STORAGE_SECRET` and database path stable across
restarts. The example binds loopback and never connects to WhatsApp. To configure a
real account, supply a connected `MessagingClient` in a `live` project and explicitly
set `allowLiveDelivery: true`. Account linking/sends require operator authorization.
The example intentionally has no route that can create accounts, expose QR codes,
change provider credentials or delete saved sessions.

```js
import {createGateway, hashApiKey} from 'otpigeon/gateway';
const gateway = await createGateway({
  databasePath: '/persistent/private/otpigeon/messages.sqlite',
  storageSecret: process.env.OTPIGEON_STORAGE_SECRET,
  projects: [{id: 'orders', environment: 'test', keyHashes: [hashApiKey(projectKey)], client}],
  onError: error => console.error(error.code),
});
await gateway.listen({host: '127.0.0.1', port: 8080});
// On SIGINT/SIGTERM: await gateway.close()
```

The gateway owns its supplied clients and closes them on shutdown. Do not submit
untracked sends through the same client while the gateway owns it. Files must live
on persistent local disk; network filesystems and shared browser profiles are unsupported.
Mount a private writable volume and run as a non-root user with Chromium sandboxing.
Put TLS, ingress rate limits and network access control in front of a shared deployment.
The library does not silently weaken the browser sandbox or install OS packages.

## HTTP contract

Send `Authorization: Bearer otpg_test_...` (or a configured live key). Only SHA-256
key digests are retained by the gateway. Keys are project/environment scoped.

```sh
curl -sS http://127.0.0.1:8080/v1/messages \
  -H "Authorization: Bearer $OTPIGEON_PROJECT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1042-ready' \
  -d '{"kind":"text","to":"+447700900123","text":"Order #1042 is ready."}'
```

`202` returns `{id,status,providerId,reason,createdAt}` after durable admission.
Poll `GET /v1/messages/{id}` for the outcome. Reusing an idempotency key with the
same normalized message returns its existing record; a different message gives `409`.
Keys are scoped to the project/environment and retained with the job for seven days
by default. Pruning ends that replay guarantee. New request keys can duplicate
previous messages; no exactly-once promise spans SQLite and WhatsApp.

| Message | JSON fields |
| --- | --- |
| Text | `kind: "text"`, `to`, `text` |
| Image | `kind: "image"`, `to`, `data` (canonical base64), `mimeType`, `filename`, optional `caption` |
| Document | `kind: "document"`, same media fields |
| Reply | `kind: "reply"`, `eventId` (incoming event in this project), `text` |

The default HTTP media limit is 8 MiB, body limit 12 MiB. URL downloads and local
file paths are not accepted. `GET /v1/events?after=0&limit=50` returns ordered event
IDs and `nextCursor`. Persist the cursor; events can be pruned after retention.
Incoming events include upstream message ID, direct chat ID, text and media metadata.
Use the incoming event ID to create a reply; cross-project event references are rejected.
Events expose webhook status/attempts so an operator can detect exhausted delivery.

`GET /v1/connection` exposes the authenticated project's connection state, queued
count, in-flight flag and reconnect attempts. `GET /health` is unauthenticated and
reports degraded background storage/webhook errors without credentials or message
content. Provide `onError` for operational alerts. An error remains visible until
restart; investigate the cause first. Errors are sanitized structured JSON. Expected
responses include 400 validation, 401 unauthorized, 403 live disabled, 409 idempotency
conflict, 413 body too large, 415 content type, 429 admission saturation and 503 key
authority unavailable/shutdown. Limit: 32 active requests and 64 connections per owner.

## Dispatch, recovery and retention

Jobs transition `queued -> sending -> accepted|failed|unknown`; revoked/expired/disabled
jobs become `canceled`. Queued jobs expire after 24 hours. The gateway persists `sending`
before calling the client. Any record left sending after process death becomes `unknown`
on startup, even if the crash was just before the actual call. This conservative boundary
may require manual reconciliation; it prevents blind duplicate sends.

A disconnected client leaves jobs queued. Embedded disconnects reject waiting sends;
transport errors with known pre-send outcomes are failed. Ambiguous sends/timeouts are
unknown and are never automatically resubmitted. `accepted` is provider acceptance,
not delivery. Delivery evidence is an independently observed `message.delivery` event;
it can be absent, duplicated or arrive before the HTTP send result. Unknown late results
do not silently convert a previously uncertain job into safe-to-retry work.

Defaults: 1000 pending jobs per project, 10,000 retained jobs globally, 256 MiB encrypted
payload/event admission budget, and a bounded event count with terminal-event reserve.
These are application storage limits; filesystem/WAL/index overhead requires additional
disk headroom. Saturation fails admission. Call `gateway.prune()` in a scheduled operator
job to delete eligible terminal jobs and non-pending webhook events older than retention
(default seven days, configurable 1 minute–30 days). Pending sends/webhooks are preserved.
Back up the SQLite database and its encryption secret coherently using SQLite backup
or stop the owner before copying; protect the volume and backups as credentials.
Changing `storageSecret` without migration fails startup rather than erasing history.

## Existing project keys and verification

The Python gateway already hashes API keys with SHA-256. The Node gateway accepts those
same digests, mapped to the same project ID/environment. To inherit current revocation,
use `isKeyActive` against the authoritative key store on HTTP requests and before dispatch:

```js
import {mongoKeyAuthorizer} from 'otpigeon/gateway';
// `apiKeys` is the existing MongoDB driver's api_keys collection, opened by your host app.
const options = {
  // ...databasePath, storageSecret and projects configured above
  isKeyActive: mongoKeyAuthorizer(apiKeys),
};
```

This adapter uses `digest`, `project_id`, `environment`, `revoked_at: null` and returns
no raw key. The core package has no MongoDB dependency. The host supplies the driver,
TLS/auth connection and appropriately scoped read access. Outages fail closed, and queued
work stays queued. Without the hook, static digests are a separate authority; revocation
must use `gateway.revokeKey(digest)` and update the deployment configuration. Revocation
cannot recall an already dispatched message. No automatic migration or DB writes are made
to the original verification collections. Existing Python challenges, official providers,
operator dashboard, worker fencing and `otpigeon-sdk` remain operational.

## Webhooks

Configure an operator-controlled `{url, secret}` on a project. HTTPS is required; loopback
HTTP is allowed only for tests. Each POST contains `{projectId,environment,id,timestamp,type,...}`.
Headers: `X-OTPigeon-Event-Id`, `X-OTPigeon-Timestamp` (Unix seconds) and
`X-OTPigeon-Signature: v1=<HMAC-SHA256(timestamp + '.' + rawBody)>`.

```js
import {verifyWebhook} from 'otpigeon/gateway';
if (!verifyWebhook({body: rawRequestBody, timestamp, signature, secret})) reject();
// Atomically deduplicate project/environment/event ID before applying application work.
```

The helper accepts a five-minute timestamp window. Store event IDs to prevent replay within
that window; signature verification alone is not deduplication. Delivery is at least once,
with up to ten attempts, a five-second timeout and bounded exponential delay. Redirects
are rejected. A restart may repeat the same event ID. Delivery can be out of order during
retry. Exhausted webhooks are visible in event polling and `onError`; polling remains the
recovery path. Incoming transport history is not replayed by OTPigeon after an offline gap.
Webhook destinations are trusted operator configuration; enforce outbound network policy
if this configuration becomes user-controlled. Keep webhook secrets separate from storage
and account credentials.

## Scaling safely

Scale across accounts: assign each session to one owner with private persistent storage,
partition projects/accounts between owners, and route API traffic consistently. Dispatch
runs independently per project; a slow account does not stall another account's queue.
A session has one serial send slot and bounded admission. Multiplying workers for the
same WhatsApp browser profile is unsafe and does not create throughput.

The Node SQLite gateway is intentionally one process per database on one host. Its OS-backed
ownership lock rejects competing processes and releases on process death; it does not
fence remote hosts or provide host-failure resilience. This is a beta scaling boundary,
not an HA deployment. The existing Python gateway remains the replicated-API/competing-job
worker implementation for verification; its single-node default MongoDB is also not HA.
A future shared messaging outbox must preserve durable admission, scoped idempotency,
claims/fencing, session ownership, authorization and unknown outcomes before multi-host
workers are supported. Measure queue age, dispatch latency, unknown outcomes, disconnects,
webhook exhaustion and event drops before changing concurrency or capacity limits.

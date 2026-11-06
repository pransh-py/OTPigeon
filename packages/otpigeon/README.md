# OTPigeon — embedded WhatsApp messaging

`0.3.0-beta.1` · Node.js 22.16+ (22/24 checked in CI) · MIT · server-side only.

Send text, images and documents; receive messages and reply from your Node application.
The embedded client needs no Python service, MongoDB, HTTP server or external queue.
The optional HTTP gateway adds local durable jobs, project keys and signed webhooks.

**Beta source release: not yet published to npm.** Build/install the tarball below.
QR account automation uses the unofficial `whatsapp-web.js` engine. It is not made,
authorized or endorsed by Meta/WhatsApp. Account blocking and upstream breakage are
possible. The optional engine has known dependency advisories; see the repository
[security policy](https://github.com/pransh-py/OTPigeon/blob/codex/gateway-m1/SECURITY.md).
Live-account delivery has not been verified in the automated lab.

## First message, without an account

From the repository root:

```sh
npm ci --prefix packages/otpigeon
npm pack ./packages/otpigeon --pack-destination .local
# In your own Node application:
npm install /absolute/path/to/OTPigeon/.local/otpigeon-0.3.0-beta.1.tgz
```

```js
import {MessagingClient} from 'otpigeon';
import {MockTransport} from 'otpigeon/testing';

const client = new MessagingClient({transport: new MockTransport()});
await client.connect();
try {
  console.log(await client.sendText({to: '+447700900123', text: 'Order #1042 is ready.'}));
  // {id, attemptId, to, status: 'accepted', simulated: true}
} finally {
  await client.close();
}
```

The mock never contacts WhatsApp. The onboarding target is <10 minutes on a clean
supported machine; external developer onboarding is tracked separately.

## Connect your own account

Install the optional engine and a QR renderer explicitly:

```sh
npm install whatsapp-web.js@1.34.7 qrcode-terminal
```

```js
import qrcode from 'qrcode-terminal';
import {MessagingClient} from 'otpigeon';

const client = new MessagingClient({
  sessionId: 'shop',
  sessionPath: '/persistent/private/otpigeon',
  maxPending: 100,
  minIntervalMs: 1000,
});
client.on('qr', qr => qrcode.generate(qr, {small: true}));
client.on('state', state => console.log(state.state));
client.on('handler_error', error => console.error(error.code));
await client.connect(); // resolves at ready, after QR linking if required
try {
  await client.sendText({to: '+12025550123', text: 'Your requested order update.'});
} finally {
  await client.close(); // preserves login; does not log out or delete credentials
}
```

Only link accounts you control and send to consenting recipients. This library cannot
bypass provider restrictions. Persistent disk and Chromium's system dependencies are
required; browser binaries may download when installing the engine. Chromium sandboxing
stays enabled. For a system browser, set `puppeteer.executablePath`. Never copy an active
profile between replicas. A local OS-backed SQLite lock enforces one owner per session;
no database service is required. Node 22 may print its built-in SQLite experimental warning.

`connect()` is idempotent while connecting/ready. States: `idle`, `connecting`, `qr`,
`authenticated`, `ready`, `disconnected`, `reconnecting`, `auth_failed`, `closing`, `closed`.
Transient disconnects trigger up to three reconnect attempts with bounded exponential delay;
authentication failure/logout require application action. `connectTimeoutMs` defaults to
120 seconds. A closed client is terminal; create a new instance with the same session ID/path
to restore a saved login. `close()` never silently releases ownership after a failed browser
shutdown. If startup hangs, close can time out while the adapter retains ownership until
initialization and cleanup finish. A late successful cleanup updates state to closed;
failed cleanup exposes `close_failed` without raw engine details. Investigate/terminate
the old owner before restarting.
The OS releases the local lock after process death; Chromium can still refuse an orphaned
active profile. These safeguards are not a multi-host lease or automatic failover system.

## Messages and replies

```js
await client.sendImage({to: '+39066982', data: imageBytes, mimeType: 'image/png', filename: 'order.png', caption: 'Your order'});
await client.sendDocument({to: '+6834002', data: pdfBytes, mimeType: 'application/pdf', filename: 'receipt.pdf'});
client.on('message', async message => {
  if (message.text.trim().toLowerCase() === 'status') await message.reply('Your order is being prepared.');
});
client.on('delivery', receipt => console.log(receipt.id, receipt.status));
```

Media accepts `Uint8Array`/`Buffer`, copied at admission. Default limit: 8 MiB, configurable
up to 20 MiB in embedded use. Images: JPEG/PNG/WebP; documents require a MIME type and plain
filename. Text limit: 4096 characters; captions: 1024. URL fetching and filesystem reads are
owned by your application. Incoming events expose metadata/text and `hasMedia`; automatic
media downloads, groups, broadcasts and historical replay are outside this beta contract.
Incoming text is bounded at 65,536 characters with an explicit `textTruncated` flag.
Replies support direct phone and LID chat identifiers supplied by incoming events.

Recipients use `+` plus the country calling code. No India default or fixed national length.
Validation checks wire format, not number assignment, WhatsApp registration or deliverability.

## Queues, errors and delivery evidence

One send runs at a time per client. `maxPending` bounds waiting requests; `minIntervalMs`
(default 250) controls time between dispatch starts. This is local backpressure, not a
promise of account safety or provider permission. Embedded queues are memory-only.
Disconnect/close rejects queued work as `NOT_READY` with `outcome: 'not_sent'`.

`accepted` means the transport returned a provider message ID. It does not mean delivered.
`delivery` events report observed server ACK/delivered/read/played/failed evidence.
Receipts can be missing, duplicated or out of order. They are not fabricated for missing evidence.

`MessagingError` has stable `code`, `outcome`, optional `messageId` (local attempt ID),
and `retryAfterMs`. Important codes: `INVALID_ARGUMENT`, `NOT_READY`, `QUEUE_FULL`,
`RECIPIENT_UNAVAILABLE`, `LOOKUP_FAILED`, `ENGINE_MISSING`, `SESSION_LOCKED`,
`CONNECT_TIMEOUT`, `AUTH_FAILED`, `SEND_UNKNOWN`, `CLOSE_TIMEOUT`, `CLOSE_FAILED`.

After dispatch starts, errors/timeouts are conservatively `SEND_UNKNOWN`. No send is
automatically retried. A timeout does not cancel browser work: the serial slot stays occupied
until the underlying send settles. Late success emits `late_result`; it does not rewrite a
previous unknown outcome. Reusing a fresh message/request can duplicate the original.
Application event handler failures emit `handler_error` without exposing raw provider errors.

## Optional HTTP gateway

Import `createGateway` and `hashApiKey` from `otpigeon/gateway`. Provide an explicitly
configured client for each project/environment, hashed keys, a persistent database path,
and a stable random `storageSecret` of at least 32 characters. `listen()` binds loopback
by default. It does not connect accounts for you. See the complete mock gateway example
and [gateway operations guide](https://github.com/pransh-py/OTPigeon/blob/codex/gateway-m1/docs/messaging-gateway.md).

```sh
node node_modules/otpigeon/examples/gateway.js
# It prints commands to generate persistent local test secrets on first invocation.
```

API: authenticated `POST /v1/messages` with `Idempotency-Key`; `GET /v1/messages/:id`,
`GET /v1/events?after=0&limit=50`, `GET /v1/connection`; unauthenticated `GET /health`.
The gateway returns `202` after durable admission. Messages progress through `queued`,
`sending`, `accepted`, `failed`, `canceled` or `unknown`. Same scoped key/body returns the
original message; changed body returns `409`. Retention defaults to seven days. Idempotency
is guaranteed only while that record is retained. Interrupted sending jobs become unknown
on restart; queued jobs remain queued and re-check key authorization before dispatch.

Test environments require simulated clients. Live delivery is disabled unless
`allowLiveDelivery: true`. Webhooks use HTTPS (loopback HTTP allowed for tests), stable
event IDs and timestamped HMAC-SHA256 signatures; delivery is at least once with bounded
retries. Use `verifyWebhook` on the raw body and deduplicate event IDs. Clients can poll
persisted events if a webhook exhausts its retries. Incoming events may be duplicated by
the upstream transport; use its message ID for application-level deduplication.

## Verification is optional

`MemoryVerification` from `otpigeon/verification` demonstrates scoped, single-use OTPs
with cryptographic random codes, HMAC comparison, expiry, cooldown and attempt limits.
It is bounded and memory-only: restart loses challenges; separate processes do not share
budgets. Your application must bind each challenge to its own pending flow and rate-limit
issuance/verification. The existing Python verification gateway remains the durable,
project-scoped option; its API and `otpigeon-sdk` package are preserved.

## Executable examples and checks

From this package directory, all examples default to mock:

```sh
node examples/order-notification.js
node examples/incoming-bot.js
node examples/otp-verification.js
npm test
npm run typecheck
npm run format:check
```

For an explicitly authorized real test, install the engine/renderer, set `OTPIGEON_TO`,
and pass `--live` to an example. No live send happens merely from importing the package.
The full source tests include process death, exclusive session ownership, ambiguous sends,
HTTP isolation/idempotency, key revocation and signed webhooks. Five independent beta
users and live QR/session restore are still external acceptance gates.

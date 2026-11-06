# Messaging npm beta verification — November 7, 2026

Primary source package: `packages/otpigeon`, `otpigeon@0.3.0-beta.1`.
The exact reviewed revision and diff SHA-256 are recorded in the PR review comment and
ignored `.local/evidence/messaging-beta/review.json`; embedding a hash in its own diff
would change that hash. Review is by the active implementation session, not independent.

## Phase gates completed locally

- Embedded text, images, documents, direct incoming messages/replies, typed API,
  strict international wire format, owned media buffers and no import-time startup.
- Explicit lifecycle, concurrent-connect handling, queue limits, bounded reconnect,
  auth/logout stop, graceful close, conservative timeout/late-result handling.
- Local OS-backed exclusive session ownership: a competing real child process is
  rejected; SIGKILL releases the ownership lock. Browser transport contract tests use
  an injected upstream client and never link an account.
- Optional HTTP gateway: encrypted jobs/events, project/environment/key isolation,
  concurrent idempotency, media validation, bounded admission, key revocation,
  queued/sending recovery, independently progressing accounts and signed webhooks.
- Original Python gateway key issued in a random isolated replica-set database:
  real Node MongoDB driver authorizes it, the first mock send succeeds, database
  revocation cancels the second queued job and subsequent HTTP access returns 401.
- Order notification, command/reply bot and single-use OTP verification examples.
  The optional memory helper is explicitly single-process and non-durable.

## Checks and evidence

- 30 messaging contract tests passed on Node 22.16.0 and Node 24.22.2 (also local 26.5.0).
- Source TypeScript consumer and formatting checks passed. Fresh tarball consumers
  checked exports, types, HTTP -> encrypted job -> mock dispatch -> accepted and all
  three examples, with no engine installed and no external services. Measured clean
  install/check duration was about one second locally, not an external-user study.
- 77 existing Python backend tests, 30 original sender checks and five verification SDK
  tests passed. Python lint/format, wheel/sdist builds and `twine check` passed.
- Core npm and supported Python dependency audits: zero known findings at check time.
  The separately installed optional browser engine has 16 upstream findings (five
  moderate, eleven high);
  inspect `engine-only-audit.json`. It is not a production-safety claim.
- Bounded workload: eight independent mock clients, 512 unique durable HTTP jobs,
  64 accepted sends per client, no duplicate dispatches. This is a local correctness
  workload, not WhatsApp throughput, many browser capacity, or multi-host HA proof.
- CI adds a dedicated Node 22/24 packaging/consumer matrix and retains Python/container
  regression jobs. Exact-head GitHub CI status is reported separately after pushing.

All raw evidence is under ignored `.local/evidence/messaging-beta/`: node22/node24
logs, `clean-install.json`, `mongo-key-bridge.json`, `mock-workload.json`, audit reports,
backend/SDK/sender regressions, package build logs and exact-diff review metadata.
Disposable MongoDB: port 28491, replica set `otpigeon_messaging_lab`, data/logs under
`.local/messaging-lab/`. Only random `otpigeon_test_*` fixture databases and this lab's
random bridge database were used; original state, environments and sessions are preserved.

## Genuine lifecycle reproduction and repair

Trigger: call `connect()` and immediately `close()` in the same tick, using a disposable
mock transport. Before the fix, the captured operation sequence was `transport.close`,
then `transport.connect`; the client reported closed while startup still occurred.
Root cause: connection startup was scheduled in a microtask without checking whether
close had invalidated the pending connection. Browser lease acquisition had a related
cancellation window before asynchronous ownership acquisition completed.

Changed paths: `src/client.js` checks the pending connection before starting;
`src/web.js` fences initialization with a generation assigned before asynchronous work.
Tests replay same-tick close and close during lease acquisition. The same operation
probe now captures only `transport.close`, zero transport startups and closed state.
The complete messaging contracts still pass.

Actual operation captures (no fabricated baseline or passing-test replacement):
`.local/evidence/messaging-beta/before.json`, `before.png`, `after.json`, `after.png`.
Binary images remain ignored; the pair is posted in the chat and authorized PR evidence.

## Invalid startup configuration reproduction

An additional final probe passed an invalid live client object to `createGateway`
with disposable storage. It threw a raw TypeError after opening SQLite; an immediate
attempt to reopen the same database failed with SESSION_LOCKED. Client capability
validation now runs before storage acquisition. The same trigger returns structured
INVALID_ARGUMENT and immediate ownership acquisition succeeds. A regression test
asserts both the error and the absence of the leaked lock. Actual captures:
`startup-before.json/png` and `startup-after.json/png` in the same ignored evidence folder.
The pair is also posted in the chat and PR evidence comment.

## CI artifact availability

The first green CI run exposed an upload warning: wildcard tarballs under `.local`
were excluded as hidden files. The upload steps now explicitly include hidden files
within their narrow artifact paths and fail if no files exist. These paths whitelist
only built archives and audit JSON, not environments, database files or browser sessions.
The original warning is captured in `ci-artifact-before.log`; final artifact availability
and clean installation from the downloaded archive are checked after the corrected run.

## Coverage and release gaps

No real QR account linking, saved-login restore against WhatsApp, live text/media delivery,
real incoming messages/receipts, account-blocking behavior or official-provider delivery
was performed. The unofficial engine's advisories remain unresolved. Five independent
beta developers: **0/5 verified**. No npm publication, release tag, merge or deployment.
The Node gateway is a single-host SQLite owner; session ownership does not provide a
remote lease or host-failure tolerance. Embedded queues and MemoryVerification do not
survive process death. Incoming upstream history is not durably replayed after offline gaps.
See operating docs for authorization, webhook deduplication, retention and scaling limits.

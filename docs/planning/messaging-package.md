# Messaging package implementation plan

Accepted November 7, 2026. Primary product: an embedded Node.js package with
TypeScript declarations. QR-linked WhatsApp Web is the first transport; it is
unofficial. No live account linking, live sends, registry publication, recruiting,
or deployment is included in local implementation or PR delivery.

## Phases and acceptance gates

1. Core: explicit lifecycle, text/images/documents, incoming messages/replies,
   international recipients, bounded serial queue, safe timeouts and stable errors.
   Gate: contract tests including concurrent connect/close, disconnect during sending,
   saturation, late results, and no automatic resend.
2. Sessions: lazy browser adapter, persistent LocalAuth, exclusive ownership,
   bounded reconnect, graceful close, mock transport. Gate: fake upstream tests and
   child-process ownership/crash checks. Real account behavior is a live-test gap.
3. Optional Node HTTP gateway over the same client: scoped hashed project keys,
   SQLite durable jobs/idempotency/events, signed outgoing webhooks, polling/status,
   recovery which cancels dispatch on revoked credentials and marks interrupted
   sends unknown. Gate: HTTP -> storage -> client -> event/webhook flow, isolation,
   restart, saturation, revocation and ambiguous-result replay.
   Reuse the Python gateway's key format and state boundaries; preserve its APIs.
4. Beta: order/bot/OTP examples, tarball clean install, TypeScript consumer checks,
   Node 22/24 CI, dependency reports, migration/operating docs, exact-diff review.
   Target first mock message <10 minutes. Five external developers are a success
   criterion, not a result we can claim from lab operation.

## Scaling contract

One owner per WhatsApp account/profile. Local ownership is fail-closed, not a
multi-host lease. Gateway SQLite is single-host. Scale across accounts by routing
consistently to isolated owners/volumes. Future shared outbox implementations must
preserve atomic claim, fencing, payload hashes, revocation and unknown outcomes.
Never promise exactly-once sends. Embedded queues are memory-only; durable work
requires the optional gateway. No automatic retry after uncertain dispatch.

## Status

All four local phase gates are implemented and exercised; see
`../verification/messaging-beta.md` for evidence and exact coverage. External acceptance
remains open: live QR/delivery/restore, npm publication and five real developer integrations.
The implementation is a source beta with the scaling boundaries above.

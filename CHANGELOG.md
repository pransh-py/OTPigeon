# Changelog

## 0.3.0-beta.1 — messaging npm package (source beta)

- Main `otpigeon` package: embedded text/images/documents, incoming direct messages and
  replies, TypeScript declarations, explicit lifecycle and an optional unofficial engine.
- Persistent local session configuration, exclusive ownership, bounded reconnect/queues,
  conservative unknown outcomes and no automatic resend after ambiguous dispatch.
- Optional Node HTTP gateway with encrypted SQLite jobs/events, scoped project keys,
  revocation integration, idempotency, restart recovery and signed durable webhooks.
- Optional memory-only verification helper and executable mock-first examples.
- Existing Python verification gateway and `otpigeon-sdk` APIs are preserved.
- No registry publication or live-account acceptance claim; see docs/beta-program.md.


## 0.2.0rc1 — 2026-11-06

- Installable Python server and CLI with bundled operator dashboard.
- Project-owned encrypted Meta WhatsApp and Twilio SMS configuration.
- Durable transactional jobs, fenced worker leases, safe retries and unknown outcomes.
- Signed correlated delivery receipts independent of verification decisions.
- Chronological challenge lists, generation-aware histories and operator metrics.
- Dependency-free JavaScript SDK with TypeScript declarations and complete test-flow examples.
- Local two-API/two-worker topology, retention maintenance and operational/release guides.
- Validation responses no longer echo submitted codes; server dependencies refreshed.
- International phone formatting now accepts shorter numbering plans, preserves country codes/significant zeros, and uses shared cross-language regression fixtures.
- Python import path changed from `app` to `otpigeon`; public v1 API retained.

## 0.1.0 — M1

- Project/environment keys, test-only challenges, idempotency, atomic consume and budgets,
  masked event history, simulated outbox, Compose and concurrency contracts.

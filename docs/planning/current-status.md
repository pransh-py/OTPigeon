# Current status — November 6, 2026

OTPigeon 0.2.0rc1 completes the planned first verification-gateway product scope.
It builds as a Python application with a bundled dashboard and a separate JavaScript SDK.
Projects own encrypted provider configuration; applications own their accounts and sessions.

The implementation includes test/live keys, scoped single-use challenges, transaction-safe
budgets/idempotency, durable dispatch, official Meta/Twilio adapters, signed receipts,
operator management, timeline/metrics, samples and multi-process deployment.
See [release verification](../verification/release-0.2.md) for measured results and limits,
[operations](../operations.md) for architecture/recovery, and [release procedure](../releasing.md)
for the explicit publication and live-account steps.

The earlier M1 prompt and verification remain historical records of the bounded test-only
milestone. The old WhatsApp Web sender is an unsupported experiment with documented upstream
advisories; it is excluded from supported server, SDK and container distributions.

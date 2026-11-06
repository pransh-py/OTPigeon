# Security policy

0.2.0rc1 is a release candidate. Report vulnerabilities privately through GitHub's
[security advisory reporting](https://github.com/pransh-py/OTPigeon/security/advisories/new)
when available. If private reporting is unavailable, open an issue asking for a private
contact without including exploit details, credentials, OTPs, or real-user data.

The new `otpigeon` 0.3.0-beta.1 npm package is a source-only messaging beta. Its
core/mock/gateway distribution has no mandatory runtime npm dependencies. The optional
`whatsapp-web.js@1.34.7` browser engine carries the same upstream dependency advisory
boundary as the original sender below; optional peer packaging does not resolve those
advisories when the engine is installed. Treat real-account transport as experimental.
It is unofficial and can break or cause account blocking. Do not advertise Meta endorsement.

The embedded client uses private local session files and an OS-backed exclusive lock.
The optional Node gateway uses AES-256-GCM for pending payloads/events, stores hashed
project keys, and rechecks external revocation when configured. Protect the volume and
storage secret; no automatic rotation/migration is provided. Unknown sends are never
blindly retried. Local SQLite ownership is not a multi-host lease. HTTP is loopback by
default; deploy shared use behind authenticated network/TLS controls. Configured webhook
destinations are trusted operator input. See docs/messaging-gateway.md for limits.
The memory-only OTP helper is for a single process; hosts own flow binding and rate limits.

Supported scope: installable Python gateway, bundled operator dashboard, server SDK,
and default/ distributed gateway container recipes. The operator dashboard is installation
administration; it provides no organization/RBAC separation. Never give an application
customer the installation token. Applications must bind challenge IDs to their own pending
flows, check purpose/destination/project/environment, and establish their own sessions.

Secrets: API keys are stored as digests. Pending live OTP payloads and provider credentials
are encrypted with a purpose-derived root key. Verification stores HMACs. The privileged
mock outbox intentionally contains raw test codes until expiry/consumption. Full destinations
and encrypted credential snapshots remain in retained records; use protected backups and
explicit history cleanup. Root-key rotation requires a migration/reconfiguration; merely
changing OTPIGEON_SECRET makes old ciphertext unreadable.

Known limitations:

- The original `whatsapp-sender/` experiment is unsupported for production and has **16
  known npm audit findings (5 moderate, 11 high) as checked November 6, 2026**, including an
  upstream archive-extraction dependency without a patched published version. Its packages
  are not included in the server wheel/sdist, SDK tarball, or gateway image. Its experimental
  LocalAuth/browser state must never be shared between replicas. Dependency updates removed
  the old critical advisory but did not make that separate experiment production-ready.
- Optional legacy Python routes remain disabled by default and require an independent
  administrator token. They are outside the public v1 gateway contract and release hardening.
- Local Compose is not a hardened production database deployment; it has one private,
  unauthenticated MongoDB node. Use an authenticated TLS replica set for shared environments.
- No exactly-once guarantee spans MongoDB and external providers. Uncertain sends are recorded
  as unknown. Delivery receipt authentication is tested with signed fixtures, not a live account.
- The coarse project/environment transaction gate prioritizes correctness over unbounded
  per-project throughput. Rate policies are application/project scoped, not a global anti-spam
  or distributed network abuse prevention service.

The release server dependency audit reported zero known findings at verification time.
This is a point-in-time result, not a guarantee against undiscovered or future vulnerabilities.

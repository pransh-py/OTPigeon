# OTPigeon 0.2.0rc1 release verification

Date: November 6, 2026. Baseline: `f54bd5af66aa2bc100c8112d714afd67ad566473`.
The exact delivered revision is the head of PR #1; its final review comment records that SHA.

Reviewed code/config/test source fingerprint (62 files, paths and content, SHA-256):
`c1d949dcb198c00eb1cb58c12e5bbb1c2c1029a95896e3123f55616e4dd41745`.
This excludes prose verification documents so the fingerprint can be recorded without recursion.
The ignored `fingerprints.json` records the file list and built artifact hashes. Installed wheel
contents were compared byte-for-byte with current package sources, with no differences.

## Completed scope

The M1 test-only API is now an installable application: operator dashboard, project-owned
encrypted live configuration, official Meta WhatsApp/Twilio SMS dispatch, transactional jobs,
fenced worker leases, bounded retries, unknown outcomes, signed correlated receipts,
chronological lists, metrics, retention CLI, typed server SDK, complete integration examples,
and a local multi-process topology. Python namespace is `otpigeon`. The experimental Web
sender remains isolated and is not part of the supported delivery path.

## Checks and evidence

All lab state was disposable. Native MongoDB ran at 127.0.0.1:28181 with a separate replica
set/data directory under `.local/release-lab/`. Backend tests create/drop only random fixture
databases. Containers used the explicit project `otpigeon-release-check`, a separate volume,
and localhost:28280. Wheel-install flows used another random database and localhost:28380.
Existing environments, MongoDB data directories, and WhatsApp authentication were preserved.

| Check | Result |
| --- | --- |
| Backend contracts | 48 passed on both Python 3.12 and 3.13 in GitHub CI; local consolidated and focused process/rotation checks also passed |
| SDK contracts | 4 passed; scope, idempotency, typed errors, network uncertainty, no automatic retries |
| Experimental sender regression | 1 passed without loading a WhatsApp session |
| Ruff lint / format | Passed |
| JavaScript syntax and TypeScript consumer | Passed; strict NodeNext consumer imported the installed SDK tarball |
| GitHub workflow lint | actionlint + ShellCheck passed |
| Python dependency audit | Zero known findings across the supported server dependency set |
| SDK audit | Zero runtime dependencies, zero findings |
| Container scan | Trivy: zero OS and Python findings in the final gateway image |
| Python build | Wheel and sdist built; twine metadata checks passed |
| Fresh wheel installation | CLI/assets verified; exclusive init preserved existing bytes and mode 0600; full request/worker/outbox/verify/single-use flow passed |
| Fresh SDK tarball installation | ESM import, strict declarations, complete mock flow and application-session demonstration passed |
| Artifact inspection | Packaged dashboard present; no .env, WhatsApp auth state, or experimental Node sender in the Python wheel / SDK tarball / gateway image |
| Multi-process operation | Nginx + two APIs + two workers; all services healthy |
| Concurrent create | 24 calls with one idempotency key → one challenge |
| Concurrent verify | 24 calls → one successful consume |
| API/worker failure | Stopped one API and one worker; ten health calls and another complete flow passed on survivors |
| Worker death boundaries | Real child processes killed after reservation and after simulated provider acceptance; recovery made exactly one simulated call, sending uncertainty never auto-requeued |
| Receipt contracts | Signed Meta/Twilio, replay/order, malformed/unsigned callbacks, late receipts, early receipt vs lost/429 response, verification-state independence passed |
| Dashboard operation | Login, project creation, test request/outbox/verify, timeline, one-time key display/revoke, fictional encrypted provider save, integration view inspected |
| Responsive/accessibility basics | Desktop and 390×844 mobile personally inspected; overflow repaired/replayed; no unlabeled visible inputs; native dialog focus/controls, semantic labels and no browser errors observed |

CI additionally runs the final suite on Python 3.12 and 3.13, Node 22, an AMD64 container
installation, full container smoke flow, and image vulnerability scan. Its actual result is
reported on the exact PR head; local checks alone are not represented as remote CI proof.

The first exact-head CI run passed both complete Python jobs and container setup/smoke.
Its scan export command rejected a bare 64-character Docker image ID. The workflow now
resolves the running container’s fully qualified Image reference before export; the same
export was replayed locally and actionlint passed. Final CI is rerun on the corrected revision.

## Actual before/after fixes

Evidence directory: `.local/evidence/release-2026-11-06/` (ignored, not committed).
Reports/screenshots contain only fictional fixture values and redacted results. Images are
renderings of captured HTTP/audit JSON, not fabricated terminal output or test-pass substitutes.
The before/after images are also posted in the current chat and authorized PR evidence comment.

**Submitted-code echo.** The archived baseline was run against a random disposable database.
`POST /v1/challenges/nonexistent/verify` with invalid `fictional-private-code` returned 422
and echoed the input in Pydantic's default error body. The release exception handler strips
input values. Replaying the same request returns 422 with field locations/messages and no
submitted code. Paths: `backend/otpigeon/main.py`, `backend/tests/test_dashboard.py`.
Images: `validation-before.png`, `validation-after.png`; raw reports: matching JSON names.

**Application dependency advisories.** Baseline pip-audit returned 16 advisory records
(including duplicated feed entries) across python-dotenv/Starlette; npm audit returned 23
findings in the separate experimental sender. Supported server dependencies were upgraded
and audited again: zero findings. A compatible legacy lock refresh reduced its separate
count to 16 (5 moderate, 11 high); unresolved upstream advisories are disclosed in SECURITY.md.
Paths: requirements files and experimental package-lock. Images:
`audit-before-summary.png`, `audit-after-summary.png`; raw `audit-before.json`,
`audit-after.json`, `node-audit-before.json`, `node-audit-after.json`.

**Container base/tooling.** Scanning the old Debian-based gateway image found 9 critical,
66 high, 159 medium, 119 low and 7 unknown OS findings, plus 5 Python tooling findings.
A pinned current Alpine base and removal of unused pip/build tooling produced zero OS/Python
findings. Both final APIs/workers were rebuilt and the same multi-process flow and failure
injection passed. Paths: backend/Dockerfile. Images: `container-before.png`,
`container-after.png`; raw scans: `container-trivy.json`, `container-trivy-final.json`.

Other evidence: `backend-final.log`, `process-final.log`, `sdk-final.log`, `legacy-tests.log`,
`lint-final.log`, `workflow-lint-final.log`, `sdk-types.log`, `twine-final.log`,
`fresh-wheel-flow.json`, `installed-sdk-flow.json`, `distributed.json`,
`dashboard-desktop.png`, `dashboard-mobile.png`. The Docker Scout attempt required Docker
login; Trivy independently completed the container scan without that account dependency.

## Review and remaining limits

Self-review inspected the actual diff and affected create/resend/consume transactions,
provider config revisions, worker claim/begin/finish/reap paths, signature/correlation paths,
operator auth/origin/CSRF/session revocation, encrypted storage, package boundaries, container
commands and media. Receipt precedence prevents an early confirmed receipt from being
requeued by a later uncertain/429 HTTP result. Revoked keys and stale provider revisions
cancel before dispatch; an already in-flight request cannot be retracted.

This is an open-source release candidate, not a claim of exhaustive production certification.
No real account was linked and no live/paid message was sent. Real provider account/template,
public HTTPS callbacks, recipient delivery, billing and consent need operator-owned staging
validation. Registry ownership/publication, GitHub release/tag, merging and deployment were
not performed. The local database is one node: MongoDB election/partition/host-loss and
multi-region operation are not proven here. There is no cross-provider exactly-once promise,
organization/RBAC system, or seamless root-secret rotation. The unsupported Web experiment
still has the disclosed 16 npm findings and is excluded from supported release artifacts.

# OTPigeon project instructions

## Model and working roles

Use GPT-6.1 Sol (`gpt-6.1-sol`) for planning, orchestration, implementation,
diagnosis, and final review in this project. The user's project-specific
instruction overrides the general Opus-directed development preference.
Do not invoke Claude CLI or the Opus-directed-development workflow here.

The active Codex session is the single implementation worker. Do not spawn
additional workers or nested agents unless the user explicitly requests them.
A written preference does not change the runtime model; never claim a model
switch without a supported control or verification.

## Scope and delivery

Read the current request and relevant code before acting. Keep the accepted
product direction: a self-hostable verification gateway for small app teams,
with project-owned provider configuration and observable verification flows.
Applications integrating it own their accounts and sessions.

Use meaningful, minimal test-first verification for substantive changes.
Inspect the actual diff, affected critical paths, test results, and relevant
images during final review. Report the exact revision/diff fingerprint and
coverage gaps. Re-review code or evidence changed after review.

Existing user authorization governs commits, pushes, PRs, deployment, and
external messages. A review verdict does not authorize those actions.

## Backend fix evidence

For every backend fix, reproduce the actual failure in isolated disposable
state and capture a genuine before picture. Repair it, replay the same trigger,
complete relevant verification, and capture an after picture. Post both in the
current chat with a short explanation; include them in a PR comment when PR
delivery is authorized.

Browser, API-client, terminal, or database-result screenshots are valid when
they visibly demonstrate the symptom or result. Redact secrets and real user
data. Never fabricate a baseline or substitute a passing-test screenshot for
the actual symptom. If reproduction is unavailable, record what was tried and
report the verification gap; do not claim an unreproduced fix is verified.

Keep binary evidence ignored. Record the trigger, root cause, changed paths,
replay/check results, and image references in relevant project verification
documents. Use code comments only for non-obvious reasoning.

Preserve existing MongoDB databases, data directories, environment files, and
WhatsApp authentication sessions. Use separate disposable lab state. Do not
link accounts or send live messages without authorization.

## Design and long work

Apply relevant design/taste skills and inspect desktop and mobile behavior
when implementing a UI. Preserve disabled educational-skill policies; do not
invoke Manware tutoring workflows unless the user requests them.

Keep at most one 15-minute heartbeat during genuinely long work. It follows
the existing session quietly and creates no workers or goals. Pause it on
completion, cancellation, or a user-only blocker.

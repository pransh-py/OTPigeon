# Messaging beta acceptance

Target: five independent developers complete an integration. Current external users:
**0/5 verified**. Local mock tests and CI do not count as developer adoption.
No outreach, live-account linking or public package publication was performed by the lab.

## Tester task

1. On Node 22.16+ or 24, install the source tarball in a fresh application.
2. Start a timer and send the first mock message using the package README.
3. Run the order, bot and OTP examples. Record confusing steps or error messages.
4. If separately authorized, use an owned test account and consenting recipient for QR
   linking, text/image/document delivery, inbound reply, clean restart and saved-session
   restore. Do not use a business-critical account for the unofficial transport beta.
5. Simulate a disconnect, observe status and reconnect, and confirm no automatic duplicate
   send. Report Node/OS/browser versions, sanitized errors and time to first message.

Success target: first mock message within ten minutes; API behavior understandable without
reading implementation; saved-session restore and graceful shutdown work in an authorized
live test. A live transport defect or unresolved advisory is a release limitation, not a
reason to mark a test complete without evidence.

## Evidence to collect for each tester

Use a GitHub issue with the following fields, excluding phone numbers, OTPs, QR payloads,
API keys, message content and browser profile/session files:

- Alias / consent to be listed, package revision, OS, Node and browser versions.
- Use case (notification / bot / verification), embedded or gateway.
- Install commands, time to first mock message, errors / confusing documentation.
- Live test authorized? Text/media/inbound/restore checks and sanitized observations.
- One thing that would make them choose this package for their next integration.

Keep individual feedback private unless the tester agrees to public sharing. The release
owner recruits testers and authorizes publication after inspecting the package, known
transport advisory report, account-risk description and live acceptance results.

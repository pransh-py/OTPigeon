# OTPigeon SDK

Dependency-free server-side JavaScript client. Requires Node.js 22 or newer.
This release candidate is built with `npm pack`; registry publication is a separate step.
From a checkout, run `npm pack ./sdk --pack-destination .local` and install the resulting tarball.

```js
import {OTPigeon, OTPigeonError} from 'otpigeon-sdk';
const gateway = new OTPigeon({baseUrl: 'http://localhost:8000', apiKey: process.env.OTPIGEON_API_KEY});
const challenge = await gateway.create({destination: '+15555550123', purpose: 'signup'}, {idempotencyKey: 'signup-attempt-123'});
const result = await gateway.verify(challenge.challenge_id, userSuppliedCode);
if (result.verified) {
  // Your application establishes its own account/session.
}
```

Methods: `create`, `get`, `list`, `resend`, `verify`, `events`, `testCode` (test keys only).
All return promises. See `index.d.ts` for response types.

The SDK never retries a request automatically. Reuse the same `idempotencyKey` after an
uncertain create/resend result. If omitted, the SDK generates one; `OTPigeonError.idempotencyKey`
preserves it for retry. Errors expose `status`, `code` and `retryAfter` (seconds when supplied).
A successful HTTP response may contain `verified: false`; check that value before granting access.
A verification challenge is single-use; bind its ID to your server-side authentication flow.
Never put API keys or this package in client-side bundles. Redirects are rejected to protect keys.

# Provider setup

Live delivery is opt-in on **both API and worker**, with a public HTTPS origin. No automated
check links a business account or sends a real/paid message. Test environments always use
mock delivery; live environments fail closed until configured and enabled.

## Twilio SMS

In the dashboard select Twilio and supply `account_sid` (`AC…`), `auth_token`, and
`from_number` (E.164). Use a sender authorized by your Twilio account for your destination.
The worker posts to Twilio's fixed Messages API with Basic authentication, a plain code
message, bounded ValidityPeriod, and a per-job StatusCallback:
`https://YOUR_ORIGIN/webhooks/twilio/JOB_ID`.

Delivery callbacks are URL-encoded forms. The server validates the exact configured origin
plus request path/query and all form parameters using Twilio's official RequestValidator,
then checks AccountSid and message correlation. Configure the proxy to preserve the path
and query. Do not use a tunnel URL that changes without updating/restarting the installation.

## Meta WhatsApp Cloud API

Use your own WhatsApp Business sender and **approved authentication template with a copy-code
URL button at index 0**, in the configured language. Required fields: `phone_number_id`,
`api_version` (your currently supported Graph version, explicitly chosen), `access_token`,
`app_secret`, `verify_token`, `template_name`, and `language` (e.g. `en_US`). No arbitrary
provider URL is accepted. The body and URL button receive the same six-digit code.

In the Meta app set the callback to `https://YOUR_ORIGIN/webhooks/meta/PROJECT_ID`, use the
configured verify token, and subscribe to `messages`. GET subscription verification and
raw-body `X-Hub-Signature-256` validation are implemented. Status events correlate via
`biz_opaque_callback_data` (job ID) or provider message ID and verify the phone-number ID.
Authenticated unrelated callbacks are acknowledged without changing challenge state.
Use a template whose displayed expiry matches your OTPIGEON_EXPIRY_SECONDS configuration.

## Credential storage and rotation

The dashboard writes encrypted credentials and returns only provider/template metadata.
It does not read secrets back. Saving replaces the entire configuration. A worker keeps an
immutable encrypted credential snapshot per job for request dispatch and late callback
verification. Disabling or rotating config cancels stale queued work at its final dispatch
check. An in-flight request can still complete. Do not grant untrusted users operator access.

The root OTPIGEON_SECRET derives encryption and OTP HMAC keys with separate purposes.
Back it up with the database. Changing it invalidates pending codes, encrypted credentials,
and retained jobs; there is no online key-rotation migration in this release. For intentional
root-key compromise recovery, disable dispatch, expire pending work, export the necessary
non-secret history, and reconfigure credentials in a new installation. Keep the old backup
isolated according to your retention policy.

## Contracts used

- [Twilio Messages resource](https://www.twilio.com/docs/messaging/api/message-resource)
- [Twilio webhook signature validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [Meta's WhatsApp Postman collection](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [Meta webhook signature example](https://github.com/fbsamples/whatsapp-api-examples/blob/main/signature-validation-with-webhooks-payloads/app.py)

Provider-side approval, pricing, supported versions, regional sender requirements, and actual
recipient delivery must be validated with the operator's account before enabling production.

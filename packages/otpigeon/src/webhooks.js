import { createHmac, timingSafeEqual } from "node:crypto";
export function signWebhook(body, timestamp, secret) {
  return (
    "v1=" +
    createHmac("sha256", secret)
      .update(String(timestamp) + ".")
      .update(body)
      .digest("hex")
  );
}
export function verifyWebhook({
  body,
  timestamp,
  signature,
  secret,
  toleranceSeconds = 300,
  now = Date.now(),
}) {
  if (
    typeof timestamp !== "string" ||
    timestamp.length !== 10 ||
    !/^[0-9]{10}$/.test(timestamp) ||
    typeof signature !== "string" ||
    signature.length !== 67 ||
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    !(typeof body === "string" || body instanceof Uint8Array) ||
    !Number.isFinite(now) ||
    typeof secret !== "string" ||
    secret.length < 32 ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0 ||
    Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds
  )
    return false;
  const expected = signWebhook(body, timestamp, secret);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

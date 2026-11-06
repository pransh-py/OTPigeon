import { test } from "node:test";
import assert from "node:assert/strict";
import { MessagingClient } from "../src/index.js";
import { MockTransport } from "../src/testing.js";
import { MemoryVerification } from "../src/verification.js";
test("scoped, expiring, bounded-attempt OTP is single-use under concurrent callers", async () => {
  const transport = new MockTransport(),
    client = new MessagingClient({ transport, minIntervalMs: 0 });
  await client.connect();
  let now = Date.now();
  const verify = new MemoryVerification({
    client,
    clock: () => now,
    maxAttempts: 2,
  });
  const challenge = await verify.issue({ to: "+39066982", purpose: "login" });
  const code = transport.sent[0].text.match(/code is ([0-9]{6})/)[1];
  const input = {
    challengeId: challenge.challengeId,
    to: challenge.to,
    purpose: challenge.purpose,
    code,
  };
  assert.equal(verify.verify({ ...input, to: "+6834002" }).verified, false);
  const results = await Promise.all(
    Array.from({ length: 20 }, async () => verify.verify(input)),
  );
  assert.equal(results.filter((r) => r.verified).length, 1);
  await assert.rejects(verify.issue({ to: challenge.to, purpose: "login" }), {
    code: "COOLDOWN",
  });
  now += 60001;
  const next = await verify.issue({ to: challenge.to, purpose: "login" });
  const wrong = { ...input, challengeId: next.challengeId, code: "wrong" };
  assert.equal(verify.verify(wrong).reason, "invalid_code");
  assert.equal(verify.verify(wrong).reason, "locked");
  now += 300001;
  assert.equal(verify.verify(wrong).reason, "expired");
  await client.close();
});

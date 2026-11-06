import { createInterface } from "node:readline/promises";
import { MemoryVerification } from "otpigeon/verification";
import { connectExample } from "./common.js";
const { client, transport, to, live } = await connectExample();
try {
  const verification = new MemoryVerification({ client });
  const challenge = await verification.issue({ to, purpose: "login" });
  let code;
  if (live) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      code = await prompt.question(
        "Enter the code received on your test phone: ",
      );
    } finally {
      prompt.close();
    }
  } else code = transport.sent[0].text.match(/code is ([0-9]{6})/)[1]; // mock-only test outbox
  const input = {
    challengeId: challenge.challengeId,
    to,
    purpose: "login",
    code,
  };
  console.log(verification.verify(input));
  console.log("Replay:", verification.verify(input));
} finally {
  await client.close();
}

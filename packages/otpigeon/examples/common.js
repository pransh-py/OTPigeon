import { MessagingClient } from "otpigeon";
import { MockTransport } from "otpigeon/testing";
export async function connectExample() {
  const live = process.argv.includes("--live");
  const to = process.env.OTPIGEON_TO ?? "+12025550123";
  if (live && !process.env.OTPIGEON_TO)
    throw new Error(
      "Set OTPIGEON_TO to your consenting test recipient before --live",
    );
  const transport = live ? undefined : new MockTransport();
  const client = new MessagingClient({
    transport,
    sessionId: "example",
    sessionPath: process.env.OTPIGEON_SESSION_PATH ?? ".otpigeon",
    minIntervalMs: live ? 1000 : 0,
  });
  if (live) {
    const { default: qrcode } = await import("qrcode-terminal");
    client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
    client.on("state", (state) => console.log("Connection:", state.state));
  }
  client.on("handler_error", (error) => console.error(error.code));
  await client.connect();
  return { client, transport, to, live };
}

import { MessagingClient, type SendResult } from "otpigeon";
import { MockTransport } from "otpigeon/testing";
import { createGateway, hashApiKey, verifyWebhook } from "otpigeon/gateway";
const client = new MessagingClient({
  transport: new MockTransport(),
  reconnect: { maxAttempts: 2 },
});
client.on("message", async (message) => {
  const result: SendResult = await message.reply("hello");
  console.log(result.id);
});
client.on("state", (state) => console.log(state.state));
await client.connect();
await client.sendImage({
  to: "+15555550123",
  data: Buffer.from("img"),
  mimeType: "image/png",
  filename: "image.png",
});
// @ts-expect-error media requires a filename
await client.sendDocument({
  to: "+15555550123",
  data: Buffer.from("doc"),
  mimeType: "application/pdf",
});
const gateway = await createGateway({
  databasePath: ".local/consumer.sqlite",
  storageSecret: "x".repeat(64),
  projects: [
    { id: "a", environment: "test", keyHashes: [hashApiKey("test")], client },
  ],
});
verifyWebhook({
  body: "{}",
  timestamp: "1234567890",
  signature: "v1=a",
  secret: "s".repeat(64),
});
await gateway.close();

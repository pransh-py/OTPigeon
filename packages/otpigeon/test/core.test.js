import { test } from "node:test";
import assert from "node:assert/strict";
import { MessagingClient } from "../src/index.js";
import { MockTransport } from "../src/testing.js";

const make = (options = {}) => {
  const transport = new MockTransport();
  return {
    transport,
    client: new MessagingClient({ transport, minIntervalMs: 0, ...options }),
  };
};
test("no services: text, copied image bytes, document, incoming reply, lifecycle", async () => {
  const { client, transport } = make();
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(transport.connectCalls, 1);
  assert.equal(client.status().state, "ready");
  const sent = await client.sendText({ to: "+6834002", text: "order ready" });
  assert.equal(sent.status, "accepted");
  assert.equal(sent.to, "+6834002");
  await client.sendImage({
    to: "+39066982",
    data: Buffer.from("png"),
    mimeType: "image/png",
    filename: "receipt.png",
  });
  await client.sendDocument({
    to: "+447700900123",
    data: Buffer.from("pdf"),
    mimeType: "application/pdf",
    filename: "receipt.pdf",
  });
  const replied = new Promise((resolve, reject) =>
    client.once("message", (message) =>
      message.reply("ready").then(resolve, reject),
    ),
  );
  transport.receive({ id: "in-1", chatId: "15555550123@lid", text: "status" });
  await replied;
  assert.equal(transport.sent.at(-1).replyTo, "in-1");
  assert.equal(transport.sent.at(-1).chatId, "15555550123@lid");
  await client.close();
  assert.equal(client.status().state, "closed");
});
test("bounded queue and unknown timeout never resend or overlap a stuck send", async () => {
  const { client, transport } = make({ maxPending: 1, sendTimeoutMs: 30 });
  await client.connect();
  let finish;
  transport.sendHook = () =>
    transport.sent.length === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ id: "second" });
  const first = client.sendText({ to: "+12025550123", text: "one" });
  const queued = client.sendText({ to: "+12025550123", text: "two" });
  await assert.rejects(client.sendText({ to: "+12025550123", text: "three" }), {
    code: "QUEUE_FULL",
  });
  await assert.rejects(first, { code: "SEND_UNKNOWN", outcome: "unknown" });
  assert.equal(transport.sent.length, 1);
  assert.equal(client.status().inFlight, true);
  finish({ id: "late" });
  await queued;
  assert.equal(transport.sent.length, 2);
  await client.close();
});
test("disconnect rejects queued requests and marks in-flight unknown", async () => {
  const { client, transport } = make({ reconnect: { maxAttempts: 0 } });
  await client.connect();
  let finish;
  transport.sendHook = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const one = client.sendText({ to: "+12025550123", text: "one" });
  const two = client.sendText({ to: "+12025550123", text: "two" });
  transport.disconnect();
  await assert.rejects(one, { code: "SEND_UNKNOWN" });
  await assert.rejects(two, { code: "NOT_READY", outcome: "not_sent" });
  finish({ id: "late" });
  await client.close();
});
test("validation and async application handlers cannot cause an unhandled rejection", async () => {
  const { client, transport } = make();
  await client.connect();
  for (const to of ["919876543210", "+１２３４", "+0123", "+12025550123\n"]) {
    await assert.rejects(client.sendText({ to, text: "a" }), {
      code: "INVALID_ARGUMENT",
    });
  }
  const reported = new Promise((resolve) =>
    client.once("handler_error", resolve),
  );
  client.on("message", async () => {
    throw new Error("user app error");
  });
  transport.receive({ id: "in-2", chatId: "123@c.us", text: "hi" });
  assert.equal((await reported).code, "HANDLER_FAILED");
  await client.close();
});

test("queued media owns its bytes and lookup failures are safe pre-send outcomes", async () => {
  const { client, transport } = make();
  await client.connect();
  let finish;
  transport.sendHook = () =>
    transport.sent.length === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ id: "image" });
  const first = client.sendText({ to: "+12025550123", text: "first" });
  const bytes = Buffer.from("original");
  const image = client.sendImage({
    to: "+12025550123",
    data: bytes,
    mimeType: "image/png",
    filename: "x.png",
  });
  bytes.fill(0);
  finish({ id: "first" });
  await first;
  await image;
  assert.equal(transport.sent[1].data.toString(), "original");
  await client.close();
});

test("incoming text preserves long messages and explicitly flags its safety bound", async () => {
  const { client, transport } = make();
  await client.connect();
  const full = new Promise((resolve) => client.once("message", resolve));
  transport.receive({ id: "long", chatId: "123@c.us", text: "a".repeat(6000) });
  const message = await full;
  assert.equal(message.text.length, 6000);
  assert.equal(message.textTruncated, false);
  const bound = new Promise((resolve) => client.once("message", resolve));
  transport.receive({
    id: "huge",
    chatId: "123@c.us",
    text: "a".repeat(70000),
  });
  const limited = await bound;
  assert.equal(limited.text.length, 65536);
  assert.equal(limited.textTruncated, true);
  await client.close();
});

test("document MIME and webhook signature boundaries reject trailing line terminators", async () => {
  const { client } = make();
  await client.connect();
  await assert.rejects(
    client.sendDocument({
      to: "+12025550123",
      data: Buffer.from("x"),
      mimeType: "text/plain\n",
      filename: "x.txt",
    }),
    { code: "INVALID_ARGUMENT" },
  );
  const { verifyWebhook } = await import("../src/gateway.js");
  assert.equal(
    verifyWebhook({
      body: "{}",
      timestamp: String(Math.floor(Date.now() / 1000)),
      signature: "v1=" + "a".repeat(64) + "\n",
      secret: "s".repeat(64),
    }),
    false,
  );
  await client.close();
});

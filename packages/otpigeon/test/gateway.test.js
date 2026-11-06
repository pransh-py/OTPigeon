import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MessagingClient } from "../src/index.js";
import { MockTransport } from "../src/testing.js";
import {
  createGateway,
  hashApiKey,
  verifyWebhook,
  mongoKeyAuthorizer,
} from "../src/gateway.js";
import { GatewayStore } from "../src/store.js";
const key = "otpg_test_" + "a".repeat(43),
  keyB = "otpg_test_" + "b".repeat(43),
  secret = "disposable-test-secret-".repeat(3);
async function fixture(t, options = {}, gatewayOptions = {}) {
  const path = await mkdtemp(join(tmpdir(), "otpigeon-gateway-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const transport = new MockTransport(),
    client = new MessagingClient({
      transport,
      minIntervalMs: 0,
      sendTimeoutMs: 40,
    });
  await client.connect();
  const second = new MessagingClient({
    transport: new MockTransport(),
    minIntervalMs: 0,
  });
  await second.connect();
  const gateway = await createGateway({
    databasePath: join(path, "gateway.sqlite"),
    storageSecret: secret,
    pollIntervalMs: 60000,
    ...gatewayOptions,
    projects: [
      {
        id: "shop",
        environment: "test",
        keyHashes: [hashApiKey(key)],
        client,
        ...options,
      },
      {
        id: "other",
        environment: "test",
        keyHashes: [hashApiKey(keyB)],
        client: second,
      },
    ],
  });
  t.after(() => gateway.close());
  const { port } = await gateway.listen({ port: 0 });
  async function request(method, url, body, idem = "order-1", auth = key) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        Authorization: "Bearer " + auth,
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return { gateway, transport, client, path, request, second, port };
}
test("HTTP admission, encrypted durable jobs, isolation, idempotency and events", async (t) => {
  const { gateway, transport, path, request } = await fixture(t);
  const body = { kind: "text", to: "+6834002", text: "private order receipt" };
  const responses = await Promise.all(
    Array.from({ length: 16 }, () => request("POST", "/v1/messages", body)),
  );
  assert.ok(responses.every((r) => r.status === 202));
  assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
  const id = responses[0].body.id;
  assert.equal(
    (await request("POST", "/v1/messages", { ...body, text: "changed" }))
      .status,
    409,
  );
  assert.equal(
    (await request("GET", "/v1/messages/" + id, undefined, undefined, keyB))
      .status,
    404,
  );
  const raw = await readFile(join(path, "gateway.sqlite-wal"));
  assert.equal(raw.includes(Buffer.from(body.text)), false);
  await gateway.runOnce();
  assert.equal(transport.sent.length, 1);
  assert.equal(
    (await request("GET", "/v1/messages/" + id)).body.status,
    "accepted",
  );
  assert.equal(
    (await request("GET", "/v1/events")).body.items.at(-1).type,
    "message.accepted",
  );
  assert.equal((await request("POST", "/v1/messages", body)).body.id, id);
  assert.equal(transport.sent.length, 1);
  const next = (await request("POST", "/v1/messages", body, "another")).body;
  gateway.revokeKey(hashApiKey(key));
  await gateway.runOnce();
  assert.equal(transport.sent.length, 1);
  assert.equal((await request("GET", "/v1/messages/" + next.id)).status, 401);
});
test("incoming messages persist and HTTP replies are scoped to their event", async (t) => {
  const { gateway, transport, request } = await fixture(t);
  transport.receive({ id: "incoming-1", chatId: "123@lid", text: "status" });
  const event = (await request("GET", "/v1/events")).body.items.find(
    (e) => e.type === "message.received",
  );
  assert.ok(event);
  assert.equal(
    (
      await request(
        "POST",
        "/v1/messages",
        { kind: "reply", eventId: event.id, text: "ready" },
        "reply-other",
        keyB,
      )
    ).status,
    400,
  );
  const result = await request("POST", "/v1/messages", {
    kind: "reply",
    eventId: event.id,
    text: "ready",
  });
  assert.equal(result.status, 202);
  await gateway.runOnce();
  assert.equal(transport.sent[0].replyTo, "incoming-1");
});
test("unknown sends stay unknown when an HTTP request is replayed", async (t) => {
  const { gateway, transport, request } = await fixture(t);
  let finish;
  transport.sendHook = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const body = { kind: "text", to: "+12025550123", text: "once" };
  const admitted = await request("POST", "/v1/messages", body);
  await gateway.runOnce();
  assert.equal(
    (await request("GET", "/v1/messages/" + admitted.body.id)).body.status,
    "unknown",
  );
  assert.equal(
    (await request("POST", "/v1/messages", body)).body.status,
    "unknown",
  );
  await gateway.runOnce();
  assert.equal(transport.sent.length, 1);
  finish({ id: "late" });
});
test("store restart recovers sending as unknown and queued as queued, wrong secret fails", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "otpigeon-store-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const filename = join(path, "jobs.sqlite");
  let store = await GatewayStore.open(filename, secret);
  const a = store.enqueue(
    "shop:test",
    hashApiKey(key),
    "a",
    { kind: "text", to: "+12025550123", text: "one" },
    false,
  );
  const b = store.enqueue(
    "shop:test",
    hashApiKey(key),
    "b",
    { kind: "text", to: "+12025550123", text: "two" },
    false,
  );
  store.begin(a.id, "shop:test", false);
  store.close();
  await assert.rejects(GatewayStore.open(filename, "different-".repeat(5)), {
    code: "STORAGE_KEY_MISMATCH",
  });
  store = await GatewayStore.open(filename, secret);
  t.after(() => store.close());
  store.recover(() => false);
  assert.equal(store.get("shop:test", a.id).status, "unknown");
  assert.equal(store.get("shop:test", b.id).status, "queued");
});
test("real HTTP signed webhook delivery and raw-body verification", async (t) => {
  const received = [];
  const sink = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks), headers: req.headers });
      res.end("ok");
    });
  });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => sink.close(resolve)));
  const { gateway, request } = await fixture(t, {
    webhook: { url: `http://127.0.0.1:${sink.address().port}`, secret },
  });
  await request("POST", "/v1/messages", {
    kind: "text",
    to: "+12025550123",
    text: "receipt",
  });
  await gateway.runOnce();
  assert.ok(received.length);
  const event = received[0];
  const args = {
    body: event.body,
    timestamp: event.headers["x-otpigeon-timestamp"],
    signature: event.headers["x-otpigeon-signature"],
    secret,
  };
  assert.equal(verifyWebhook(args), true);
  assert.equal(
    verifyWebhook({ ...args, body: Buffer.from("tampered") }),
    false,
  );
  assert.equal(verifyWebhook({ ...args, now: Date.now() + 600000 }), false);
});

test("admission bounds, media and malformed input never dispatch invalid data", async (t) => {
  const { gateway, request, transport, port } = await fixture(
    t,
    {},
    { maxPending: 1, maxRecords: 2 },
  );
  assert.equal(
    (
      await request("POST", "/v1/messages", {
        kind: "text",
        to: "919876543210",
        text: "bad",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("POST", "/v1/messages", {
        kind: "image",
        to: "+12025550123",
        data: "%%%=",
        mimeType: "image/png",
        filename: "a.png",
      })
    ).status,
    400,
  );
  const media = {
    kind: "document",
    to: "+39066982",
    data: Buffer.from("receipt").toString("base64"),
    mimeType: "text/plain",
    filename: "receipt.txt",
  };
  assert.equal((await request("POST", "/v1/messages", media)).status, 202);
  assert.equal(
    (await request("POST", "/v1/messages", media, "other")).status,
    429,
  );
  await gateway.runOnce();
  assert.equal(transport.sent[0].data.toString(), "receipt");
  const unauth = await fetch(`http://127.0.0.1:${port}/v1/events`);
  assert.equal(unauth.status, 401);
  const content = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Idempotency-Key": "content" },
    body: "{}",
  });
  assert.equal(content.status, 415);
  const large = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Idempotency-Key": "large",
      "Content-Type": "application/json",
    },
    body: " ".repeat(12 * 1024 * 1024 + 1),
  });
  assert.equal(large.status, 413);
});

test("external key authority inherits revocation and fails closed on outages", async (t) => {
  let authorized = true,
    unavailable = false;
  const calls = [];
  const { gateway, request, transport } = await fixture(
    t,
    {},
    {
      isKeyActive: async (input) => {
        calls.push(input);
        if (unavailable) throw new Error("secret connection details");
        return authorized;
      },
    },
  );
  const body = { kind: "text", to: "+12025550123", text: "one" };
  await request("POST", "/v1/messages", body);
  authorized = false;
  await gateway.runOnce();
  assert.equal(transport.sent.length, 0);
  assert.equal((await request("GET", "/v1/events")).status, 401);
  authorized = true;
  assert.equal(
    (await request("POST", "/v1/messages", body)).body.status,
    "canceled",
  );
  await request("POST", "/v1/messages", body, "second");
  unavailable = true;
  await gateway.runOnce();
  assert.equal(transport.sent.length, 0);
  const outage = await request("GET", "/v1/events");
  assert.equal(outage.status, 503);
  assert.equal(JSON.stringify(outage).includes("secret connection"), false);
  assert.equal(calls[0].projectId, "shop");
  assert.equal(calls[0].environment, "test");
  const collection = {
    async findOne(query, options) {
      assert.deepEqual(query, {
        digest: hashApiKey(key),
        project_id: "shop",
        environment: "test",
        revoked_at: null,
      });
      assert.deepEqual(options, { projection: { _id: 1 } });
      return { _id: "active-key" };
    },
  };
  assert.equal(
    await mongoKeyAuthorizer(collection)({
      hash: hashApiKey(key),
      projectId: "shop",
      environment: "test",
    }),
    true,
  );
});

test("a blocked account does not block dispatch for another project", async (t) => {
  const { gateway, request, transport, second } = await fixture(t);
  let finish;
  transport.sendHook = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const body = { kind: "text", to: "+12025550123", text: "one" };
  await request("POST", "/v1/messages", body);
  const b = await request("POST", "/v1/messages", body, "other-account", keyB);
  const running = gateway.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(second.transport.sent.length, 1);
  assert.equal(
    (
      await request(
        "GET",
        "/v1/messages/" + b.body.id,
        undefined,
        undefined,
        keyB,
      )
    ).body.status,
    "accepted",
  );
  finish({ id: "slow" });
  await running;
});

test("durable webhook retry retains event ID and shutdown waits for its attempt", async (t) => {
  let finish, received;
  const { gateway, request, path } = await fixture(
    t,
    { webhook: { url: "https://example.test/hook", secret } },
    {
      fetch: async (_, options) => {
        received = options;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  await request("POST", "/v1/messages", {
    kind: "text",
    to: "+12025550123",
    text: "order",
  });
  const running = gateway.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const eventId = received.headers["X-OTPigeon-Event-Id"];
  assert.ok(eventId);
  let closed = false;
  const closing = gateway.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed, false);
  finish(new Response("failure", { status: 500 }));
  await running;
  await closing;
  const store = await GatewayStore.open(join(path, "gateway.sqlite"), secret);
  t.after(() => store.close());
  const events = store.events("shop:test");
  const event = events.find((e) => String(e.id) === eventId);
  assert.equal(event.webhook.status, "pending");
  assert.equal(event.webhook.attempts, 1);
  store.db
    .prepare("UPDATE events SET next_at=0 WHERE id=?")
    .run(Number(eventId));
  assert.equal(String(store.nextWebhook("shop:test").id), eventId);
});

test("live environments require explicit dispatch opt-in and cannot use test keys accidentally", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "otpigeon-live-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const transport = new MockTransport(),
    client = new MessagingClient({ transport });
  await client.connect();
  const liveKey = "otpg_live_" + "c".repeat(43);
  const gateway = await createGateway({
    databasePath: join(path, "db.sqlite"),
    storageSecret: secret,
    projects: [
      {
        id: "live",
        environment: "live",
        keyHashes: [hashApiKey(liveKey), hashApiKey(key)],
        client,
      },
    ],
  });
  t.after(() => gateway.close());
  const { port } = await gateway.listen({ port: 0 });
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + liveKey,
      "Idempotency-Key": "live",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "text",
      to: "+12025550123",
      text: "must not send",
    }),
  });
  assert.equal(response.status, 403);
  const wrongEnvironment = await fetch(
    `http://127.0.0.1:${port}/v1/connection`,
    { headers: { Authorization: "Bearer " + key } },
  );
  assert.equal(wrongEnvironment.status, 401);
  assert.equal(transport.sent.length, 0);
});

test("gateway shutdown surfaces browser cleanup failure after stopping durable work", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "otpigeon-close-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const transport = new MockTransport(),
    client = new MessagingClient({ transport });
  await client.connect();
  const filename = join(path, "gateway.sqlite");
  const gateway = await createGateway({
    databasePath: filename,
    storageSecret: secret,
    projects: [
      { id: "shop", environment: "test", keyHashes: [hashApiKey(key)], client },
    ],
  });
  transport.close = async () => {
    throw new Error("upstream failure");
  };
  await assert.rejects(gateway.close(), { code: "CLOSE_FAILED" });
  const reopened = await GatewayStore.open(filename, secret);
  reopened.close();
});

test("invalid startup configuration fails before acquiring durable storage ownership", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "otpigeon-invalid-start-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const filename = join(path, "gateway.sqlite");
  await assert.rejects(
    createGateway({
      databasePath: filename,
      storageSecret: secret,
      projects: [
        {
          id: "shop",
          environment: "live",
          keyHashes: [hashApiKey("otpg_live_" + "a".repeat(43))],
          client: {},
        },
      ],
    }),
    { code: "INVALID_ARGUMENT" },
  );
  const store = await GatewayStore.open(filename, secret);
  store.close();
});

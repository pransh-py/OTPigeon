import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MessagingClient, WhatsAppWebTransport } from "../src/index.js";
import { SessionLease } from "../src/session.js";
import { MockTransport } from "../src/testing.js";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error("Condition did not settle");
    await pause(5);
  }
}
async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), "otpigeon-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("actual process ownership survives contention and recovers after SIGKILL", async (t) => {
  const path = await dir(t);
  const module = new URL("../src/session.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {SessionLease} from ${JSON.stringify(module)}; const lease=new SessionLease(process.argv[1],'account'); await lease.acquire(); process.send('locked'); setInterval(()=>{},1000);`,
      path,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Owner exited early")));
  });
  const competitor = new SessionLease(path, "account");
  await assert.rejects(competitor.acquire(), { code: "SESSION_LOCKED" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  await competitor.acquire();
  competitor.release();
});

test("lazy adapter maps upstream lifecycle, media, lookup, LID replies and receipts", async (t) => {
  const path = await dir(t);
  let loads = 0,
    raw,
    settings;
  class Client extends EventEmitter {
    constructor(options) {
      super();
      settings = options;
      raw = this;
      this.calls = [];
    }
    async initialize() {
      this.emit("qr", "fixture-qr");
      this.emit("authenticated");
      this.emit("ready");
    }
    async destroy() {
      this.destroyed = true;
    }
    async getNumberId(number) {
      this.number = number;
      return { _serialized: number + "@c.us" };
    }
    async sendMessage(...args) {
      this.calls.push(args);
      return { id: { _serialized: "provider-" + this.calls.length } };
    }
  }
  class LocalAuth {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  class MessageMedia {
    constructor(...args) {
      this.args = args;
    }
  }
  const transport = new WhatsAppWebTransport({
    sessionPath: path,
    sessionId: "shop",
    engineLoader: async () => {
      loads++;
      return { Client, LocalAuth, MessageMedia };
    },
  });
  const client = new MessagingClient({ transport, minIntervalMs: 0 });
  t.after(() => client.close());
  assert.equal(loads, 0);
  let qr;
  client.on("qr", (value) => {
    qr = value;
  });
  await client.connect();
  assert.equal(qr, "fixture-qr");
  assert.equal(settings.authStrategy.clientId, "shop");
  assert.equal(settings.authStrategy.dataPath, path);
  await client.sendImage({
    to: "+39066982",
    data: Buffer.from("img"),
    mimeType: "image/png",
    filename: "x.png",
    caption: "receipt",
  });
  assert.equal(raw.number, "39066982");
  assert.equal(raw.calls[0][1].args[1], Buffer.from("img").toString("base64"));
  await client.sendDocument({
    to: "+6834002",
    data: Buffer.from("doc"),
    mimeType: "application/pdf",
    filename: "x.pdf",
  });
  assert.equal(raw.calls[1][2].sendMediaAsDocument, true);
  const replied = new Promise((resolve, reject) =>
    client.once("message", (message) =>
      message.reply("hello").then(resolve, reject),
    ),
  );
  raw.emit("message", {
    id: { _serialized: "in-1" },
    from: "12345@lid",
    body: "hi",
    type: "chat",
  });
  await replied;
  assert.equal(raw.calls[2][0], "12345@lid");
  assert.equal(raw.calls[2][2].quotedMessageId, "in-1");
  const delivered = new Promise((resolve) => client.once("delivery", resolve));
  raw.emit(
    "message_ack",
    { fromMe: true, id: { _serialized: "provider-1" } },
    2,
  );
  assert.equal((await delivered).status, "delivered");
  raw.getNumberId = async () => null;
  await assert.rejects(client.sendText({ to: "+15555550123", text: "hi" }), {
    code: "RECIPIENT_UNAVAILABLE",
    outcome: "not_sent",
  });
  await client.close();
  assert.equal(raw.destroyed, true);
  const next = new SessionLease(path, "shop");
  await next.acquire();
  next.release();
});

test("transient reconnect is bounded; auth failure and logout require action", async (t) => {
  const transport = new MockTransport();
  const client = new MessagingClient({
    transport,
    reconnect: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 10 },
  });
  t.after(() => client.close());
  await client.connect();
  transport.disconnect();
  await eventually(
    () => client.status().state === "ready" && transport.connectCalls === 2,
  );
  assert.equal(client.status().state, "ready");
  assert.equal(transport.connectCalls, 2);
  transport.emit("state", { state: "auth_failed" });
  await pause(25);
  assert.equal(transport.connectCalls, 2);
  await client.connect();
  transport.disconnect("logged_out");
  await pause(25);
  assert.equal(transport.connectCalls, 3);
});

test("close during connect never accepts late ready or sends", async () => {
  const transport = new MockTransport();
  let resolve;
  transport.connect = () =>
    new Promise((yes) => {
      resolve = yes;
    });
  const client = new MessagingClient({ transport });
  const connecting = client.connect();
  const rejection = assert.rejects(connecting, { code: "CLIENT_CLOSED" });
  await pause(0);
  await client.close();
  await rejection;
  transport.emit("state", { state: "ready" });
  resolve();
  assert.equal(client.status().state, "closed");
  await assert.rejects(client.sendText({ to: "+12025550123", text: "hi" }), {
    code: "NOT_READY",
  });
});

test("one failed reconnect cannot create duplicate timers or exceed attempt budget", async (t) => {
  const transport = new MockTransport();
  const client = new MessagingClient({
    transport,
    reconnect: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 10 },
  });
  t.after(() => client.close());
  await client.connect();
  transport.connect = async () => {
    transport.connectCalls++;
    transport.emit("state", { state: "disconnected" });
    throw new Error("offline");
  };
  transport.disconnect();
  await eventually(() => transport.connectCalls === 3);
  await pause(20);
  assert.equal(transport.connectCalls, 3);
  assert.equal(client.status().reconnectAttempts, 2);
});

test("same-tick close cancels startup before the transport is invoked", async () => {
  const transport = new MockTransport(),
    client = new MessagingClient({ transport });
  const opening = client.connect();
  const rejected = assert.rejects(opening, { code: "CLIENT_CLOSED" });
  await client.close();
  await rejected;
  await pause(5);
  assert.equal(transport.connectCalls, 0);
});

test("closing a browser adapter while ownership is being acquired cannot start a browser", async (t) => {
  const path = await dir(t);
  let loads = 0;
  const transport = new WhatsAppWebTransport({
    sessionPath: path,
    engineLoader: async () => {
      loads++;
      throw new Error("must not load");
    },
  });
  const opening = transport.connect();
  await transport.close();
  await opening;
  assert.equal(loads, 0);
});

test("actual worker SIGKILL leaves a durable sending record which recovers unknown", async (t) => {
  const path = await dir(t),
    filename = join(path, "jobs.sqlite"),
    secret = "isolated-process-secret-".repeat(3);
  const module = new URL("../src/store.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {GatewayStore} from ${JSON.stringify(module)}; const store=await GatewayStore.open(process.argv[1],process.argv[2]); const row=store.enqueue('scope','hash','idem',{kind:'text',to:'+12025550123',text:'one'},false);store.begin(row.id,'scope',false);process.send(row.id);setInterval(()=>{},1000);`,
      filename,
      secret,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(() => child.kill("SIGKILL"));
  const id = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Worker exited early")));
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  const { GatewayStore } = await import("../src/store.js");
  const store = await GatewayStore.open(filename, secret);
  t.after(() => store.close());
  store.recover(() => false);
  assert.equal(store.get("scope", id).status, "unknown");
  assert.equal(store.next("scope"), undefined);
});

test("cleanup errors are structured and retain a visible failure state", async () => {
  const transport = new MockTransport(),
    client = new MessagingClient({ transport });
  await client.connect();
  transport.close = async () => {
    throw new Error("private upstream context");
  };
  await assert.rejects(
    client.close(),
    (error) =>
      error.code === "CLOSE_FAILED" &&
      !error.message.includes("private upstream"),
  );
  assert.equal(client.status().state, "closing");
  assert.equal(client.status().reason, "close_failed");
});

test("a timed-out close reports late successful cleanup without releasing early", async () => {
  const transport = new MockTransport(),
    client = new MessagingClient({ transport, closeTimeoutMs: 10 });
  await client.connect();
  let finish;
  transport.close = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await assert.rejects(client.close(), { code: "CLOSE_TIMEOUT" });
  assert.equal(client.status().reason, "close_timeout");
  finish();
  await eventually(() => client.status().state === "closed");
});

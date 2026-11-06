import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { GatewayStore, digest } from "./store.js";
import { MessagingError, integer, invalid } from "./errors.js";
import { normalizeMessage } from "./message.js";
import { signWebhook, verifyWebhook } from "./webhooks.js";
export { verifyWebhook };
export const hashApiKey = (key) => digest(key);
export const mongoKeyAuthorizer =
  (collection) =>
  async ({ hash, projectId, environment }) =>
    !!(await collection.findOne(
      { digest: hash, project_id: projectId, environment, revoked_at: null },
      { projection: { _id: 1 } },
    ));
const validId = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{1,64}$/.test(value) &&
  value === value.trim();
const scopeOf = (project) => project.id + ":" + project.environment;

export async function createGateway({
  databasePath,
  storageSecret,
  projects,
  maxPending = 1000,
  maxRecords = 10000,
  retentionMs = 7 * 86400000,
  pollIntervalMs = 250,
  allowLiveDelivery = false,
  maxStoredBytes = 256 * 1024 * 1024,
  isKeyActive,
  fetch: fetcher = globalThis.fetch,
  onError = () => {},
}) {
  integer(
    maxStoredBytes,
    "maxStoredBytes",
    1024 * 1024,
    2 * 1024 * 1024 * 1024,
  );
  integer(maxPending, "maxPending", 1, 10000);
  integer(maxRecords, "maxRecords", maxPending, 100000);
  integer(retentionMs, "retentionMs", 60000, 30 * 86400000);
  integer(pollIntervalMs, "pollIntervalMs", 10, 60000);
  if (
    typeof databasePath !== "string" ||
    !databasePath ||
    !Array.isArray(projects) ||
    !projects.length ||
    projects.length > 100
  )
    throw invalid("Provide databasePath and 1–100 projects");
  const scopes = new Map(),
    keys = new Map(),
    listeners = [],
    active = new Map(),
    webhookActive = new Map();
  let lastError = null,
    droppedEvents = 0;
  function report(code) {
    lastError = code;
    try {
      Promise.resolve(
        onError(
          new MessagingError(
            code,
            "Gateway background operation failed; inspect storage/connection health",
          ),
        ),
      ).catch(() => {});
    } catch {
      /* application callback is isolated */
    }
  }
  for (const config of projects) {
    if (
      !validId(config.id) ||
      !["test", "live"].includes(config.environment) ||
      !config.client ||
      !config.client.transport ||
      [
        "on",
        "off",
        "status",
        "close",
        "sendText",
        "sendImage",
        "sendDocument",
        "replyText",
      ].some((method) => typeof config.client[method] !== "function") ||
      !Array.isArray(config.keyHashes) ||
      !config.keyHashes.length
    )
      throw invalid("Invalid project configuration");
    if (
      config.environment === "test" &&
      config.client.transport.simulated !== true
    )
      throw invalid("Test environments require a simulated transport");
    if ([...scopes.values()].some((p) => p.client === config.client))
      throw invalid("Each client belongs to exactly one project/environment");
    const scope = scopeOf(config);
    if (scopes.has(scope)) throw invalid("Duplicate project/environment");
    if (config.webhook) {
      const url = new URL(config.webhook.url);
      if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            config.environment === "test" &&
            url.protocol === "http:" &&
            ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
          )) ||
        typeof config.webhook.secret !== "string" ||
        config.webhook.secret.length < 32
      )
        throw invalid(
          "Webhook requires HTTPS and a separate secret of at least 32 characters (loopback HTTP allowed in test)",
        );
    }
    const p = { ...config, scope, keyHashes: new Set(config.keyHashes) };
    scopes.set(scope, p);
    for (const key of p.keyHashes) {
      if (
        typeof key !== "string" ||
        key.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(key) ||
        keys.has(key)
      )
        throw invalid("Key hashes must be unique SHA-256 hex digests");
      keys.set(key, p);
    }
  }
  const store = await GatewayStore.open(databasePath, storageSecret, {
    maxPending,
    maxRecords,
    retentionMs,
    maxStoredBytes,
  });
  try {
    store.recover((scope) => !!scopes.get(scope)?.webhook);
  } catch (error) {
    store.close();
    throw error;
  }
  let activeRequests = 0;
  let closed = false,
    timer,
    server,
    closing;
  function record(p, body) {
    try {
      return store.event(p.scope, body, !!p.webhook);
    } catch {
      droppedEvents++;
      report("EVENT_STORAGE_FAILED");
    }
  }
  for (const p of scopes.values()) {
    const onMessage = (message) =>
      record(p, {
        type: "message.received",
        message: {
          id: message.id,
          chatId: message.chatId,
          text: message.text,
          textTruncated: message.textTruncated,
          type: message.type,
          hasMedia: message.hasMedia,
        },
      });
    const onDelivery = (receipt) =>
      record(p, { type: "message.delivery", receipt });
    const onState = (state) => record(p, { type: "connection.state", state });
    p.client.on("message", onMessage);
    p.client.on("delivery", onDelivery);
    p.client.on("state", onState);
    listeners.push([p, onMessage, onDelivery, onState]);
  }
  async function permitted(p, hash) {
    if (keys.get(hash) !== p) return false;
    let valid = true;
    try {
      if (isKeyActive)
        valid = await isKeyActive({
          hash,
          projectId: p.id,
          environment: p.environment,
        });
    } catch {
      throw new MessagingError(
        "AUTHORITY_UNAVAILABLE",
        "Key authority is unavailable; no send attempted",
      );
    }
    return valid === true && keys.get(hash) === p;
  }
  async function dispatch(p) {
    if (p.client.status().state !== "ready" || p.client.status().inFlight)
      return;
    const row = store.next(p.scope);
    if (!row) return;
    const keyActive = await permitted(p, row.key_hash);
    if (
      !keyActive ||
      (p.environment === "live" && !allowLiveDelivery) ||
      row.expires < Date.now()
    ) {
      store.finish(
        row.id,
        p.scope,
        "canceled",
        null,
        !keyActive
          ? "key_revoked"
          : row.expires < Date.now()
            ? "expired"
            : "live_disabled",
        !!p.webhook,
      );
      return;
    }
    const wire = store.unseal(row.payload, "job:" + p.scope);
    store.begin(row.id, p.scope, !!p.webhook);
    let result, error;
    try {
      if (wire.kind === "reply") result = await p.client.replyText(wire);
      else {
        const input = {
          ...wire,
          ...(wire.data ? { data: Buffer.from(wire.data, "base64") } : {}),
        };
        result =
          await p.client[
            { text: "sendText", image: "sendImage", document: "sendDocument" }[
              wire.kind
            ]
          ](input);
      }
    } catch (cause) {
      error = cause;
    }
    // Persistence failures escape. A sending record will recover as unknown;
    // never convert a successfully dispatched message into a safe-to-retry error.
    store.finish(
      row.id,
      p.scope,
      error
        ? error instanceof MessagingError && error.outcome === "not_sent"
          ? "failed"
          : "unknown"
        : "accepted",
      result?.id,
      error?.code ?? null,
      !!p.webhook,
    );
  }
  async function deliverWebhook(p) {
    if (!p.webhook) return;
    const row = store.nextWebhook(p.scope);
    if (!row) return;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      projectId: p.id,
      environment: p.environment,
      ...store.eventPublic(row),
    });
    const attempts = row.attempts + 1;
    // Persist the next attempt before I/O; restart can repeat, never lose it.
    store.webhookAttempt(
      row.id,
      attempts,
      Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)),
      false,
    );
    let ok = false;
    try {
      const response = await fetcher(p.webhook.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-OTPigeon-Timestamp": timestamp,
          "X-OTPigeon-Signature": signWebhook(
            body,
            timestamp,
            p.webhook.secret,
          ),
          "X-OTPigeon-Event-Id": String(row.id),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      ok = response.ok;
      await response.body?.cancel();
    } catch {
      /* retry this event with the same ID */
    }
    store.webhookAttempt(
      row.id,
      attempts,
      0,
      ok ? true : attempts >= 10 ? "exhausted" : false,
    );
    if (!ok && attempts >= 10) report("WEBHOOK_EXHAUSTED");
  }
  function runOnce() {
    if (closed) return Promise.resolve();
    const work = [];
    for (const p of scopes.values()) {
      if (!active.has(p.scope)) {
        const task = dispatch(p)
          .catch(() => report("DISPATCH_STORAGE_FAILED"))
          .finally(() => active.delete(p.scope));
        active.set(p.scope, task);
        work.push(task);
      }
      if (!webhookActive.has(p.scope)) {
        const task = deliverWebhook(p)
          .catch(() => report("WEBHOOK_STORAGE_FAILED"))
          .finally(() => webhookActive.delete(p.scope));
        webhookActive.set(p.scope, task);
        work.push(task);
      }
    }
    return Promise.all(work);
  }
  async function read(req) {
    if (
      !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
    )
      throw new MessagingError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Use Content-Type: application/json",
      );
    const chunks = [];
    let bytes = 0;
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 12 * 1024 * 1024) {
          reject(
            new MessagingError("BODY_TOO_LARGE", "Request body exceeds 12 MiB"),
          );
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", resolve);
      req.on("error", reject);
      req.on("aborted", () => reject(invalid("Request aborted")));
    });
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw invalid("Invalid JSON body");
    }
  }
  function payload(kind, body) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw invalid("Message body must be an object");
    const allowed =
      kind === "text"
        ? ["kind", "to", "text"]
        : ["kind", "to", "data", "mimeType", "filename", "caption"];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw invalid("Unexpected message fields");
    if (
      kind !== "text" &&
      (typeof body.data !== "string" ||
        !body.data ||
        body.data.length % 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data))
    )
      throw invalid("Media data must be canonical base64");
    const message = normalizeMessage(kind, {
      ...body,
      ...(kind !== "text" ? { data: Buffer.from(body.data, "base64") } : {}),
    });
    if (message.data && message.data.toString("base64") !== body.data)
      throw invalid("Media data must be canonical base64");
    return {
      ...message,
      ...(message.data ? { data: message.data.toString("base64") } : {}),
    };
  }
  function respond(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(body));
  }
  async function handle(req, res) {
    if (activeRequests >= 32 || closed) {
      req.resume();
      respond(res, closed ? 503 : 429, {
        error: {
          code: closed ? "SHUTTING_DOWN" : "TOO_MANY_REQUESTS",
          message: "Apply backpressure and retry later",
        },
      });
      return;
    }
    ++activeRequests;
    const requestId = randomUUID();
    try {
      const url = new URL(req.url, "http://gateway");
      if (req.method === "GET" && url.pathname === "/health")
        return respond(res, lastError ? 503 : 200, {
          status: lastError ? "degraded" : "ok",
          reason: lastError,
          droppedEvents,
        });
      const raw = req.headers.authorization;
      if (
        typeof raw !== "string" ||
        raw.length > 512 ||
        !/^Bearer otpg_(test|live)_[A-Za-z0-9_-]{32,128}$/.test(raw)
      )
        throw new MessagingError(
          "UNAUTHORIZED",
          "Missing or invalid project key",
        );
      const keyHash = digest(raw.slice(7)),
        p = keys.get(keyHash);
      if (
        !p ||
        !raw.startsWith("Bearer otpg_" + p.environment + "_") ||
        !(await permitted(p, keyHash))
      )
        throw new MessagingError(
          "UNAUTHORIZED",
          "Missing, invalid or revoked project key",
        );
      if (req.method === "GET" && url.pathname === "/v1/connection")
        return respond(res, 200, {
          projectId: p.id,
          environment: p.environment,
          ...p.client.status(),
        });
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? 0),
          limit = Number(url.searchParams.get("limit") ?? 50);
        integer(after, "after", 0, Number.MAX_SAFE_INTEGER);
        integer(limit, "limit", 1, 100);
        const items = store.events(p.scope, after, limit);
        return respond(res, 200, {
          items,
          nextCursor: items.at(-1)?.id ?? after,
        });
      }
      const get = url.pathname.match(/^\/v1\/messages\/([a-f0-9-]{36})$/);
      if (req.method === "GET" && get) {
        const item = store.get(p.scope, get[1]);
        return respond(
          res,
          item ? 200 : 404,
          item ?? {
            error: { code: "NOT_FOUND", message: "Message not found" },
          },
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        if (p.environment === "live" && !allowLiveDelivery)
          throw new MessagingError(
            "LIVE_DISABLED",
            "Live delivery is disabled",
          );
        const idem = req.headers["idempotency-key"];
        if (
          typeof idem !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(idem) ||
          idem !== idem.trim()
        )
          throw invalid(
            "Idempotency-Key must contain 1–128 safe ASCII characters",
          );
        const body = await read(req);
        let wire;
        if (body?.kind === "reply") {
          if (
            Object.keys(body).some(
              (key) => !["kind", "eventId", "text"].includes(key),
            )
          )
            throw invalid("Unexpected reply fields");
          integer(body.eventId, "eventId");
          const source = store.eventById(p.scope, body.eventId);
          if (source?.type !== "message.received")
            throw invalid(
              "eventId must identify an incoming message in this project",
            );
          wire = {
            ...normalizeMessage(
              "text",
              {
                chatId: source.message.chatId,
                replyTo: source.message.id,
                text: body.text,
              },
              undefined,
              true,
            ),
            kind: "reply",
          };
        } else wire = payload(body?.kind, body);
        return respond(
          res,
          202,
          store.enqueue(p.scope, keyHash, idem, wire, !!p.webhook),
        );
      }
      return respond(res, 404, {
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    } catch (error) {
      const code =
        error instanceof MessagingError ? error.code : "INTERNAL_ERROR";
      const status =
        {
          UNAUTHORIZED: 401,
          INVALID_ARGUMENT: 400,
          UNSUPPORTED_MEDIA_TYPE: 415,
          BODY_TOO_LARGE: 413,
          IDEMPOTENCY_CONFLICT: 409,
          QUEUE_FULL: 429,
          EVENTS_FULL: 429,
          LIVE_DISABLED: 403,
          AUTHORITY_UNAVAILABLE: 503,
        }[code] ?? 500;
      if (status === 500) report("HTTP_STORAGE_FAILED");
      if (!res.headersSent)
        respond(res, status, {
          error:
            error instanceof MessagingError
              ? error.toJSON()
              : { code, message: "Request failed" },
          requestId,
        });
      else res.end();
    } finally {
      --activeRequests;
    }
  }
  return {
    runOnce,
    revokeKey(hash) {
      keys.delete(hash);
    },
    prune() {
      return store.prune();
    },
    async listen({ port = 8080, host = "127.0.0.1" } = {}) {
      if (closed || server)
        throw invalid("Gateway is closed or already listening");
      server = createServer(
        { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
        (req, res) => {
          void handle(req, res);
        },
      );
      server.maxConnections = 64;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      timer = setInterval(() => {
        void runOnce();
      }, pollIntervalMs);
      const address = server.address();
      return {
        host,
        address: typeof address === "string" ? address : address.address,
        port: address.port,
      };
    },
    close() {
      if (closing) return closing;
      closed = true;
      clearInterval(timer);
      closing = (async () => {
        const serverDone = server
          ? new Promise((resolve) => {
              server.close(resolve);
              server.closeIdleConnections();
            })
          : Promise.resolve();
        for (const [p, message, delivery, state] of listeners) {
          p.client.off("message", message);
          p.client.off("delivery", delivery);
          p.client.off("state", state);
        }
        const clientResults = await Promise.allSettled(
          [...scopes.values()].map((p) => p.client.close()),
        );
        await Promise.allSettled([
          ...active.values(),
          ...webhookActive.values(),
        ]);
        // HTTP requests are finished before closing their durable store.
        await serverDone;
        store.close();
        if (clientResults.some((result) => result.status === "rejected")) {
          report("CLIENT_CLOSE_FAILED");
          throw new MessagingError(
            "CLOSE_FAILED",
            "Gateway stopped, but a client failed to close; inspect its session owner",
          );
        }
      })();
      return closing;
    },
  };
}

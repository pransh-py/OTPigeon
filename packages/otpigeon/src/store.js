import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { dirname, resolve, basename } from "node:path";
import { mkdir, chmod, realpath } from "node:fs/promises";
import { MessagingError } from "./errors.js";
import { SessionLease } from "./session.js";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export class GatewayStore {
  static async open(
    path,
    secret,
    {
      maxPending = 1000,
      maxRecords = 10000,
      retentionMs = 7 * 86400000,
      maxStoredBytes = 256 * 1024 * 1024,
    } = {},
  ) {
    if (typeof secret !== "string" || secret.length < 32)
      throw new MessagingError(
        "INVALID_ARGUMENT",
        "storageSecret must contain at least 32 characters; preserve it across restarts",
      );
    let filename = resolve(path);
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    filename = resolve(await realpath(dirname(filename)), basename(filename));
    try {
      filename = await realpath(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const lease = new SessionLease(
      dirname(filename),
      digest(filename).slice(0, 32),
    );
    await lease.acquire();
    let db;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(filename, { timeout: 5000 });
      await chmod(filename, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key_hash TEXT NOT NULL, idem TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, provider_id TEXT, reason TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, UNIQUE(scope,idem));
        CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(scope,status,created);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL, webhook INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS events_scope ON events(scope,id);
        CREATE INDEX IF NOT EXISTS events_webhook ON events(scope,webhook,next_at,id);`);
      const store = new GatewayStore(db, secret, lease, {
        maxPending,
        maxRecords,
        retentionMs,
        maxStoredBytes,
      });
      const existing = db.prepare("SELECT value FROM meta WHERE id=1").get();
      if (existing) store.unseal(existing.value);
      else
        db.prepare("INSERT INTO meta VALUES(1,?)").run(
          store.seal({ version: 1 }),
        );
      return store;
    } catch (error) {
      db?.close();
      lease.release();
      throw error;
    }
  }
  constructor(db, secret, lease, limits) {
    this.db = db;
    this.key = createHash("sha256")
      .update("otpigeon.node.storage.v1\0" + secret)
      .digest();
    this.lease = lease;
    this.limits = limits;
  }
  seal(value, context = "meta") {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  unseal(value, context = "meta") {
    const data = Buffer.from(value, "base64");
    try {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        data.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          cipher.update(data.subarray(28)),
          cipher.final(),
        ]).toString(),
      );
    } catch {
      throw new MessagingError(
        "STORAGE_KEY_MISMATCH",
        "Cannot decrypt gateway storage; check storageSecret",
      );
    }
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  enqueue(scope, keyHash, idem, payload, webhook) {
    const hash = digest(JSON.stringify(payload)),
      now = Date.now();
    return this.tx(() => {
      const previous = this.db
        .prepare("SELECT * FROM jobs WHERE scope=? AND idem=?")
        .get(scope, idem);
      if (previous) {
        if (previous.hash !== hash)
          throw new MessagingError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key already used for a different message",
          );
        return this.public(previous);
      }
      const pending = this.db
        .prepare(
          "SELECT count(*) AS n FROM jobs WHERE scope=? AND status IN ('queued','sending')",
        )
        .get(scope).n;
      const records = this.db.prepare("SELECT count(*) AS n FROM jobs").get().n;
      if (
        pending >= this.limits.maxPending ||
        records >= this.limits.maxRecords ||
        this.bytes() +
          Math.ceil((Buffer.byteLength(JSON.stringify(payload)) * 4) / 3) +
          40 >
          this.limits.maxStoredBytes * 0.75
      )
        throw new MessagingError(
          "QUEUE_FULL",
          "Gateway storage admission limit reached; prune or apply backpressure",
        );
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO jobs(id,scope,key_hash,idem,hash,payload,status,created,expires) VALUES(?,?,?,?,?,?,'queued',?,?)",
        )
        .run(
          id,
          scope,
          keyHash,
          idem,
          hash,
          this.seal(payload, "job:" + scope),
          now,
          now + 86400000,
        );
      this.event(scope, { type: "message.queued", messageId: id }, webhook);
      return this.get(scope, id);
    });
  }
  public(row) {
    return row
      ? {
          id: row.id,
          status: row.status,
          providerId: row.provider_id ?? null,
          reason: row.reason ?? null,
          createdAt: new Date(row.created).toISOString(),
        }
      : null;
  }
  get(scope, id) {
    return this.public(
      this.db
        .prepare("SELECT * FROM jobs WHERE id=? AND scope=?")
        .get(id, scope),
    );
  }
  next(scope) {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE scope=? AND status='queued' ORDER BY created,id LIMIT 1",
      )
      .get(scope);
  }
  begin(id, scope, webhook) {
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE jobs SET status='sending' WHERE id=? AND status='queued'",
        )
        .run(id);
      this.event(
        scope,
        { type: "message.sending", messageId: id },
        webhook,
        true,
      );
    });
  }
  finish(id, scope, status, providerId, reason, webhook) {
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE jobs SET status=?,provider_id=?,reason=?,payload=NULL WHERE id=?",
        )
        .run(status, providerId ?? null, reason ?? null, id);
      this.event(
        scope,
        {
          type: "message." + status,
          messageId: id,
          providerId: providerId ?? null,
          reason: reason ?? null,
        },
        webhook,
        true,
      );
    });
  }
  recover(webhookForScope) {
    for (const row of this.db
      .prepare("SELECT id,scope FROM jobs WHERE status='sending'")
      .all())
      this.finish(
        row.id,
        row.scope,
        "unknown",
        null,
        "process_interrupted",
        webhookForScope(row.scope),
      );
  }
  bytes() {
    return this.db
      .prepare(
        "SELECT (SELECT coalesce(sum(length(payload)),0) FROM jobs)+(SELECT coalesce(sum(length(payload)),0) FROM events) AS n",
      )
      .get().n;
  }
  event(scope, body, webhook, critical = false) {
    const now = Date.now();
    if (
      !critical &&
      (this.db.prepare("SELECT count(*) AS n FROM events").get().n >=
        this.limits.maxRecords * 6 ||
        this.bytes() +
          Math.ceil((Buffer.byteLength(JSON.stringify(body)) * 4) / 3) +
          40 >
          this.limits.maxStoredBytes * 0.75)
    )
      throw new MessagingError(
        "EVENTS_FULL",
        "Event storage limit reached; prune before accepting more work",
      );
    const row = this.db
      .prepare(
        "INSERT INTO events(scope,payload,created,webhook) VALUES(?,?,?,?) RETURNING id",
      )
      .get(scope, this.seal(body, "event:" + scope), now, webhook ? 1 : 0);
    return Number(row.id);
  }
  events(scope, after = 0, limit = 50) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE scope=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(scope, after, limit)
      .map((row) => this.eventPublic(row));
  }
  eventPublic(row) {
    return {
      id: Number(row.id),
      timestamp: new Date(row.created).toISOString(),
      ...this.unseal(row.payload, "event:" + row.scope),
      webhook: {
        status: { 0: "disabled", 1: "pending", 2: "delivered", 3: "exhausted" }[
          row.webhook
        ],
        attempts: row.attempts,
      },
    };
  }
  eventById(scope, id) {
    const row = this.db
      .prepare("SELECT * FROM events WHERE scope=? AND id=?")
      .get(scope, id);
    return row ? this.eventPublic(row) : null;
  }
  nextWebhook(scope) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE scope=? AND webhook=1 AND next_at<=? ORDER BY id LIMIT 1",
      )
      .get(scope, Date.now());
  }
  webhookAttempt(id, attempts, nextAt, done) {
    this.db
      .prepare("UPDATE events SET attempts=?,next_at=?,webhook=? WHERE id=?")
      .run(attempts, nextAt, done === "exhausted" ? 3 : done ? 2 : 1, id);
  }
  prune() {
    const cutoff = Date.now() - this.limits.retentionMs;
    return this.tx(() => ({
      jobs: Number(
        this.db
          .prepare(
            "DELETE FROM jobs WHERE created<? AND status NOT IN ('queued','sending')",
          )
          .run(cutoff).changes,
      ),
      events: Number(
        this.db
          .prepare("DELETE FROM events WHERE created<? AND webhook<>1")
          .run(cutoff).changes,
      ),
    }));
  }
  close() {
    this.db.close();
    this.key.fill(0);
    this.lease.release();
  }
}

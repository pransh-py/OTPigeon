import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { MessagingError, integer, invalid } from "./errors.js";
import { isPhone } from "./message.js";
/** Single-process, memory-only helper. Use the Python gateway for durable verification. */
export class MemoryVerification {
  constructor({
    client,
    ttlMs = 300000,
    cooldownMs = 60000,
    maxAttempts = 5,
    maxChallenges = 1000,
    clock = Date.now,
  }) {
    if (!client) throw invalid("client is required");
    integer(ttlMs, "ttlMs", 1000, 900000);
    integer(cooldownMs, "cooldownMs", 1000, 900000);
    integer(maxAttempts, "maxAttempts", 1, 10);
    integer(maxChallenges, "maxChallenges", 1, 10000);
    Object.assign(this, {
      client,
      ttlMs,
      cooldownMs,
      maxAttempts,
      maxChallenges,
      clock,
    });
    this.secret = randomBytes(32);
    this.challenges = new Map();
    this.scopes = new Map();
  }
  hash(id, code) {
    return createHmac("sha256", this.secret)
      .update(id + "\0" + code)
      .digest();
  }
  async issue({ to, purpose }) {
    if (
      !isPhone(to) ||
      typeof purpose !== "string" ||
      purpose !== purpose.trim() ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(purpose)
    )
      throw invalid(
        "Provide an international to and a short purpose identifier",
      );
    const now = this.clock();
    for (const [id, row] of this.challenges)
      if (row.expires <= now) this.challenges.delete(id);
    for (const [scope, row] of this.scopes)
      if (row.available <= now && !this.challenges.has(row.id))
        this.scopes.delete(scope);
    const scope = to + ":" + purpose,
      previous = this.scopes.get(scope);
    if (previous?.available > now)
      throw new MessagingError(
        "COOLDOWN",
        "Wait before requesting another code",
        { retryAfterMs: previous.available - now },
      );
    if (
      this.challenges.size >= this.maxChallenges ||
      (!previous && this.scopes.size >= this.maxChallenges)
    )
      throw new MessagingError("QUEUE_FULL", "Verification capacity reached");
    const id = randomUUID(),
      code = String(randomInt(1000000)).padStart(6, "0");
    const row = {
      id,
      to,
      purpose,
      expires: now + this.ttlMs,
      hash: this.hash(id, code),
      attempts: 0,
      status: "issuing",
    };
    if (previous) this.challenges.delete(previous.id);
    this.challenges.set(id, row);
    this.scopes.set(scope, { id, available: now + this.cooldownMs });
    let delivery;
    try {
      delivery = await this.client.sendText({
        to,
        text: `Your ${purpose} code is ${code}. It expires in ${Math.ceil(this.ttlMs / 60000)} minutes. Do not share this code.`,
      });
      row.status = "pending";
    } catch (error) {
      if (error instanceof MessagingError && error.outcome === "unknown") {
        row.status = "pending";
        delivery = { status: "unknown" };
      } else {
        this.challenges.delete(id);
        throw error;
      }
    }
    return {
      challengeId: id,
      to,
      purpose,
      expiresAt: new Date(row.expires).toISOString(),
      delivery,
    };
  }
  verify({ challengeId, to, purpose, code }) {
    const row = this.challenges.get(challengeId);
    if (!row || row.to !== to || row.purpose !== purpose)
      return { verified: false, reason: "not_found" };
    if (row.expires <= this.clock())
      return { verified: false, reason: "expired" };
    if (row.status === "verified")
      return { verified: false, reason: "already_verified" };
    if (row.status !== "pending")
      return { verified: false, reason: row.status };
    if (row.attempts >= this.maxAttempts)
      return { verified: false, reason: "locked" };
    row.attempts++;
    const match =
      typeof code === "string" &&
      /^[0-9]{6}$/.test(code) &&
      code === code.trim() &&
      timingSafeEqual(row.hash, this.hash(challengeId, code));
    if (match) {
      row.status = "verified";
      return { verified: true, reason: "verified" };
    }
    return {
      verified: false,
      reason: row.attempts >= this.maxAttempts ? "locked" : "invalid_code",
    };
  }
}

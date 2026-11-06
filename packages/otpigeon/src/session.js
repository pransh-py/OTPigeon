import { mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { MessagingError, invalid } from "./errors.js";

/** Local OS-backed exclusive ownership; never use across network filesystems. */
export class SessionLease {
  constructor(path, name) {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
      name !== name.trim()
    )
      throw invalid(
        "sessionId must contain 1–64 ASCII letters, digits, _ or -",
      );
    if (typeof path !== "string" || !path.length)
      throw invalid("sessionPath must be a persistent local directory");
    this.directory = resolve(path);
    this.name = name;
  }
  async acquire() {
    if (this.db) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import("node:sqlite");
    let db;
    try {
      const path = resolve(this.directory, this.name + ".owner.sqlite");
      db = new DatabaseSync(path, { timeout: 0 });
      await chmod(path, 0o600);
      db.exec("BEGIN EXCLUSIVE");
      this.db = db;
    } catch {
      db?.close();
      throw new MessagingError(
        "SESSION_LOCKED",
        "Session storage is unavailable or already owned by another process",
      );
    }
  }
  release() {
    this.db?.close();
    this.db = null;
  }
}

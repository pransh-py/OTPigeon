import { EventEmitter } from "node:events";
import { MessagingError, unknown } from "./errors.js";
import { SessionLease } from "./session.js";

/** Unofficial browser transport. Loads the optional engine only on connect(). */
export class WhatsAppWebTransport extends EventEmitter {
  constructor({
    sessionId = "default",
    sessionPath = ".otpigeon",
    puppeteer = {},
    engineLoader = () => import("whatsapp-web.js"),
  } = {}) {
    super();
    if (
      puppeteer.userDataDir ||
      puppeteer.browserWSEndpoint ||
      puppeteer.browserURL
    )
      throw new MessagingError(
        "INVALID_ARGUMENT",
        "OTPigeon owns the browser profile; remote browser attachment is unsupported",
      );
    this.lease = new SessionLease(sessionPath, sessionId);
    this.puppeteer = { ...puppeteer };
    this.loadEngine = engineLoader;
    this.simulated = false;
    this.generation = 0;
  }
  async connect() {
    if (this.closing) await this.closing;
    if (this.opening) return this.opening;
    if (this.client) await this.close();
    this.opening = this._open(++this.generation);
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }
  async _open(generation) {
    await this.lease.acquire();
    if (generation !== this.generation) {
      this.lease.release();
      return;
    }
    try {
      let engine;
      try {
        const loaded = await this.loadEngine();
        engine = loaded.default ?? loaded;
      } catch {
        throw new MessagingError(
          "ENGINE_MISSING",
          "Install the optional whatsapp-web.js@1.34.7 engine and its Chromium dependencies",
        );
      }
      if (generation !== this.generation) return;
      const client = (this.client = new engine.Client({
        authStrategy: new engine.LocalAuth({
          dataPath: this.lease.directory,
          clientId: this.lease.name,
        }),
        puppeteer: { headless: true, ...this.puppeteer },
        takeoverOnConflict: false,
      }));
      this.engine = engine;
      const emit = (event, value) => {
        if (generation === this.generation) this.emit(event, value);
      };
      client.on("qr", (value) => {
        emit("state", { state: "qr" });
        emit("qr", value);
      });
      client.on("authenticated", () =>
        emit("state", { state: "authenticated" }),
      );
      client.on("ready", () => emit("state", { state: "ready" }));
      client.on("auth_failure", () => emit("state", { state: "auth_failed" }));
      client.on("disconnected", (reason) =>
        emit("state", {
          state: "disconnected",
          reason: reason === "LOGOUT" ? "logged_out" : "disconnected",
        }),
      );
      client.on("message", (message) => {
        if (message.fromMe || message.isStatus) return;
        emit("message", {
          id: message.id?._serialized,
          chatId: message.from,
          text: message.body,
          type: message.type,
          hasMedia: message.hasMedia,
        });
      });
      client.on("message_ack", (message, ack) => {
        const state = {
          0: "pending",
          1: "server_ack",
          2: "delivered",
          3: "read",
          4: "played",
          "-1": "failed",
        }[ack];
        if (state && message.fromMe)
          emit("delivery", { id: message.id?._serialized, status: state });
      });
      await client.initialize();
    } catch (error) {
      if (this.client) {
        if (generation === this.generation)
          this.emit("state", { state: "disconnected" });
        // Keep ownership if destroying a browser fails; a second owner is unsafe.
        await this.client.destroy();
        this.client = null;
      }
      this.lease.release();
      throw error;
    }
  }
  async send(message) {
    const client = this.client;
    if (!client)
      throw new MessagingError("NOT_READY", "Browser is not connected");
    let chatId = message.chatId;
    if (!chatId) {
      let number;
      try {
        number = await client.getNumberId(message.to.slice(1));
      } catch {
        throw new MessagingError(
          "LOOKUP_FAILED",
          "Recipient lookup failed before dispatch",
        );
      }
      if (!number?._serialized)
        throw new MessagingError(
          "RECIPIENT_UNAVAILABLE",
          "Recipient is not available on WhatsApp",
        );
      chatId = number._serialized;
    }
    const options = {
      ...(message.replyTo ? { quotedMessageId: message.replyTo } : {}),
      ...(message.caption !== undefined ? { caption: message.caption } : {}),
      ...(message.kind === "document" ? { sendMediaAsDocument: true } : {}),
    };
    const content =
      message.kind === "text"
        ? message.text
        : new this.engine.MessageMedia(
            message.mimeType,
            message.data.toString("base64"),
            message.filename,
          );
    try {
      const result = await client.sendMessage(chatId, content, options);
      if (!result?.id?._serialized) throw unknown();
      return { id: result.id._serialized };
    } catch {
      throw unknown();
    }
  }
  close() {
    if (this.closing) return this.closing;
    ++this.generation;
    this.closing = (async () => {
      // initialize() may still be launching Chromium. Wait for it before releasing
      // ownership; callers can time out, but another profile owner stays blocked.
      try {
        await this.opening;
      } catch {
        /* _open cleaned up or retained the lock */
      }
      if (this.client) {
        await this.client.destroy();
        this.client = null;
      }
      this.lease.release();
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }
}

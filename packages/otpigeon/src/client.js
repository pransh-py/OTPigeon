import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { MessagingError, integer, unknown } from "./errors.js";
import { normalizeMessage, isChatId } from "./message.js";
import { WhatsAppWebTransport } from "./web.js";

export class MessagingClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.transport = options.transport ?? new WhatsAppWebTransport(options);
    this.maxPending = integer(
      options.maxPending ?? 100,
      "maxPending",
      0,
      10000,
    );
    this.maxMediaBytes = integer(
      options.maxMediaBytes ?? 8 * 1024 * 1024,
      "maxMediaBytes",
      1,
      20 * 1024 * 1024,
    );
    this.minIntervalMs = integer(
      options.minIntervalMs ?? 250,
      "minIntervalMs",
      0,
    );
    this.sendTimeoutMs = integer(
      options.sendTimeoutMs ?? 30000,
      "sendTimeoutMs",
    );
    this.connectTimeoutMs = integer(
      options.connectTimeoutMs ?? 120000,
      "connectTimeoutMs",
    );
    this.closeTimeoutMs = integer(
      options.closeTimeoutMs ?? 10000,
      "closeTimeoutMs",
    );
    this.reconnect = {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      ...options.reconnect,
    };
    integer(this.reconnect.maxAttempts, "reconnect.maxAttempts", 0, 20);
    integer(this.reconnect.initialDelayMs, "reconnect.initialDelayMs");
    integer(
      this.reconnect.maxDelayMs,
      "reconnect.maxDelayMs",
      this.reconnect.initialDelayMs,
    );
    this._state = "idle";
    this._reason = null;
    this._queue = [];
    this._active = null;
    this._lastStart = -Infinity;
    this._attempts = 0;
    this._acceptEvents = false;
    this._handlers = {
      state: (value) => this._onState(value),
      qr: (qr) => {
        if (this._acceptEvents) this._notify("qr", qr);
      },
      message: (message) => this._incoming(message),
      delivery: (receipt) => {
        if (this._acceptEvents) this._notify("delivery", { ...receipt });
      },
    };
    for (const [event, handler] of Object.entries(this._handlers))
      this.transport.on(event, handler);
  }
  status() {
    return {
      state: this._state,
      reason: this._reason,
      queued: this._queue.length,
      inFlight: !!this._active,
      reconnectAttempts: this._attempts,
    };
  }
  _notify(event, value) {
    for (const listener of this.rawListeners(event)) {
      try {
        Promise.resolve(listener.call(this, value)).catch(() =>
          this._handlerFailed(event),
        );
      } catch {
        this._handlerFailed(event);
      }
    }
  }
  _handlerFailed(event) {
    if (event !== "handler_error")
      this._notify(
        "handler_error",
        new MessagingError(
          "HANDLER_FAILED",
          `Application handler for ${event} failed`,
        ),
      );
  }
  _stateTo(state, reason = null) {
    this._state = state;
    this._reason = reason;
    this._notify("state", this.status());
  }
  connect() {
    if (["closing", "closed"].includes(this._state))
      return Promise.reject(
        new MessagingError("CLIENT_CLOSED", "Create a new client after close"),
      );
    if (this._connecting) return this._connecting.promise;
    if (this._state === "ready") return Promise.resolve();
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._acceptEvents = true;
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const pending = { promise, resolve, reject };
    this._connecting = pending;
    pending.timer = setTimeout(() => {
      if (this._connecting !== pending) return;
      this._acceptEvents = false;
      this._finishConnect(
        new MessagingError(
          "CONNECT_TIMEOUT",
          "Connection timed out; inspect QR/state events and reconnect",
        ),
      );
      this._stateTo("disconnected", "connect_timeout");
      // The adapter serializes close with any initialization still in progress.
      void this.transport.close().catch(() => {
        if (!["closing", "closed"].includes(this._state))
          this._stateTo("disconnected", "close_failed");
      });
    }, this.connectTimeoutMs);
    this._stateTo("connecting");
    Promise.resolve()
      .then(() => {
        if (this._connecting === pending && this._acceptEvents)
          return this.transport.connect();
      })
      .catch((error) => {
        if (this._connecting !== pending) return;
        this._acceptEvents = false;
        this._finishConnect(
          error instanceof MessagingError
            ? error
            : new MessagingError(
                "CONNECT_FAILED",
                "Could not start the WhatsApp transport",
              ),
        );
        this._stateTo("disconnected", "connect_failed");
      });
    return promise;
  }
  _finishConnect(error) {
    const pending = this._connecting;
    if (!pending) return;
    this._connecting = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }
  _onState({ state, reason } = {}) {
    if (!this._acceptEvents || ["closing", "closed"].includes(this._state))
      return;
    if (state === "ready") {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._attempts = 0;
      this._stateTo("ready");
      this._finishConnect();
      this._pump();
    } else if (state === "qr" || state === "authenticated")
      this._stateTo(state);
    else if (state === "disconnected" || state === "auth_failed") {
      if (state === "auth_failed" || reason === "logged_out")
        this._acceptEvents = false;
      this._stateTo(state, reason === "logged_out" ? "logged_out" : state);
      this._finishConnect(
        new MessagingError(
          state === "auth_failed" ? "AUTH_FAILED" : "DISCONNECTED",
          "Connection ended before becoming ready",
        ),
      );
      this._rejectWork();
      if (state !== "auth_failed" && reason !== "logged_out")
        this._scheduleReconnect();
    }
  }
  _scheduleReconnect() {
    if (
      ["closing", "closed", "auth_failed"].includes(this._state) ||
      this._reconnectTimer ||
      this._attempts >= this.reconnect.maxAttempts
    )
      return;
    const delay = Math.min(
      this.reconnect.maxDelayMs,
      this.reconnect.initialDelayMs * 2 ** this._attempts++,
    );
    this._stateTo("reconnecting", "disconnected");
    if (this._state !== "reconnecting") return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {
        if (!["closed", "closing", "auth_failed"].includes(this._state))
          this._scheduleReconnect();
      });
    }, delay);
  }
  replyText({ chatId, replyTo, text }) {
    return this._enqueue("text", { chatId, replyTo, text }, true);
  }
  sendText(input) {
    return this._enqueue("text", input);
  }
  sendImage(input) {
    return this._enqueue("image", input);
  }
  sendDocument(input) {
    return this._enqueue("document", input);
  }
  async _enqueue(kind, input, internal = false) {
    const message = normalizeMessage(kind, input, this.maxMediaBytes, internal);
    if (this._state !== "ready")
      throw new MessagingError(
        "NOT_READY",
        "Connect and wait for ready before sending",
      );
    if (this._active && this._queue.length >= this.maxPending)
      throw new MessagingError(
        "QUEUE_FULL",
        "Pending queue is full; apply backpressure",
      );
    return new Promise((resolve, reject) => {
      this._queue.push({
        message,
        id: randomUUID(),
        resolve,
        reject,
        settled: false,
      });
      this._pump();
    });
  }
  _settle(item, error, result) {
    if (item.settled) return;
    item.settled = true;
    clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(result);
  }
  _rejectWork() {
    for (const item of this._queue.splice(0))
      this._settle(
        item,
        new MessagingError("NOT_READY", "Connection closed before dispatch"),
      );
    if (this._active)
      this._settle(
        this._active,
        this._active.started
          ? unknown(this._active.id)
          : new MessagingError(
              "NOT_READY",
              "Connection closed before dispatch",
            ),
      );
  }
  async _pump() {
    if (this._active || !this._queue.length || this._state !== "ready") return;
    const item = (this._active = this._queue.shift());
    const wait = Math.max(
      0,
      this.minIntervalMs - (performance.now() - this._lastStart),
    );
    if (wait)
      await new Promise((resolve) => {
        this._throttleDone = resolve;
        this._throttleTimer = setTimeout(resolve, wait);
      });
    this._throttleDone = null;
    if (this._state !== "ready" || item.settled) {
      this._active = null;
      return;
    }
    item.started = true;
    this._lastStart = performance.now();
    item.timer = setTimeout(
      () => this._settle(item, unknown(item.id)),
      this.sendTimeoutMs,
    );
    try {
      const result = await this.transport.send(item.message);
      if (!result || typeof result.id !== "string" || !result.id)
        throw unknown(item.id);
      const value = {
        id: result.id,
        attemptId: item.id,
        to: item.message.to ?? item.message.chatId,
        status: "accepted",
        simulated: !!this.transport.simulated,
      };
      if (item.settled)
        this._notify("late_result", { attemptId: item.id, id: result.id });
      else this._settle(item, null, value);
    } catch (error) {
      this._settle(
        item,
        error instanceof MessagingError && error.outcome === "not_sent"
          ? error
          : unknown(item.id),
      );
    } finally {
      clearTimeout(item.timer);
      this._active = null;
      this._pump();
    }
  }
  _incoming(message) {
    if (
      !this._acceptEvents ||
      this._state !== "ready" ||
      !message ||
      !isChatId(message.chatId) ||
      typeof message.id !== "string" ||
      !message.id ||
      message.id.length > 256
    )
      return;
    const { id, chatId } = message;
    this._notify(
      "message",
      Object.freeze({
        id,
        chatId,
        text:
          typeof message.text === "string" ? message.text.slice(0, 65536) : "",
        type:
          typeof message.type === "string"
            ? message.type.slice(0, 32)
            : "unknown",
        textTruncated:
          typeof message.text === "string" && message.text.length > 65536,
        hasMedia: !!message.hasMedia,
        reply: (text) =>
          this._enqueue("text", { chatId, replyTo: id, text }, true),
      }),
    );
  }
  close() {
    if (this._closing) return this._closing;
    if (this._state === "closed") return Promise.resolve();
    this._acceptEvents = false;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._throttleTimer);
    this._throttleDone?.();
    this._stateTo("closing");
    this._finishConnect(
      new MessagingError("CLIENT_CLOSED", "Client closed while connecting"),
    );
    this._rejectWork();
    this._closing = (async () => {
      let timer;
      const operation = Promise.resolve().then(() => this.transport.close());
      try {
        await Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new MessagingError(
                    "CLOSE_TIMEOUT",
                    "Transport did not close; session ownership remains locked",
                  ),
                ),
              this.closeTimeoutMs,
            );
          }),
        ]);
        this._stateTo("closed");
      } catch (error) {
        const failure =
          error instanceof MessagingError
            ? error
            : new MessagingError(
                "CLOSE_FAILED",
                "Browser cleanup failed; investigate the existing session owner before restarting",
              );
        this._stateTo(
          "closing",
          failure.code === "CLOSE_TIMEOUT" ? "close_timeout" : "close_failed",
        );
        if (failure.code === "CLOSE_TIMEOUT")
          void operation.then(
            () => this._stateTo("closed"),
            () => {},
          );
        throw failure;
      } finally {
        clearTimeout(timer);
        for (const [event, handler] of Object.entries(this._handlers))
          this.transport.off(event, handler);
      }
    })();
    return this._closing;
  }
}

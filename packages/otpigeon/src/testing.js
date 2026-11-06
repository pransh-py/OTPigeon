import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
export class MockTransport extends EventEmitter {
  constructor() {
    super();
    this.simulated = true;
    this.sent = [];
    this.connectCalls = 0;
    this.closeCalls = 0;
  }
  async connect() {
    ++this.connectCalls;
    this.emit("state", { state: "ready" });
  }
  async close() {
    ++this.closeCalls;
  }
  async send(message) {
    this.sent.push(message);
    return this.sendHook
      ? this.sendHook(message)
      : { id: "mock_" + randomUUID() };
  }
  receive(message) {
    this.emit("message", { ...message });
  }
  disconnect(reason = "disconnected") {
    this.emit("state", { state: "disconnected", reason });
  }
}

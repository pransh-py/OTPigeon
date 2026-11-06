import { EventEmitter } from "node:events";
import type { TransportMessage } from "./index.js";
export class MockTransport extends EventEmitter {
  readonly simulated: true;
  sent: TransportMessage[];
  connectCalls: number;
  closeCalls: number;
  sendHook?: (message: TransportMessage) => Promise<{ id: string }>;
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: TransportMessage): Promise<{ id: string }>;
  receive(message: {
    id: string;
    chatId: string;
    text?: string;
    type?: string;
    hasMedia?: boolean;
  }): void;
  disconnect(reason?: string): void;
}

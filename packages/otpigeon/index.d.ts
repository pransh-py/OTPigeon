/// <reference types="node" />
import { EventEmitter } from "node:events";
export type ConnectionState =
  | "idle"
  | "connecting"
  | "qr"
  | "authenticated"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "auth_failed"
  | "closing"
  | "closed";
export interface ConnectionStatus {
  state: ConnectionState;
  reason: string | null;
  queued: number;
  inFlight: boolean;
  reconnectAttempts: number;
}
export interface TextMessage {
  to: string;
  text: string;
}
export interface MediaMessage {
  to: string;
  data: Uint8Array;
  mimeType: string;
  filename: string;
  caption?: string;
}
export interface SendResult {
  id: string;
  attemptId: string;
  to: string;
  status: "accepted";
  simulated: boolean;
}
export interface DeliveryReceipt {
  id: string;
  status: "pending" | "server_ack" | "delivered" | "read" | "played" | "failed";
}
export interface IncomingMessage {
  textTruncated: boolean;
  id: string;
  chatId: string;
  text: string;
  type: string;
  hasMedia: boolean;
  reply(text: string): Promise<SendResult>;
}
export interface TransportMessage {
  kind: "text" | "image" | "document";
  to?: string;
  chatId?: string;
  replyTo?: string;
  text?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
  caption?: string;
}
/** Transport must fence old connection events and settle sends at most once. */
export interface MessagingTransport extends EventEmitter {
  readonly simulated?: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: TransportMessage): Promise<{ id: string }>;
}
export interface ClientOptions {
  transport?: MessagingTransport;
  sessionId?: string;
  sessionPath?: string;
  puppeteer?: {
    executablePath?: string;
    headless?: boolean;
    args?: string[];
    timeout?: number;
  };
  maxPending?: number;
  maxMediaBytes?: number;
  minIntervalMs?: number;
  sendTimeoutMs?: number;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  reconnect?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
}
export class MessagingError extends Error {
  code: string;
  outcome: "not_sent" | "unknown";
  messageId?: string;
  retryAfterMs?: number;
  constructor(
    code: string,
    message: string,
    details?: {
      outcome?: "not_sent" | "unknown";
      messageId?: string;
      retryAfterMs?: number;
    },
  );
  toJSON(): {
    code: string;
    message: string;
    outcome: "not_sent" | "unknown";
    messageId?: string;
    retryAfterMs?: number;
  };
}
export class WhatsAppWebTransport
  extends EventEmitter
  implements MessagingTransport
{
  readonly simulated: false;
  constructor(
    options?: Pick<ClientOptions, "sessionId" | "sessionPath" | "puppeteer">,
  );
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: TransportMessage): Promise<{ id: string }>;
}
export class MessagingClient extends EventEmitter {
  readonly transport: MessagingTransport;
  constructor(options?: ClientOptions);
  connect(): Promise<void>;
  close(): Promise<void>;
  status(): ConnectionStatus;
  sendText(message: TextMessage): Promise<SendResult>;
  sendImage(message: MediaMessage): Promise<SendResult>;
  sendDocument(message: MediaMessage): Promise<SendResult>;
  replyText(message: {
    chatId: string;
    replyTo: string;
    text: string;
  }): Promise<SendResult>;
  on(event: "state", listener: (status: ConnectionStatus) => unknown): this;
  on(event: "qr", listener: (qr: string) => unknown): this;
  on(event: "message", listener: (message: IncomingMessage) => unknown): this;
  on(event: "delivery", listener: (receipt: DeliveryReceipt) => unknown): this;
  on(
    event: "handler_error",
    listener: (error: MessagingError) => unknown,
  ): this;
  on(
    event: "late_result",
    listener: (result: { attemptId: string; id: string }) => unknown,
  ): this;
}

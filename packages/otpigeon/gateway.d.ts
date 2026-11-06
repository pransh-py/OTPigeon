import type { MessagingClient, MessagingError } from "./index.js";
export interface GatewayProject {
  id: string;
  environment: "test" | "live";
  keyHashes: string[];
  client: MessagingClient;
  webhook?: { url: string; secret: string };
}
export interface Gateway {
  listen(options?: {
    port?: number;
    host?: string;
  }): Promise<{ host: string; address: string; port: number }>;
  close(): Promise<void>;
  runOnce(): Promise<unknown>;
  revokeKey(hash: string): void;
  prune(): { jobs: number; events: number };
}
export function createGateway(options: {
  databasePath: string;
  storageSecret: string;
  projects: GatewayProject[];
  maxStoredBytes?: number;
  isKeyActive?: (key: {
    hash: string;
    projectId: string;
    environment: "test" | "live";
  }) => Promise<boolean>;
  maxPending?: number;
  maxRecords?: number;
  retentionMs?: number;
  pollIntervalMs?: number;
  allowLiveDelivery?: boolean;
  fetch?: typeof globalThis.fetch;
  onError?: (error: MessagingError) => unknown;
}): Promise<Gateway>;
export function hashApiKey(key: string): string;
export function verifyWebhook(options: {
  body: string | Uint8Array;
  timestamp: string;
  signature: string;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean;

export function mongoKeyAuthorizer(collection: {
  findOne(
    query: Record<string, unknown>,
    options: { projection: { _id: 1 } },
  ): Promise<unknown>;
}): (key: {
  hash: string;
  projectId: string;
  environment: "test" | "live";
}) => Promise<boolean>;

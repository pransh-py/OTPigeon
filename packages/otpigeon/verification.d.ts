import type { MessagingClient, SendResult } from "./index.js";
export class MemoryVerification {
  constructor(options: {
    client: MessagingClient;
    ttlMs?: number;
    cooldownMs?: number;
    maxAttempts?: number;
    maxChallenges?: number;
    clock?: () => number;
  });
  issue(input: { to: string; purpose: string }): Promise<{
    challengeId: string;
    to: string;
    purpose: string;
    expiresAt: string;
    delivery: SendResult | { status: "unknown" };
  }>;
  verify(input: {
    challengeId: string;
    to: string;
    purpose: string;
    code: string;
  }): {
    verified: boolean;
    reason:
      | "not_found"
      | "expired"
      | "already_verified"
      | "issuing"
      | "pending"
      | "verified"
      | "locked"
      | "invalid_code";
  };
}

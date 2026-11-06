export type Environment = 'test' | 'live';
export type ChallengeStatus = 'pending' | 'verified' | 'expired' | 'locked' | 'superseded';
export interface Challenge {
  challenge_id: string; project_id: string; environment: Environment; destination: string; purpose: string;
  status: ChallengeStatus; created_at: string; expires_at: string; resend_available_at: string; attempts_remaining: number;
  delivery: {status: 'not_attempted' | 'queued' | 'sending' | 'provider_accepted' | 'provider_failed' | 'unknown' | 'delivered'; provider: string; simulated: boolean; reason: string | null};
}
export interface Verification extends Challenge {verified: boolean; reason: 'verified' | 'already_verified' | 'invalid_code' | 'locked' | 'expired' | 'superseded'}
export interface VerificationEvent {event_id: string; project_id: string; environment: Environment; sequence: number; timestamp: string; challenge_id: string | null; generation: string | null; type: string; reason: string | null; purpose: string | null; provider: string | null; simulated: boolean; destination: string}
export class OTPigeonError extends Error {status: number; code: string; retryAfter: number | null; idempotencyKey?: string}
export class OTPigeon {
  constructor(options: {baseUrl: string; apiKey: string; timeoutMs?: number; fetch?: typeof globalThis.fetch});
  create(body: {destination: string; purpose: string}, options?: {idempotencyKey?: string}): Promise<Challenge>;
  get(challengeId: string): Promise<Challenge>;
  resend(challengeId: string, options?: {idempotencyKey?: string}): Promise<Challenge>;
  verify(challengeId: string, code: string): Promise<Verification>;
  events(options?: {challengeId?: string; after?: number; limit?: number}): Promise<{items: VerificationEvent[]; next_cursor: number | null}>;
  list(options?: {before?: string; status?: ChallengeStatus; limit?: number}): Promise<{items: Challenge[]; next_cursor: string | null}>;
  testCode(challengeId: string): Promise<{challenge_id: string; environment: 'test'; simulated: true; code: string}>;
}

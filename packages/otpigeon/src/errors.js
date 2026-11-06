export class MessagingError extends Error {
  constructor(
    code,
    message,
    { outcome = "not_sent", messageId, retryAfterMs } = {},
  ) {
    super(message);
    this.name = "MessagingError";
    this.code = code;
    this.outcome = outcome;
    this.messageId = messageId;
    this.retryAfterMs = retryAfterMs;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      outcome: this.outcome,
      messageId: this.messageId,
      retryAfterMs: this.retryAfterMs,
    };
  }
}
export const invalid = (message) =>
  new MessagingError("INVALID_ARGUMENT", message);
export const unknown = (messageId) =>
  new MessagingError(
    "SEND_UNKNOWN",
    "Dispatch started but its outcome is uncertain. Do not automatically resend.",
    { outcome: "unknown", messageId },
  );
export function integer(value, name, min = 1, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw invalid(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

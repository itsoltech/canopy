export type MessengerErrorKind = "configuration" | "retryable" | "unknown_write";

/** Provider failures carry only fixed codes: provider responses and credentials never enter messages or logs. */
export class MessengerError extends Error {
  constructor(
    readonly kind: MessengerErrorKind,
    readonly code: string,
    readonly retryAfterMs?: number,
    provider = "Messenger",
  ) {
    super(`${provider} messenger: ${code}`);
    this.name = "MessengerError";
  }
}

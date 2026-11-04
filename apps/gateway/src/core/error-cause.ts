/** Error wrappers may be plain driver objects or Errors; their metadata remains untrusted. */
export function isErrorObject(cause: unknown): cause is { cause?: unknown; detail?: unknown; constraint?: unknown } {
  return cause !== null && typeof cause === "object";
}

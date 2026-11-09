import { ConnectError } from "@connectrpc/connect";

/** Domain failures are public gateway messages. Local transport causes never reach the viewer. */
export function attachmentFailure(cause: unknown, fallback: string): string {
  return cause instanceof ConnectError && cause.cause === undefined ? cause.rawMessage : fallback;
}

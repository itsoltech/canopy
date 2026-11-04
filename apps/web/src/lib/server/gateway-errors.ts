import { Code, ConnectError } from "@connectrpc/connect";

/** Gateway messages are public RPC errors; transport causes and local exceptions are server-only. */
export function gatewayFailure(cause: unknown) {
  if (!(cause instanceof ConnectError)) return { status: 500, message: "The gateway request failed" };

  const message = publicMessage(cause.rawMessage);

  switch (cause.code) {
    case Code.InvalidArgument:
      return { status: 400, message };
    case Code.NotFound:
      return { status: 404, message };
    case Code.PermissionDenied:
      return { status: 403, message };
    case Code.ResourceExhausted:
      return { status: 429, message };
    case Code.FailedPrecondition:
    case Code.AlreadyExists:
    case Code.Aborted:
      return { status: 409, message };
    case Code.Unimplemented:
      return { status: 426, message: "Update Canopy on your gateway to use this feature" };
    case Code.Unauthenticated:
      return {
        status: 401,
        message: "Desktop access is invalid or revoked. Pair this app again in gateway Settings → Devices",
      };
    case Code.Unavailable:
      return cause.cause === undefined
        ? { status: 503, message }
        : { status: 502, message: "The gateway is not available" };
    case Code.DeadlineExceeded:
      return { status: 504, message: "The gateway request timed out" };
    default:
      return { status: 500, message: cause.cause === undefined ? message : "The gateway request failed" };
  }
}

function publicMessage(message: string): string {
  return (
    message
      .split(/[\r\n]/, 1)[0]!
      .replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/gi, "[address]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
      .slice(0, 1000) || "The gateway request failed"
  );
}

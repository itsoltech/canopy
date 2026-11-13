import { Code, ConnectError } from "@connectrpc/connect";

/** Classification only; never construct another error or read its message/cause/payload. */
export function diagnosticErrorCode(error: Error) {
  if (error instanceof ConnectError) return error.code;

  return error.name === "AbortError" || error.name === "TimeoutError" ? Code.Canceled : Code.Unknown;
}

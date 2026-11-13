import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { rangeFailure, sanitizedRangeReason } from "./range-failure.ts";
import { MovedError, movedItems } from "./remote-policy.ts";

type WireError = { code: number; message: string; moved?: link.MovedItem[]; threadFailure?: link.ThreadRangeFailure };

/** Forward only typed errors, fixed sync categories and numeric sizes. */
export function remoteWireError(cause: unknown): WireError {
  const moved = movedItems(cause);

  if (moved && cause instanceof ConnectError)
    return { code: cause.code, message: cause.rawMessage.slice(0, 500), moved: moved.slice(0, 64) };

  if (cause instanceof ConnectError && cause.code > 0 && cause.code <= 16)
    return {
      code: cause.code,
      message: cause.rawMessage.slice(0, 500),
      ...(cause.metadata.get("canopy-error-scope") === "thread" && { threadFailure: rangeFailure("", cause) }),
    };

  return { code: Code.Internal, message: "internal error" };
}

export function remoteResponseError(response: link.RemoteResponse) {
  if (!response.code) return undefined;

  if (response.moved.length) return new MovedError(response.moved, response.message);
  const error = new ConnectError(response.message, response.code in Code ? response.code : Code.Internal);

  if (response.threadFailure) {
    const failure = rangeFailure(
      "",
      new ConnectError("", error.code, {
        "canopy-sync-reason": sanitizedRangeReason(response.threadFailure.reason),
        "canopy-frame-bytes": String(response.threadFailure.frameBytes),
      }),
    );

    error.metadata.set("canopy-error-scope", "thread");
    error.metadata.set("canopy-sync-reason", failure.reason);
    error.metadata.set("canopy-frame-bytes", String(failure.frameBytes));
  }

  return error;
}

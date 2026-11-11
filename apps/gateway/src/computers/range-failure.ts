import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";

export function rangeFailure(thread: string, error: ConnectError) {
  const code = error.code;
  const frameBytes = Number(error.metadata.get("canopy-frame-bytes") ?? 0);

  const reasons = new Map([
    [Code.ResourceExhausted, "size_limit"],
    [Code.DataLoss, "invalid_range"],
    [Code.OutOfRange, "invalid_cursor"],
    [Code.InvalidArgument, "invalid_record"],
    [Code.PermissionDenied, "access_denied"],
    [Code.NotFound, "thread_removed"],
    [Code.DeadlineExceeded, "timeout"],
    [Code.Unavailable, "stream_unavailable"],
  ]);

  return create(link.ThreadRangeFailureSchema, {
    threadId: thread,
    code,
    reason:
      error.metadata.get("canopy-sync-reason") === "decode_error"
        ? "decode_error"
        : (reasons.get(code) ?? "watch_failed"),
    frameBytes: Number.isSafeInteger(frameBytes) && frameBytes >= 0 && frameBytes <= 0xffffffff ? frameBytes : 0,
    retryable: [Code.Unavailable, Code.DeadlineExceeded, Code.Aborted].includes(code),
  });
}

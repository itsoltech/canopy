import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ui } from "@canopy/contracts";
import { resolvePendingSend } from "@canopy/domain/pending-send";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

export function uncertainDelivery(cause: unknown) {
  const failure = ConnectError.from(cause);

  return (
    [Code.DeadlineExceeded, Code.Canceled, Code.Unknown].includes(failure.code) ||
    (failure.code === Code.Unavailable &&
      failure.cause !== undefined &&
      failure.metadata.get("canopy-error-scope") !== "computer")
  );
}

/** Keep the immutable send locked through transport replacement and uncertain responses. */
export function confirmMessage(
  request: MessageInitShape<typeof ui.SendMessageRequestSchema>,
  connection: () => Client<typeof ui.GatewayService> | undefined,
  signal: AbortSignal,
  onWaiting: () => void,
  beforeAttempt?: () => Promise<void>,
) {
  return resolvePendingSend(
    async () => {
      await beforeAttempt?.();
      const api = connection();

      if (!api) throw new ConnectError("Waiting for connection", Code.Unknown);

      return api.sendMessage(request, { signal, timeoutMs: 20_000 });
    },
    {
      signal,
      uncertain: uncertainDelivery,
      onWaiting,
      maxAttempts: 1,
    },
  );
}

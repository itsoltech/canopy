import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ui } from "@canopy/contracts";
import { resolvePendingSend } from "@canopy/domain/pending-send";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

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

      if (!api) throw new ConnectError("Waiting for connection", Code.Unavailable);

      return api.sendMessage(request, { signal, timeoutMs: 20_000 });
    },
    {
      signal,
      uncertain: (cause) => {
        const failure = ConnectError.from(cause);

        return (
          [Code.DeadlineExceeded, Code.Unavailable, Code.Canceled, Code.Internal, Code.Unknown].includes(
            failure.code,
          ) || failure.metadata.get("canopy-error-scope") === "computer"
        );
      },
      onWaiting,
    },
  );
}

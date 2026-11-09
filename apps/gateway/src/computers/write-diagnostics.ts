import type { DescMethod, Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage } from "./remote.ts";

/** Only routing ids and outcomes; never payloads, addresses, or raw transport errors. */
export async function linkedWrite<A extends Message>(
  method: DescMethod,
  request: Message,
  peer: string,
  side: "home" | "sender",
  invoke: () => Promise<A>,
): Promise<A> {
  if (method.name !== "SendMessage") return invoke();
  const clientRequestId = linkedMessage(ui.SendMessageRequestSchema, request).clientRequestId;
  const started = performance.now();
  const details = () => ({ peer, side, clientRequestId, durationMs: Math.round(performance.now() - started) });

  try {
    const response = await invoke();
    const result = linkedMessage(ui.SendMessageResponseSchema, response);
    console.info("Linked message outcome", {
      ...details(),
      outcome: result.steer ? "steered" : result.turn ? "queued" : result.goal ? "goal_set" : "unknown",
      slow: performance.now() - started >= 1000,
    });

    return response;
  } catch (cause) {
    const failure = ConnectError.from(cause);

    const unknown = [Code.DeadlineExceeded, Code.Canceled, Code.Unavailable, Code.Internal, Code.Unknown].includes(
      failure.code,
    );

    console.warn("Linked message outcome", {
      ...details(),
      outcome: unknown ? "unknown" : "rejected",
      code: failure.code,
    });
    throw cause;
  }
}

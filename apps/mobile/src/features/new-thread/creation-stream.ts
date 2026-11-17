import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

/** Failures before admission are definitive; start/settlement failures still need reconciliation. */
export class ThreadPreparationFailed extends ConnectError {
  constructor() {
    super("Thread preparation failed", Code.Aborted);
  }
}

export async function streamThreadCreation(
  api: Client<typeof ui.GatewayService>,
  request: ui.CreateThreadRequest,
  progress: (event: ui.CreateThreadProgress) => void,
  signal: AbortSignal,
) {
  let received = false;

  try {
    for await (const event of api.createThreadWithProgress(request, { signal, timeoutMs: 110_000 })) {
      received = true;
      progress(event);

      if (event.status === "failed") {
        if (event.step === "start_thread") throw new ConnectError("Thread creation not confirmed", Code.Unknown);
        throw new ThreadPreparationFailed();
      }

      if (event.thread) return create(ui.CreateThreadResponseSchema, { thread: event.thread });
    }
  } catch (cause) {
    if (received || ConnectError.from(cause).code !== Code.Unimplemented) throw cause;
    progress(create(ui.CreateThreadProgressSchema, { step: "start_thread", label: "Start thread", status: "running" }));
    const result = await api.createThread(request, { signal, timeoutMs: 100_000 });

    if (result.thread)
      progress(
        create(ui.CreateThreadProgressSchema, {
          step: "start_thread",
          label: "Start thread",
          status: "completed",
          thread: result.thread,
        }),
      );

    return result;
  }

  throw new ConnectError("Thread creation not confirmed", Code.Unknown);
}

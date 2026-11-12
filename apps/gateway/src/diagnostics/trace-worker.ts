import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";

/** One pending request, no journal/retry/outbox or retained response. */
export class TraceWorkerClient {
  #pending: { id: string; resolve(value: ui.DiagnosticsTraceExport): void; reject(error: Error): void } | undefined;
  constructor(readonly send: (request: ui.DiagnosticsWorkerTraceRequest) => void) {}

  async call(request: ui.DiagnosticsTraceRequest) {
    if (this.#pending) throw new ConnectError("Tracing action is busy", Code.ResourceExhausted);
    const reply = Promise.withResolvers<ui.DiagnosticsTraceExport>();
    const requestId = crypto.randomUUID();
    this.#pending = { id: requestId, resolve: reply.resolve, reject: reply.reject };
    const timer = setTimeout(() => this.close(), 10_000);

    try {
      this.send(create(ui.DiagnosticsWorkerTraceRequestSchema, { requestId, request }));

      return await reply.promise;
    } finally {
      clearTimeout(timer);
      this.#pending = undefined;
    }
  }

  receive(reply: ui.DiagnosticsWorkerTraceReply) {
    if (reply.requestId !== this.#pending?.id) return;

    if (reply.code || !reply.result)
      this.#pending.reject(new ConnectError("Worker tracing is unavailable", Code.FailedPrecondition));
    else this.#pending.resolve(reply.result);
  }

  close() {
    this.#pending?.reject(new ConnectError("Worker tracing disconnected", Code.Unavailable));
    this.#pending = undefined;
  }
}

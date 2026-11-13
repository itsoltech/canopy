import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";

/** One pending primitive protocol request. Failed queries/errors are never retained by the exporter. */
export class LogPullClient {
  #pending: { id: string; resolve: (part: ui.DiagnosticsLogPart) => void; reject: (error: Error) => void } | undefined;
  constructor(
    readonly session: string,
    readonly send: (command: ui.DiagnosticsLogSourceCommand) => void,
  ) {}

  async next(transfer: string, signal: AbortSignal, begin?: ui.DiagnosticsHomeLogsRequest) {
    if (this.#pending) throw new ConnectError("Log source is busy", Code.ResourceExhausted);
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const reply = Promise.withResolvers<ui.DiagnosticsLogPart>();
    this.#pending = { id, resolve: reply.resolve, reject: reply.reject };
    const abort = () => this.close();
    const timer = setTimeout(abort, 15_000);
    signal.addEventListener("abort", abort, { once: true });

    try {
      this.send(
        create(ui.DiagnosticsLogSourceCommandSchema, {
          session: this.session,
          requestId: id,
          transferId: transfer,
          begin,
        }),
      );

      return await reply.promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#pending = undefined;
    }
  }

  receive(reply: ui.DiagnosticsLogSourceReply) {
    if (reply.session !== this.session || reply.requestId !== this.#pending?.id || !reply.part) return false;
    this.#pending.resolve(reply.part);

    return true;
  }

  cancel(transfer: string) {
    this.close();

    try {
      this.send(
        create(ui.DiagnosticsLogSourceCommandSchema, {
          session: this.session,
          requestId: crypto.randomUUID(),
          transferId: transfer,
          cancel: true,
        }),
      );
    } catch {
      /* Disconnected sources clean their bounded spool on their idle deadline. */
    }
  }

  close() {
    this.#pending?.reject(new ConnectError("Log source is unavailable", Code.Unavailable));
    this.#pending = undefined;
  }
}

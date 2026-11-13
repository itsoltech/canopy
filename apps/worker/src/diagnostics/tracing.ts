import { create } from "@bufbuild/protobuf";
import { ui, CommandSchema } from "@canopy/contracts";
import { DiagnosticsTrace, governorMetric, diagnosticMethodId } from "@canopy/domain/diagnostics";
import { processGovernor } from "@canopy/process-governor";

const commands = new Map(
  CommandSchema.fields
    .filter((field) => field.oneof?.name === "kind")
    .map((field) => [field.localName, diagnosticMethodId(`command:${field.localName}`)]),
);

/** A link-scoped lease cannot survive disconnect/restart or start other workers. */
export class WorkerTracing {
  readonly trace = new DiagnosticsTrace();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;
  #generation = 0;

  command(kind: string | undefined) {
    if (!this.trace.active || !kind) return;
    const id = commands.get(kind);

    if (id === undefined) return;
    const started = performance.now();
    const generation = this.#generation;

    return (failed: boolean) => {
      if (generation === this.#generation) this.trace.record("rpc", id, performance.now() - started, failed);
    };
  }

  receive(command: ui.DiagnosticsWorkerTraceRequest) {
    const request = command.request;
    let result: ui.DiagnosticsTraceExport | undefined;

    if (request?.action === "start" && this.trace.start(request.leaseId, request.processId, request.minutes)) {
      const lease = request.leaseId;
      this.#generation++;
      this.#unsubscribe?.();
      clearTimeout(this.#timer);
      this.#unsubscribe = processGovernor.observe((kind, priority, event, elapsed) => {
        if (event === "wait" || event === "execution")
          this.trace.record("governor", governorMetric(kind, priority, event), elapsed);
      });
      this.#timer = setTimeout(() => this.stop(lease), request.minutes * 60_000);
      this.#timer.unref();
      result = create(ui.DiagnosticsTraceExportSchema, { state: this.trace.state() });
    } else if (request?.action === "stop" && this.trace.stop(request.leaseId)) {
      this.stop(request.leaseId);
      result = create(ui.DiagnosticsTraceExportSchema, { state: this.trace.state() });
    } else if (request?.action === "export") result = this.trace.export(request.leaseId);

    return create(ui.DiagnosticsWorkerTraceReplySchema, { requestId: command.requestId, result, code: result ? 0 : 9 });
  }

  stop(lease: string) {
    if (!this.trace.stop(lease)) return;
    this.#generation++;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.trace.clear(), 600_000);
    this.#timer.unref();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  close() {
    this.#generation++;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.trace.clear();
  }
}

export const workerTracing = new WorkerTracing();

import { harnessMetric, type HarnessKind } from "@canopy/domain/diagnostics";
import { ItemDeltaField, TurnOutcome, type ThreadEvent } from "@canopy/contracts";
import type { WorkerDiagnostics } from "./worker.ts";

/** IDs only locate at most 64 active timings; no input, paths or output is retained. */
export class WorkerTurns {
  readonly active = new Map<
    string,
    {
      kind: HarnessKind;
      start: number;
      entered: boolean;
      text: boolean;
      assistant: string;
      humans: number;
      humanAt: number;
    }
  >();
  constructor(readonly diagnostics: WorkerDiagnostics) {}

  begin(thread: string, turn: string, kind: HarnessKind, enteredAt?: number) {
    if (!this.diagnostics.enabled) return;
    const key = `${thread}:${turn}`;
    const previous = this.active.get(key);

    if (previous?.entered) return;

    if ((!previous && this.active.size >= 64) || key.length > 160) {
      this.diagnostics.measurements.dropped++;

      return;
    }

    const start = enteredAt ?? this.diagnostics.monotonic();
    const queued = previous?.start;

    if (queued !== undefined) this.diagnostics.record(harnessMetric(kind, "queue"), start - queued);
    this.active.set(key, { kind, start, entered: true, text: false, assistant: "", humans: 0, humanAt: 0 });
  }

  queue(thread: string, turn: string, kind: HarnessKind) {
    if (this.active.has(`${thread}:${turn}`)) return;
    this.begin(thread, turn, kind);
    const value = this.active.get(`${thread}:${turn}`);

    if (value) value.entered = false;
  }

  finish(thread: string, turn: string, error = false, outcome = error ? TurnOutcome.FAILED : TurnOutcome.COMPLETED) {
    const key = `${thread}:${turn}`;
    const value = this.active.get(key);

    if (!value) return;

    if (!value.entered) {
      this.active.delete(key);

      return;
    }

    const now = this.diagnostics.monotonic();
    this.diagnostics.record(harnessMetric(value.kind, "turn"), now - value.start, error);
    this.diagnostics.record(
      harnessMetric(
        value.kind,
        outcome === TurnOutcome.COMPLETED
          ? "completed"
          : outcome === TurnOutcome.INTERRUPTED
            ? "interrupted"
            : outcome === TurnOutcome.FAILED
              ? "failed"
              : "unspecified",
      ),
      1,
    );

    if (value.humans) this.diagnostics.record(harnessMetric(value.kind, "human"), now - value.humanAt);
    this.active.delete(key);
  }

  event(event: ThreadEvent) {
    if (!this.diagnostics.enabled) return;
    const value = this.active.get(`${event.threadId}:${event.turnId}`);

    if (!value?.entered) return;

    if (event.body.case === "turnFinished") {
      this.finish(
        event.threadId,
        event.turnId,
        event.body.value.outcome === TurnOutcome.FAILED,
        event.body.value.outcome,
      );

      return;
    }

    const body = event.body;
    const item = body.case === "itemStarted" || body.case === "itemCompleted" ? body.value.item : undefined;

    if (item?.content.case === "agentMessage" && item.itemId.length <= 80) value.assistant = item.itemId;
    const text = item?.content.case === "agentMessage" && item.content.value.text;

    const delta =
      body.case === "itemDelta" &&
      body.value.itemId === value.assistant &&
      body.value.field === ItemDeltaField.TEXT &&
      body.value.chunk;

    if (!value.text && (text || delta)) {
      value.text = true;
      this.diagnostics.record(harnessMetric(value.kind, "ttft"), this.diagnostics.monotonic() - value.start);
    }
  }

  human(thread: string, turn: string) {
    const value = this.active.get(`${thread}:${turn}`);

    if (!value) return;

    if (!value.humans++) value.humanAt = this.diagnostics.monotonic();
  }

  humanDone(thread: string, turn: string) {
    const value = this.active.get(`${thread}:${turn}`);

    if (!value?.humans) return;

    if (!--value.humans)
      this.diagnostics.record(harnessMetric(value.kind, "human"), this.diagnostics.monotonic() - value.humanAt);
  }
}

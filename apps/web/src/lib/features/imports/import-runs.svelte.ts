import type { ui } from "@canopy/contracts";
import { getImportRun, importRunAction, listImportRuns } from "./api.ts";

const POLL_MS = 1500;

/** A paused run changes only when someone resumes or cancels it. */
const PAUSED_POLL_MS = 10_000;

const finished = (run: ui.ImportRun | undefined) => !!run && run.status !== "running" && run.status !== "paused";

/**
 * The owner's import runs (docs/import.md, "Przebieg"): the list, the open run with its threads, and actions.
 * While a run is running the list refreshes every 1.5 s, while paused every 10 s, never while the page is hidden;
 * it stops when nothing is in progress. An open run that already finished is not read again.
 */
export class ImportRunsState {
  runs = $state.raw<ui.ImportRun[]>([]);
  details = $state(new Map<string, ui.ImportRun>());
  error = $state("");
  busy = $state("");
  #timer: ReturnType<typeof setTimeout> | undefined;
  #onFinished: () => void;

  constructor(onFinished: () => void) {
    this.#onFinished = onFinished;
  }

  get active(): boolean {
    return this.runs.some((r) => r.status === "running" || r.status === "paused");
  }

  async load(): Promise<void> {
    const wasActive = this.active;

    try {
      this.runs = (await listImportRuns()).runs;

      for (const id of this.details.keys())
        if (!finished(this.details.get(id)) || !finished(this.runs.find((r) => r.id === id))) await this.open(id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Imports are unavailable. Try again.";
    }

    if (wasActive && !this.active) this.#onFinished();
    this.#schedule();
  }

  async open(runId: string): Promise<void> {
    const next = new Map(this.details);
    next.set(runId, await getImportRun(runId));
    this.details = next;
  }

  close(runId: string): void {
    const next = new Map(this.details);
    next.delete(runId);
    this.details = next;
  }

  async act(runId: string, action: "cancel" | "resume" | "undo"): Promise<void> {
    this.busy = `${runId}:${action}`;
    this.error = "";

    try {
      await importRunAction(runId, action);
      await this.load();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The action failed. Try again.";
    } finally {
      this.busy = "";
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    this.stop();

    if (!this.active) return;
    const running = this.runs.some((r) => r.status === "running");

    this.#timer = setTimeout(
      () => (document.hidden ? this.#schedule() : void this.load()),
      running ? POLL_MS : PAUSED_POLL_MS,
    );
  }
}

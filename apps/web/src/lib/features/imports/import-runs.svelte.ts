import type { ui } from "@canopy/contracts";
import { getImportRun, importRunAction, listImportRuns } from "./api.ts";

const POLL_MS = 1500;

/**
 * The owner's import runs (docs/import.md, "Przebieg"): the list, the open run with its threads, and actions.
 * While a run is running or paused the list refreshes every 1.5 s; it stops when nothing is in progress.
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

      for (const id of this.details.keys()) await this.open(id);
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

    if (this.active) this.#timer = setTimeout(() => void this.load(), POLL_MS);
  }
}

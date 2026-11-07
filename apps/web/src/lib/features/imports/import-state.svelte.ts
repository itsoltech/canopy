import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { listImportCandidates, scanImport, startImport } from "./api.ts";

export type Period = "7d" | "30d" | "90d" | "all";

const DAYS: Readonly<Record<Period, number>> = { "7d": 7, "30d": 30, "90d": 90, all: 0 };
const PERIODS: readonly Period[] = ["7d", "30d", "90d", "all"];

/** A period chosen in the segmented control (a plain string there). */
export function periodOf(value: string): Period {
  return PERIODS.find((p) => p === value) ?? "30d";
}

const PAGE = 200;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : "Something went wrong. Try again.");

/**
 * Settings → Import (docs/import.md): the scan of one worker, the filters and the selection. The selection is
 * "everything that matches" minus exclusions, or an explicit set: the default picks the last 30 days.
 */
export class ImportState {
  workerId = $state("");
  scan = $state.raw<ui.ScanImportResponse>();
  result = $state.raw<ui.ListImportCandidatesResponse>();
  scanning = $state(false);
  loading = $state(false);
  error = $state("");

  agentClis = $state<string[]>([]);
  period = $state<Period>("30d");
  search = $state("");
  directory = $state("");
  includeSubagents = $state(false);
  limit = $state(PAGE);

  /** Every matching thread is selected, except `excluded`; otherwise only `included`. */
  allMatching = $state(true);
  included = $state(new Set<string>());
  excluded = $state(new Set<string>());

  /** continue: threads continue where they can; history: every thread is read-only. */
  mode = $state<"continue" | "history">("continue");
  /** Directory → the owner's choice: `workspace:<id>`, `create_project`, `no_project` or `skip` (else the suggestion). */
  targets = $state(new Map<string, string>());
  starting = $state(false);

  #request = 0;

  filter(): MessageInitShape<typeof ui.ImportCandidateFilterSchema> {
    const days = DAYS[this.period];

    return {
      agentClis: this.agentClis,
      ...(days > 0 && { since: timestampFromMs(Date.now() - days * 86_400_000) }),
      directory: this.directory,
      search: this.search,
      includeSubagents: this.includeSubagents,
    };
  }

  async runScan(): Promise<void> {
    if (!this.workerId) return;
    this.scanning = true;
    this.error = "";
    this.scan = undefined;
    this.result = undefined;

    try {
      this.scan = await scanImport(this.workerId);
      this.resetSelection();
      await this.load();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.scanning = false;
    }
  }

  async load(): Promise<void> {
    const scan = this.scan;

    if (!scan) return;
    const request = ++this.#request;
    this.loading = true;

    try {
      const result = await listImportCandidates({
        scanId: scan.scanId,
        filter: create(ui.ImportCandidateFilterSchema, this.filter()),
        limit: this.limit,
      });

      if (request === this.#request) this.result = result;
    } catch (error) {
      if (request === this.#request) this.error = errorText(error);
    } finally {
      if (request === this.#request) this.loading = false;
    }
  }

  /** A filter changed: the selection follows the new matches. */
  refilter(): void {
    this.limit = PAGE;
    this.resetSelection();
    void this.load();
  }

  showMore(): void {
    this.limit += PAGE;
    void this.load();
  }

  resetSelection(): void {
    this.allMatching = true;
    this.included = new Set();
    this.excluded = new Set();
  }

  isSelected(key: string): boolean {
    return this.allMatching ? !this.excluded.has(key) : this.included.has(key);
  }

  toggle(key: string, selected: boolean): void {
    const set = new Set(this.allMatching ? this.excluded : this.included);

    if (selected === this.allMatching) set.delete(key);
    else set.add(key);

    if (this.allMatching) this.excluded = set;
    else this.included = set;
  }

  /** Selects or clears everything that matches the filters. */
  selectAll(selected: boolean): void {
    this.allMatching = selected;
    this.included = new Set();
    this.excluded = new Set();
  }

  setTarget(directory: string, choice: string): void {
    const next = new Map(this.targets);
    next.set(directory, choice);
    this.targets = next;
  }

  /** Starts the import of the selection; returns the run, or undefined after an error. */
  async start(): Promise<ui.ImportRun | undefined> {
    const scan = this.scan;

    if (!scan) return undefined;
    this.starting = true;
    this.error = "";

    try {
      const run = await startImport({
        scanId: scan.scanId,
        selection: {
          allMatching: this.allMatching,
          filter: this.filter(),
          included: [...this.included],
          excluded: [...this.excluded],
        },
        mappings: [...this.targets].flatMap(([directory, choice]) =>
          choice ? [{ directory, target: targetOf(choice) }] : [],
        ),
        mode: this.mode,
      });

      this.resetSelection();
      this.selectAll(false);
      await this.load();

      return run;
    } catch (error) {
      this.error = errorText(error);

      return undefined;
    } finally {
      this.starting = false;
    }
  }

  /** Threads that can be imported now (new ones); the others are listed but not selectable. */
  get selectable(): number {
    return this.result?.importable ?? 0;
  }

  get selectedCount(): number {
    return this.allMatching ? Math.max(0, this.selectable - this.excluded.size) : this.included.size;
  }
}

function targetOf(choice: string): MessageInitShape<typeof ui.ImportTargetSchema> {
  if (choice.startsWith("workspace:")) return { kind: "workspace", workspaceId: choice.slice("workspace:".length) };

  return { kind: choice };
}

import type { ui } from "@canopy/contracts";
import { scanImport } from "./api.ts";
import { agentCliName, counted } from "./labels.ts";

/**
 * The first-run suggestion (docs/import.md, "Wejścia i telefon"): an empty home with a worker that can import
 * offers its CLI threads once. One scan per worker and page load; the owner can dismiss it for good.
 */

const DISMISSED = "canopy:import-suggestion";

const scans = new Map<string, Promise<ui.ScanImportResponse | undefined>>();

/** The worker's scan, once per page load; undefined when it can't be scanned (offline, old, busy). */
export function suggestionScan(workerId: string): Promise<ui.ScanImportResponse | undefined> {
  let scan = scans.get(workerId);

  if (!scan) {
    scan = scanImport(workerId).catch(() => undefined);
    scans.set(workerId, scan);
  }

  return scan;
}

export function suggestionDismissed(): boolean {
  return localStorage.getItem(DISMISSED) === "dismissed";
}

export function dismissSuggestion(): void {
  localStorage.setItem(DISMISSED, "dismissed");
}

/** Sentence parts around the worker name; undefined when the worker has no threads to import. */
export function suggestionText(overview: readonly ui.ImportOverview[]) {
  const found = overview.filter((o) => o.threads > 0);
  const total = found.reduce((sum, o) => sum + o.threads, 0);

  if (total === 0) return undefined;
  const names = found.map((o) => agentCliName(o.agentCli));
  const clis = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

  return { prefix: `${clis} on`, suffix: `${names.length === 1 ? "has" : "have"} ${counted(total, "thread")}.` };
}

import type { ui } from "@canopy/contracts";

export interface WorkerChoicePresence {
  computer: string;
  online: boolean;
  status: string;
  reason?: string | undefined;
}

/** Presentation only: keep each home-qualified worker ID and the caller's availability rules. */
export function workerChoices(workers: readonly ui.Worker[], presence: (worker: ui.Worker) => WorkerChoicePresence) {
  const names = new Map<string, Set<string>>();

  for (const worker of workers) {
    const key = worker.name.trim().toLocaleLowerCase();
    const ids = names.get(key) ?? new Set<string>();
    ids.add(worker.id);
    names.set(key, ids);
  }

  return workers
    .map((worker) => ({
      worker,
      ...presence(worker),
      duplicate: (names.get(worker.name.trim().toLocaleLowerCase())?.size ?? 0) > 1,
    }))
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        a.worker.name.localeCompare(b.worker.name) ||
        a.computer.localeCompare(b.computer) ||
        a.worker.id.localeCompare(b.worker.id),
    );
}

/** Shared compact status for web and native pickers. */
export function workerStatusLabel(worker: ui.Worker, status: string): string {
  const os = osLabel(worker.os);

  return `${status}${os ? ` · ${os}` : ""}`;
}

function osLabel(os: string): string {
  switch (os) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return os;
  }
}

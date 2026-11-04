import type { ui } from "@canopy/contracts";

export function environmentSelected(
  selector: ui.EnvironmentSelector | undefined,
  worker: ui.EnvironmentWorker,
): boolean {
  if (!selector) return true;
  const tags = new Set([...worker.automaticTags, ...worker.manualTags]);

  if (selector.excludeTags.some((tag) => tags.has(tag))) return false;

  return (
    selector.everyone ||
    selector.workerIds.includes(worker.workerId) ||
    (selector.tags.length > 0 &&
      (selector.matchAllTags
        ? selector.tags.every((tag) => tags.has(tag))
        : selector.tags.some((tag) => tags.has(tag))))
  );
}

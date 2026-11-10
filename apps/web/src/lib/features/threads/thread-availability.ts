import type { ui } from "@canopy/contracts";

export function composerAvailability(thread: ui.Thread | undefined, worker: ui.Worker | undefined, away: boolean) {
  if (!thread) return undefined;

  if (thread.status === "failed") return "This thread failed to start and cannot take messages.";

  if (thread.status === "archived") return "This thread is archived.";

  if (away) return "Read only until it is connected again.";

  if (worker && !worker.online) return `${worker.name} is offline. Messages wait and are delivered when it reconnects.`;

  if (thread.status === "creating") return "The thread is starting on the worker. Messages run once it is ready.";

  return undefined;
}

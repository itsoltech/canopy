import type { ui } from "@canopy/contracts";
import { formatRelative } from "#lib/shared/format.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";
import { osLabel } from "#lib/features/overview/workers.ts";
import type { LinkedWorker } from "./worker-records.svelte.ts";

/** Where the worker runs, once: host, system and Canopy version; when it was last seen if it is away. */
export const workerMeta = (worker: ui.Worker): string =>
  [
    worker.hostname,
    worker.os && osLabel(worker.os),
    worker.version && `v${worker.version}`,
    !worker.online && worker.lastSeenAt && `seen ${formatRelative(worker.lastSeenAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");

/** How a connected worker reaches the gateway when it is not the local link. */
export function workerRoute(worker: ui.Worker): string {
  const status = worker.networkRouteStatus;

  if (!status || status.route === "local") return "";
  const route = status.route === "pinned" ? "Over the secure route" : "Over the server port";

  return status.detail ? `${route} · secure route unavailable: ${status.detail}` : route;
}

/** The one presence state a worker's header shows. */
export interface WorkerPresence {
  readonly label: string;
  readonly tone: Tone;
}

/** Revoked, connected, or not (a read-only linked worker counts as away). */
export function workerPresence(worker: ui.Worker, linked?: LinkedWorker): WorkerPresence {
  if (worker.revokedAt || linked?.record.revoked) return { label: "Revoked", tone: "rose" };

  return worker.online && !linked?.readOnly
    ? { label: "Connected", tone: "emerald" }
    : { label: "Disconnected", tone: "neutral" };
}

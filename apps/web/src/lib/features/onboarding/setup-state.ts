import type { ui } from "@canopy/contracts";
import type { ModelCatalogState } from "#lib/features/models/model-catalog.svelte.ts";
import { setupAgentReady } from "./setup-agent.ts";

export function chooseSetupWorker(
  workers: readonly ui.Worker[],
  workerId: string,
  catalog: Pick<ModelCatalogState, "of">,
  localDesktop: boolean,
): ui.Worker | undefined {
  const eligible = workers.filter((worker) => !worker.revokedAt);
  const selected = eligible.find((worker) => worker.id === workerId);
  const local = localDesktop ? eligible.find((worker) => worker.desktopBundled) : undefined;

  return (
    selected ??
    (local?.online ? local : undefined) ??
    eligible.find((worker) => setupAgentReady(worker, catalog.of(worker.id))) ??
    eligible.find((worker) => worker.online) ??
    local ??
    eligible[0]
  );
}

export function setupThreadHref(workspace: ui.Workspace): string {
  const target = new URLSearchParams({ project: workspace.projectId, workspace: workspace.id, setup: "1" });

  return `/threads/new?${target}`;
}

import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";

/** Workers and worker details share the environment revision and its live invalidations. */
export function workerEnvironment(overview: OverviewState): EnvironmentState {
  const environment = new EnvironmentState();

  $effect(() => {
    void environment.refresh();

    return overview.subscribe((update) => {
      if (["agentEnvironmentChanged", "worker", "workerRemoved"].includes(update.change.case ?? ""))
        void environment.refresh();
    });
  });

  $effect(() => {
    if (overview.resyncs > 0) void environment.refresh();
  });

  return environment;
}

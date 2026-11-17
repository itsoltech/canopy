import type { ui } from "@canopy/contracts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";

interface ThreadPlacement {
  project?: ui.Project;
  worker?: ui.Worker;
}

/** Linked project/worker names survive an unavailable computer's removal from the overview. */
export function rememberThreadPlacement(read: () => ui.Thread | undefined, overview: OverviewState) {
  let known: ThreadPlacement = {};
  const thread = $derived(read());

  const worker = $derived(
    overview.worker(thread?.workerId ?? "") ?? (known.worker?.id === thread?.workerId ? known.worker : undefined),
  );

  const project = $derived(
    overview.project(thread?.projectId ?? "") ?? (known.project?.id === thread?.projectId ? known.project : undefined),
  );

  $effect(() => {
    known = { ...(project && { project }), ...(worker && { worker }) };
  });

  return {
    get worker() {
      return worker;
    },
    get project() {
      return project;
    },
  };
}

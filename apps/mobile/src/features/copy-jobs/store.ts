import { useEffect, useSyncExternalStore } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { applyCopyJobChange, copyJobListed, copyJobRunning } from "@canopy/domain/workspace-copy-jobs";
import { useOverviewEvents, useOverviewStream } from "../../state/overview-bus";
import { useSession } from "../../state/session";
import { toast } from "../../ui/Toast";

type Client = NonNullable<ReturnType<typeof useSession>["client"]>;

/**
 * Background workspace copies (web: copy-jobs.svelte.ts): one list read when the overview stream is live, then
 * every change from the stream. Applying a change twice is harmless, so any number of screens may feed it.
 */
let jobs: ReadonlyMap<string, ui.WorkspaceCopyJob> = new Map();
let listed: ui.WorkspaceCopyJob[] = [];
const listeners = new Set<() => void>();

function publish(next: ReadonlyMap<string, ui.WorkspaceCopyJob>) {
  jobs = next;
  listed = [...next.values()].filter(copyJobListed).sort((a, b) => Number(a.createdMs - b.createdMs));

  for (const listener of listeners) listener();
}

export function applyCopyJobUpdate(update: ui.OverviewUpdate) {
  const next = applyCopyJobChange(jobs, update);

  if (!next) return;
  const change = update.change;

  if (change.case === "workspaceCopyJob" && change.value.status === "completed") {
    const before = jobs.get(change.value.id);

    if (before && copyJobRunning(before))
      toast(`Copied ${change.value.name} to ${change.value.targetName || "the worker"}`);
  }

  publish(next);
}

export const mergeCopyJob = (job: ui.WorkspaceCopyJob) =>
  applyCopyJobUpdate(create(ui.OverviewUpdateSchema, { change: { case: "workspaceCopyJob", value: job } }));

export function dropCopyJob(id: string) {
  applyCopyJobUpdate(create(ui.OverviewUpdateSchema, { change: { case: "workspaceCopyJobRemoved", value: id } }));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

/** The jobs, kept live while the calling screen is mounted. */
export function useCopyJobs() {
  const { client } = useSession();
  const stream = useOverviewStream();
  useOverviewEvents(applyCopyJobUpdate);

  useEffect(() => {
    if (client && stream.connection === "live") void loadCopyJobs(client);
  }, [client, stream.connection]);

  return {
    jobs: useSyncExternalStore(subscribe, () => jobs),
    listed: useSyncExternalStore(subscribe, () => listed),
  };
}

async function loadCopyJobs(client: Client) {
  const response = await client.api.listWorkspaceCopyJobs({}, { timeoutMs: 15_000 }).catch(() => undefined);

  if (response) publish(new Map(response.jobs.map((job) => [job.id, job])));
}

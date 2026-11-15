import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { applyCopyJobChange, copyJobListed, copyJobRunning } from "@canopy/domain/workspace-copy-jobs";
import { requestJson } from "#lib/shared/http.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { decode, encode } from "#lib/shared/wire.ts";

type JobEvents = {
  subscribe(listener: (update: ui.OverviewUpdate) => void): () => void;
};

/**
 * The tab's background workspace copies (docs/workspace-copy.md). One list read when the overview stream syncs;
 * after that every change arrives on the stream, a few times a second at most while a copy runs.
 */
class CopyJobsState {
  jobs = $state.raw<ReadonlyMap<string, ui.WorkspaceCopyJob>>(new Map());
  listed = $derived([...this.jobs.values()].filter(copyJobListed).sort((a, b) => Number(a.createdMs - b.createdMs)));
  #users = 0;
  #stop: (() => void) | undefined;

  /** Starts following the overview stream; returns the stop. Shared by every component that shows copies. */
  use(events: JobEvents): () => void {
    if (this.#users++ === 0) this.#stop = events.subscribe((update) => this.#apply(update));

    return () => {
      if (--this.#users === 0) this.#stop?.();
    };
  }

  async load(): Promise<void> {
    const response = decode(
      ui.ListWorkspaceCopyJobsResponseSchema,
      await requestJson("GET", "/api/workspaces/copy-jobs"),
    );

    this.jobs = new Map(response.jobs.map((job) => [job.id, job]));
  }

  /** Answers once the selection is authorized and the destination prepared; the copy then runs on its own. */
  async start(input: ui.CopyWorkspaceRequest): Promise<ui.WorkspaceCopyJob> {
    const job = decode(
      ui.WorkspaceCopyJobSchema,
      await requestJson("POST", "/api/workspaces/copy-jobs", encode(ui.CopyWorkspaceRequestSchema, input), 140_000),
    );

    this.#merge(job);

    return job;
  }

  async cancel(id: string) {
    this.#merge(await this.#action(id, "cancel"));
  }

  async retry(id: string) {
    this.#merge(await this.#action(id, "retry"));
  }

  async dismiss(id: string) {
    await requestJson("DELETE", `/api/workspaces/copy-jobs/${encodeURIComponent(id)}`);
    const next = new Map(this.jobs);
    next.delete(id);
    this.jobs = next;
  }

  async #action(id: string, action: "cancel" | "retry") {
    return decode(
      ui.WorkspaceCopyJobSchema,
      await requestJson("POST", `/api/workspaces/copy-jobs/${encodeURIComponent(id)}?action=${action}`, {}, 40_000),
    );
  }

  #merge(job: ui.WorkspaceCopyJob) {
    this.#apply(create(ui.OverviewUpdateSchema, { change: { case: "workspaceCopyJob", value: job } }));
  }

  #apply(update: ui.OverviewUpdate) {
    const next = applyCopyJobChange(this.jobs, update);

    if (!next) return;
    const change = update.change;

    // A quiet note for a copy this tab saw running; the new workspace is in the project already.
    if (change.case === "workspaceCopyJob" && change.value.status === "completed") {
      const before = this.jobs.get(change.value.id);

      if (before && copyJobRunning(before))
        toast(`Copied ${change.value.name} to ${change.value.targetName || "the worker"}`, { tone: "info" });
    }

    this.jobs = next;
  }
}

export const copyJobs = new CopyJobsState();

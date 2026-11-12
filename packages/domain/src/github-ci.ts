import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { mutationRequest, mutationUnconfirmed, sendMutation, type MutationApi } from "./github-mutations.ts";

export type CiAction = "all" | "failed" | "job" | "cancel";

export const ciLabel = (action: CiAction) =>
  ({ all: "Re-run", job: "Re-run", failed: "Re-run failed jobs", cancel: "Cancel" })[action];

/** Hide inapplicable actions before permissions/connectivity disable any remaining choices. */
export function ciActions(state: string, job = false): CiAction[] {
  if (["queued", "in_progress", "pending", "waiting", "requested"].includes(state)) return ["cancel"];

  if (
    !["success", "failure", "timed_out", "cancelled", "action_required", "neutral", "skipped", "completed"].includes(
      state,
    )
  )
    return [];

  return job
    ? ["job"]
    : ["all", ...(["failure", "timed_out", "action_required"].includes(state) ? ["failed" as const] : [])];
}

export const ciEffect = (action: CiAction) =>
  ({
    cancel:
      "This requests cancellation of the entire workflow run, including running deployments. Other pull requests sharing this run are affected.",
    job: "GitHub re-runs this job and its dependent jobs. Deployments may run again.",
    failed: "GitHub re-runs failed jobs and their dependent jobs. Deployments may run again.",
    all: "GitHub re-runs every job in this workflow run. Deployments may run again.",
  })[action];

export function ciReason(snapshot: github.PullRequestSnapshot, runId: string, state: string, action: CiAction) {
  if (!runId) return "This check uses an external CI provider. Open it on the provider to manage it.";

  if (snapshot.stale) return "Connect and refresh before changing CI.";

  if (snapshot.ciBlockingReason) return snapshot.ciBlockingReason;
  const active = ["queued", "in_progress", "pending", "waiting", "requested"].includes(state);

  if (action === "cancel" ? !active : active || state === "unknown")
    return "Refresh to check the workflow run's current state.";

  if (action === "failed" && !["failure", "timed_out", "cancelled", "action_required"].includes(state))
    return "This check has no failed jobs.";

  return "";
}

export interface CiState {
  busy: boolean;
  action: CiAction;
  open: boolean;
  jobId: string;
  jobName: string;
  detail: string;
  run?: github.PullRequestWorkflowRun | undefined;
  prepared?: github.PullRequestMutationRequest | undefined;
  receipt?: github.PullRequestMutationReceipt | undefined;
  expiresAt?: github.PullRequestMutationReceipt["expiresAt"];
}

export interface CiApi extends MutationApi {
  listPullRequestCheckJobs: (r: github.PullRequestPageRequest) => Promise<github.PullRequestJobsPage>;
}

/** Shared UI state keeps accepted/uncertain requests across rows, tabs and reconnects. No write retries. */
export class GitHubCiController {
  state: CiState = { busy: false, open: false, jobId: "", jobName: "", action: "all", detail: "" };
  #listeners = new Set<() => void>();
  constructor(
    readonly api: CiApi,
    public snapshot: github.PullRequestSnapshot,
    readonly runId: string,
    private uuid: () => string,
    private refused: (cause: unknown) => boolean,
    private detail: (cause: unknown) => string,
  ) {}
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
  read = () => this.state;
  patch(fields: Partial<CiState>) {
    this.state = { ...this.state, ...fields };

    for (const listener of this.#listeners) listener();
  }
  get blocked() {
    return (
      this.state.busy ||
      !!(this.state.receipt && (mutationUnconfirmed(this.state.receipt) || this.state.receipt.state === "accepted"))
    );
  }
  private async current() {
    const page = await this.api.listPullRequestCheckJobs(
      create(github.PullRequestPageRequestSchema, {
        pullRequestId: this.snapshot.summary?.ref?.id ?? "",
        resourceId: this.runId,
        headSha: this.snapshot.summary?.headSha ?? "",
        refresh: true,
      }),
    );

    if (!page.run || page.page?.stale || page.run.headSha !== this.snapshot.summary?.headSha)
      throw new Error("Could not verify this run. Refresh to retry.");

    return page.run;
  }
  async choose(action: CiAction, jobId = "", jobName = "") {
    if (this.blocked || this.snapshot.stale) return;
    this.patch({ busy: true, action, open: true, jobId, jobName, detail: "", prepared: undefined });

    try {
      const run = await this.current();
      this.patch({ run });
      const reason = ciReason(this.snapshot, run.id, run.state, action);

      if (reason) {
        this.patch({ detail: reason });

        return;
      }

      const modes = {
        all: github.PullRequestRerunMode.ALL_JOBS,
        failed: github.PullRequestRerunMode.FAILED_JOBS,
        job: github.PullRequestRerunMode.SINGLE_JOB,
        cancel: github.PullRequestRerunMode.UNSPECIFIED,
      };

      const request = mutationRequest(this.snapshot, this.uuid(), action === "cancel" ? "cancel_run" : "rerun_checks", {
        runId: run.id,
        runAttempt: run.attempt,
        jobId,
        rerunMode: modes[action],
      });

      const receipt = await this.api.preparePullRequestMutation(request);
      this.patch({ prepared: { ...request, confirmationId: receipt.confirmationId }, expiresAt: receipt.expiresAt });
    } catch (cause) {
      this.patch({ detail: this.detail(cause) || "Could not verify this run. Refresh to retry." });
    } finally {
      this.patch({ busy: false });
    }
  }
  async confirm() {
    const { prepared, expiresAt } = this.state;

    if (!prepared || this.blocked || this.snapshot.stale) return;

    if (
      prepared.accountId !== this.snapshot.accountId ||
      prepared.accessRevision !== this.snapshot.accessRevision ||
      prepared.headSha !== this.snapshot.summary?.headSha ||
      prepared.pullRequestId !== this.snapshot.summary?.ref?.id
    ) {
      this.patch({ prepared: undefined, detail: "Pull request or account changed. Close this dialog and refresh." });

      return;
    }

    if (!expiresAt || timestampDate(expiresAt).getTime() <= Date.now()) {
      this.patch({ prepared: undefined, detail: "Confirmation expired. Close this dialog and check the run again." });

      return;
    }

    this.patch({ busy: true });

    try {
      const receipt = await sendMutation(this.api, prepared, this.refused, this.detail);
      this.patch({ receipt, prepared: undefined, detail: receipt.detail });
    } finally {
      this.patch({ busy: false });
    }
  }
  async check() {
    if (this.state.busy) return;
    this.patch({ busy: true });

    try {
      const run = await this.current();
      this.patch({ run });
      // A read does not turn an uncertain write into success. Explicitly acknowledge before another action.
      this.patch({ receipt: undefined, prepared: undefined, detail: "", open: false });
    } catch (cause) {
      this.patch({ detail: this.detail(cause) || "Could not check this run. Refresh to retry." });
    } finally {
      this.patch({ busy: false });
    }
  }
}

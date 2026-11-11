import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { MutationScope } from "./mutation-preflight.ts";
import { mutationBudget } from "./mutation-http.ts";
import { numericId, job, workflowRun } from "./checks.ts";
import type { MutationRow } from "./store-mutations.ts";

export async function acceptCi(scope: MutationScope, r: github.PullRequestMutationRequest, row: MutationRow) {
  const { accounts } = scope.prs;

  const saved = await accounts.run((s) =>
    s.mutationFinish(
      row,
      "accepted",
      r.runId,
      r.action === "cancel_run"
        ? "Cancellation requested. Waiting for GitHub to update the checks."
        : "Re-run accepted. Waiting for GitHub to queue the jobs.",
    ),
  );

  scope.prs.client.memory.clear();

  return saved;
}

export const ciActions = ["rerun_checks", "cancel_run"];

export const ciParameters = (r: github.PullRequestMutationRequest) => ({
  runId: r.runId,
  jobId: r.jobId,
  runAttempt: r.runAttempt,
  rerunMode: r.rerunMode,
});

export function validateCi(r: github.PullRequestMutationRequest) {
  if (!ciActions.includes(r.action)) return;
  numericId(r.runId);
  const single = r.rerunMode === github.PullRequestRerunMode.SINGLE_JOB;

  if (single) numericId(r.jobId);

  if (
    !r.runAttempt ||
    r.body ||
    r.method ||
    (r.jobId && !single) ||
    (r.action === "cancel_run"
      ? r.rerunMode !== github.PullRequestRerunMode.UNSPECIFIED
      : ![
          github.PullRequestRerunMode.FAILED_JOBS,
          github.PullRequestRerunMode.ALL_JOBS,
          github.PullRequestRerunMode.SINGLE_JOB,
        ].includes(r.rerunMode))
  )
    throw new ConnectError("Choose a supported CI action and refresh the run.", Code.InvalidArgument);
}

async function read(scope: MutationScope, path: string) {
  const response = await scope.prs.accounts.http.detailed(
    path,
    {
      headers: { Authorization: `Bearer ${scope.access.token}` },
    },
    [scope.access.token, ...(scope.access.secrets ?? [])],
  );

  await mutationBudget(scope, response.value, response.headers);

  return response.value;
}

/** Fresh reads inside the shared write queue. Never infer a run or job from a details URL. */
export async function ciPreflight(scope: MutationScope, r: github.PullRequestMutationRequest) {
  const root = `/repos/${scope.pr.repository_name}`;
  const run = Schema.decodeUnknownSync(workflowRun)(await read(scope, `${root}/actions/runs/${r.runId}`));

  if (
    String(run.id) !== r.runId ||
    String(run.repository.id) !== scope.pr.repository_id ||
    run.head_sha !== r.headSha ||
    !run.pull_requests.some((p) => p.number === scope.pr.number)
  )
    throw new ConnectError("Check not found", Code.NotFound);

  if (run.run_attempt !== r.runAttempt)
    throw new ConnectError("This run has a new attempt. Refresh before changing it.", Code.FailedPrecondition);

  if (
    r.action === "cancel_run"
      ? !["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status ?? "")
      : run.status !== "completed"
  )
    throw new ConnectError("This run changed. Refresh to check its progress.", Code.FailedPrecondition);

  if (
    r.rerunMode === github.PullRequestRerunMode.FAILED_JOBS &&
    !["failure", "timed_out", "cancelled", "action_required"].includes(run.conclusion ?? "")
  )
    throw new ConnectError("This run has no failed jobs. Refresh to check its result.", Code.FailedPrecondition);

  if (r.rerunMode === github.PullRequestRerunMode.SINGLE_JOB) {
    const current = Schema.decodeUnknownSync(job)(await read(scope, `${root}/actions/jobs/${r.jobId}`));

    if (
      String(current.id) !== r.jobId ||
      String(current.run_id) !== r.runId ||
      current.run_attempt !== r.runAttempt ||
      current.head_sha !== r.headSha
    )
      throw new ConnectError("Job not found in this attempt", Code.NotFound);
  }

  const repo = Schema.decodeUnknownSync(
    Schema.Struct({ id: Schema.Number, permissions: Schema.Struct({ push: Schema.Boolean }) }),
  )(await read(scope, root));

  if (String(repo.id) !== scope.pr.repository_id || !repo.permissions.push)
    throw new ConnectError("This account cannot control CI. Check repository access.", Code.PermissionDenied);
}

export function ciMutation(scope: MutationScope, r: github.PullRequestMutationRequest) {
  const root = `/repos/${scope.pr.repository_name}/actions`;

  if (r.action === "cancel_run") return { path: `${root}/runs/${r.runId}/cancel`, method: "POST", body: {} };

  if (r.rerunMode === github.PullRequestRerunMode.SINGLE_JOB)
    return { path: `${root}/jobs/${r.jobId}/rerun`, method: "POST", body: {} };

  return {
    path: `${root}/runs/${r.runId}/${r.rerunMode === github.PullRequestRerunMode.FAILED_JOBS ? "rerun-failed-jobs" : "rerun"}`,
    method: "POST",
    body: {},
  };
}

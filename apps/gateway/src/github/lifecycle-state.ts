import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Option, Schema } from "effect";

export const LIFECYCLE_REPOSITORY_FIELDS = `mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed`;

export const LIFECYCLE_FIELDS = `mergeable mergeStateStatus reviewDecision isMergeQueueEnabled isInMergeQueue
maintainerCanModify viewerDidAuthor viewerCanUpdate viewerCanClose viewerCanReopen viewerCanUpdateBranch
viewerCanEnableAutoMerge viewerCanDisableAutoMerge autoMergeRequest{mergeMethod enabledBy{login}}
viewerMergeHeadlineText(mergeType:SQUASH) viewerMergeBodyText(mergeType:SQUASH)
headRef{repository{databaseId viewerPermission}}
commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;

export const LifecyclePull = Schema.Struct({
  id: Schema.String,
  headRefOid: Schema.String,
  baseRefOid: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  mergeable: Schema.String,
  mergeStateStatus: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  isMergeQueueEnabled: Schema.Boolean,
  isInMergeQueue: Schema.Boolean,
  maintainerCanModify: Schema.Boolean,
  viewerDidAuthor: Schema.Boolean,
  viewerCanUpdate: Schema.Boolean,
  viewerCanClose: Schema.Boolean,
  viewerCanReopen: Schema.Boolean,
  viewerCanUpdateBranch: Schema.Boolean,
  viewerCanEnableAutoMerge: Schema.Boolean,
  viewerCanDisableAutoMerge: Schema.Boolean,
  viewerMergeHeadlineText: Schema.String,
  viewerMergeBodyText: Schema.String,
  autoMergeRequest: Schema.NullOr(
    Schema.Struct({ mergeMethod: Schema.String, enabledBy: Schema.NullOr(Schema.Struct({ login: Schema.String })) }),
  ),
  headRef: Schema.NullOr(
    Schema.Struct({
      repository: Schema.Struct({ databaseId: Schema.Number, viewerPermission: Schema.NullOr(Schema.String) }),
    }),
  ),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({ statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })) }),
      }),
    ),
  }),
});

export const LifecycleRepository = Schema.Struct({
  databaseId: Schema.Number,
  viewerPermission: Schema.NullOr(Schema.String),
  mergeCommitAllowed: Schema.Boolean,
  squashMergeAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
  autoMergeAllowed: Schema.Boolean,
  pullRequest: Schema.NullOr(LifecyclePull),
});

export function lifecycleState(repo: typeof LifecycleRepository.Type, pr: typeof LifecyclePull.Type) {
  const write = ["WRITE", "MAINTAIN", "ADMIN"].includes(repo.viewerPermission ?? "");
  const open = pr.state === "OPEN";
  const reasons: string[] = [];

  if (pr.isDraft) reasons.push("This pull request is a draft. Mark it ready for review.");

  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    reasons.push("The branches have conflicts. Resolve them before merging.");

  if (pr.mergeable === "UNKNOWN" || ["UNKNOWN", "UNSTABLE"].includes(pr.mergeStateStatus))
    reasons.push("GitHub has not confirmed merge requirements. Refresh or check on GitHub.");

  if (["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(pr.reviewDecision ?? ""))
    reasons.push(
      pr.reviewDecision === "CHANGES_REQUESTED"
        ? "Changes are requested. Address the review before merging."
        : "Required reviews are missing. Request a review.",
    );
  const checks = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;

  if (checks && checks !== "SUCCESS") reasons.push("Checks have not passed. Check their results before merging.");

  if (pr.mergeStateStatus === "BEHIND") reasons.push("The branch is behind its base. Update the branch.");

  if (["BLOCKED", "HAS_HOOKS"].includes(pr.mergeStateStatus))
    reasons.push("Branch protection blocks merging. Check the requirements on GitHub.");

  if (!write) reasons.push("This account cannot merge. Check repository access.");

  const methods = [
    repo.mergeCommitAllowed && "MERGE",
    repo.squashMergeAllowed && "SQUASH",
    repo.rebaseMergeAllowed && "REBASE",
  ].filter((m): m is string => !!m);

  const actions: string[] = [];

  if (open && pr.viewerCanUpdate) actions.push(pr.isDraft ? "ready" : "draft");

  if (open && pr.viewerCanClose) actions.push("close");

  if (pr.state === "CLOSED" && pr.viewerCanReopen) actions.push("reopen");

  if (open && !pr.isDraft && write && !pr.isInMergeQueue && !reasons.length && methods.length)
    actions.push(pr.isMergeQueueEnabled ? "enqueue" : "merge");

  if (open && write && pr.isInMergeQueue) actions.push("dequeue");

  if (
    open &&
    repo.autoMergeAllowed &&
    !pr.isMergeQueueEnabled &&
    methods.length &&
    pr.viewerCanEnableAutoMerge &&
    !pr.isDraft
  )
    actions.push("enable_auto_merge");

  if (open && pr.viewerCanDisableAutoMerge && pr.autoMergeRequest) actions.push("disable_auto_merge");
  const headWrite = pr.headRef && ["WRITE", "MAINTAIN", "ADMIN"].includes(pr.headRef.repository.viewerPermission ?? "");

  // GitHub's capability includes fork consent; independently check the head repository write right.
  const fork = pr.headRef?.repository.databaseId !== repo.databaseId;

  const updateMethods = [repo.mergeCommitAllowed && "MERGE", repo.rebaseMergeAllowed && "REBASE"].filter(
    (m): m is string => !!m,
  );

  if (
    open &&
    pr.viewerCanUpdateBranch &&
    headWrite &&
    updateMethods.length &&
    (!fork || pr.viewerDidAuthor || pr.maintainerCanModify)
  )
    actions.push("update_branch");

  return create(github.PullRequestLifecycleSchema, {
    actions,
    mergeMethods: methods,
    updateMethods,
    updateBlockingReason:
      open && fork && (!headWrite || (!pr.viewerDidAuthor && !pr.maintainerCanModify))
        ? "Cannot update this fork. Check head repository write access and the author’s permission on GitHub."
        : "",
    blockingReasons: open ? reasons : [],
    queueRequired: pr.isMergeQueueEnabled,
    inQueue: pr.isInMergeQueue,
    autoMergeMethod: pr.autoMergeRequest?.mergeMethod ?? "",
    autoMergeAuthor: pr.autoMergeRequest?.enabledBy?.login ?? "",
    maintainerCanModify: pr.maintainerCanModify,
    mergeTitle: pr.viewerMergeHeadlineText,
    mergeBody: pr.viewerMergeBodyText,
  });
}

export function snapshotLifecycle(value: Schema.JsonObject) {
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ data: Schema.Struct({ repository: LifecycleRepository }) }),
  )(value);

  const repo = Option.getOrUndefined(decoded)?.data.repository;

  return repo?.pullRequest ? lifecycleState(repo, repo.pullRequest) : undefined;
}

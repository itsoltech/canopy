import { create, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { readScope, type ReadScope } from "./read-scope.ts";
import { ContextFile } from "./context-file.ts";
import { files, diff } from "./files.ts";
import { reviewThreads } from "./review-threads.ts";
import { timeline } from "./timeline-query.ts";
import { checks } from "./checks.ts";

function pageScope(
  scope: ReadScope,
  kind: string,
  fields: MessageInitShape<typeof github.PullRequestPageRequestSchema> = {},
) {
  return readScope(
    scope.prs,
    create(github.PullRequestPageRequestSchema, {
      pullRequestId: scope.pr.id,
      headSha: scope.head,
      baseSha: scope.snapshot.baseSha,
      ...fields,
    }),
    kind,
  );
}

async function contextFiles(scope: ReadScope, request: github.PreparePullRequestContextRequest, file: ContextFile) {
  let cursor = "";
  const selected: github.PullRequestFile[] = [];

  do {
    const page = await files(await pageScope(scope, "files", { cursor }));

    for (const f of page.files) {
      file.add(
        `file:${f.path}`,
        JSON.stringify({
          path: f.path,
          previousPath: f.previousPath,
          state: f.state,
          additions: f.additions,
          deletions: f.deletions,
        }),
      );

      if (selected.length < 20 && (!request.paths.length || request.paths.includes(f.path))) selected.push(f);
    }

    cursor = page.page?.nextCursor ?? "";
  } while (cursor);

  for (const path of request.paths)
    if (!selected.some((f) => f.path === path)) file.omissions.push(`${path}: unavailable`);

  for (const f of selected) {
    const item = await diff(await pageScope(scope, "diff", { path: f.path, resourceId: String(f.sourcePage) }));

    if (item.file?.patchState === "available") file.add(`patch:${f.path}`, item.patch, true);
    else file.omissions.push(`${f.path}: ${item.file?.patchState ?? "unavailable"}`);
  }

  if (scope.snapshot.files > selected.length)
    file.omissions.push(`diffs: ${scope.snapshot.files - selected.length} files not selected`);
}

async function contextFindings(scope: ReadScope, request: github.PreparePullRequestContextRequest, file: ContextFile) {
  const resources = request.findingIds.length ? request.findingIds : [""];
  let remaining = 20;

  for (const resourceId of resources) {
    const reviews = await reviewThreads(await pageScope(scope, "reviews", { resourceId }));

    for (const thread of reviews.threads) {
      if (!resourceId && thread.resolved) continue;
      const comments = thread.comments.slice(0, remaining);
      remaining -= comments.length;

      if (comments.length)
        file.add(
          thread.id,
          toJsonString(
            github.PullRequestReviewThreadSchema,
            create(github.PullRequestReviewThreadSchema, { ...thread, comments, repliesCursor: "" }),
          ),
        );

      if (comments.length < thread.comments.length || thread.repliesCursor)
        file.omissions.push(`${thread.id}: more replies not loaded`);
    }

    if (reviews.page?.nextCursor) file.omissions.push("older review threads: not loaded");

    if (resourceId && !reviews.threads.some((t) => t.id === resourceId))
      file.omissions.push(`${resourceId}: unavailable`);
  }

  const failed = await checks(await pageScope(scope, "checks"));

  for (const check of failed.checks
    .filter((c) => ["failure", "timed_out", "action_required"].includes(c.state))
    .slice(0, remaining))
    file.add(
      check.nodeId || check.name,
      JSON.stringify({ name: check.name, state: check.state, sha: check.headSha, output: check.output }),
    );

  if (failed.page?.nextCursor || remaining === 0) file.omissions.push("additional findings: not loaded");
}

export async function contextContent(
  scope: ReadScope,
  request: github.PreparePullRequestContextRequest,
  file: ContextFile,
) {
  if (request.action === "question") return;
  await contextFiles(scope, request, file);

  if (request.action === "findings") return contextFindings(scope, request, file);
  const recent = await timeline(await pageScope(scope, "timeline", { kind: "review" }));

  for (const entry of recent.items.slice(0, 20))
    if (entry.content.value)
      file.add(entry.content.value.id, toJsonString(github.PullRequestTimelineEntrySchema, entry.content.value));

  if (recent.page?.nextCursor || recent.items.length > 20) file.omissions.push("older reviews: not loaded");
}

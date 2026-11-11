import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { readScope } from "./read-scope.ts";
import { ContextFile, contextPrompt, contextScope } from "./context-file.ts";
import { contextContent } from "./context-content.ts";

/** Generates a frozen ordinary attachment. No logs, arbitrary URLs, GitHub writes or turn dispatch. */
export async function prepareContext(core: GatewayCore, request: github.PreparePullRequestContextRequest) {
  if (
    !["question", "explain", "findings"].includes(request.action) ||
    request.paths.length > 20 ||
    request.findingIds.length > 20
  )
    throw new ConnectError("Choose up to 20 files or findings", Code.InvalidArgument);
  const links = await core.github.prs.list(request.threadId);

  if (!links.links.some((l) => l.summary?.ref?.id === request.pullRequestId))
    throw new ConnectError("Pull request not linked to this thread", Code.NotFound);

  const scope = await readScope(
    core.github.prs,
    create(github.PullRequestPageRequestSchema, { pullRequestId: request.pullRequestId }),
    "context",
  );

  const snapshot = scope.snapshot;
  const file = new ContextFile();

  file.add(
    "identity",
    JSON.stringify({
      url: `https://github.com/${scope.pr.repository_name}/pull/${scope.pr.number}`,
      repository: scope.pr.repository_name,
      number: scope.pr.number,
      nodeId: scope.pr.node_id,
      title: snapshot.summary?.title,
      author: snapshot.author,
      state: snapshot.summary?.state,
      baseSha: snapshot.baseSha,
      headSha: scope.head,
      files: snapshot.files,
      additions: snapshot.additions,
      deletions: snapshot.deletions,
      checks: snapshot.summary?.checksCount,
      capturedAt: new Date(core.github.http.now()).toISOString(),
    }),
  );
  file.add("description", snapshot.body);
  await contextContent(scope, request, file);
  await scope.fresh();

  const attachment = await core.uploadAttachment(
    `github-pr-${scope.pr.number}-${scope.head.slice(0, 12)}.md`,
    Buffer.from(file.text(scope.head, snapshot.baseSha)),
  );

  await core.github.run((s) => s.audit(core.github.owner, "prepare_context", scope.pr.id));

  return create(github.PullRequestContextResponseSchema, {
    attachment,
    prompt: contextPrompt(request.action),
    scope: `${scope.pr.repository_name} #${scope.pr.number} · ${scope.head.slice(0, 7)} · ${contextScope(request.action)} · ${new Date(core.github.http.now()).toISOString()}${file.omissions.length ? ` · ${file.omissions.length} omissions listed in attachment` : ""}`,
  });
}

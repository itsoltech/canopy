import { create, fromJsonString } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { GatewayCore } from "../core/core.ts";
import { createContext, checkoutContext } from "./create-context.ts";
import { validateLifecycle, lifecycleParameters } from "./lifecycle.ts";
import { digest } from "./read-scope.ts";
import { mutationQueue, mutationBudget } from "./mutation-http.ts";
import { mutationReceipt } from "./mutations.ts";
import { uncertainDetail, type MutationRow } from "./store-mutations.ts";
import { githubFailure, GitHubHttpFailure } from "./http.ts";
import { uuid } from "./records.ts";
import { suggestExisting } from "./create-existing.ts";

const Created = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      result: Schema.NullOr(
        Schema.Struct({
          pullRequest: Schema.NullOr(
            Schema.Struct({
              id: Schema.String,
              number: Schema.Number,
              repository: Schema.Struct({ databaseId: Schema.Number, nameWithOwner: Schema.String }),
            }),
          ),
        }),
      ),
    }),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))),
});

export async function reconcileCreate(core: GatewayCore, row: MutationRow) {
  if (row.action !== "create_pr" || row.state !== "accepted" || !row.created_pr || !row.thread_id) return row;
  const ref = fromJsonString(github.PullRequestRefSchema, JSON.stringify(row.created_pr));
  const snapshot = await core.github.prs.load(ref.repositoryName, ref.number, true);

  if (
    snapshot.summary?.ref?.nodeId !== row.upstream_id ||
    snapshot.summary.ref.repositoryId !== row.repository_id ||
    snapshot.accountId !== row.account_id ||
    snapshot.accessRevision !== row.access_revision
  )
    return row;
  const saved = await core.github.run((s) => s.mutationLinkCreated(row, snapshot));

  if (saved) {
    await core.github.prs.changed(ref.repositoryId);
    await core.github.prs.publish([row.thread_id]);
  }

  return saved ?? row;
}

export async function createPullRequest(
  core: GatewayCore,
  r: github.PullRequestMutationRequest,
  client: string,
  prepare = false,
) {
  validateLifecycle(r);

  if (
    r.action !== "create_pr" ||
    !uuid(r.threadId) ||
    !uuid(r.accountId) ||
    !uuid(r.clientRequestId) ||
    r.pullRequestId ||
    !r.title.trim()
  )
    throw new ConnectError("Review the title and branch before creating a pull request.", Code.InvalidArgument);
  const { run, owner, prs } = core.github;

  const fingerprint = digest(
    JSON.stringify([client, r.accountId, String(r.accessRevision), r.headSha, r.title, r.body, lifecycleParameters(r)]),
  );

  const read = async () => (await run((s) => s.mutationGet(owner, r.clientRequestId)))[0];
  let row = await read();

  if (row && (row.fingerprint !== fingerprint || row.client_binding !== client))
    throw new ConnectError("This request belongs to another action. Refresh the form.", Code.AlreadyExists);

  if (row && row.state !== "prepared") return mutationReceipt(await reconcileCreate(core, row));

  try {
    const context = await createContext(
      core,
      create(github.PullRequestCreateContextRequestSchema, {
        threadId: r.threadId,
        repositoryName: r.repositoryName,
        baseRef: r.baseRef,
        headSha: r.headSha,
      }),
    );

    const value = context.value;

    if (
      !value.published ||
      value.headRepositoryName !== r.headRepositoryName ||
      value.headRef !== r.headRef ||
      value.baseSha !== r.baseSha ||
      value.accountId !== r.accountId ||
      value.accessRevision !== r.accessRevision
    )
      throw new ConnectError(
        value.detail || "The branches or account changed. Refresh the form.",
        Code.FailedPrecondition,
      );
    await core.github.catalogue.refresh(r.accountId, true);
    const access = await core.github.access.token(r.accountId);

    if (access.row.auth_kind === "device") {
      const permissions = await run((s) => s.mutationPermission(owner, r.accountId, value.repositoryId));

      if (!permissions.some((p) => p.permissions["pull_requests"] === "write"))
        throw new ConnectError(
          "This account cannot create pull requests. Manage repository access.",
          Code.PermissionDenied,
        );
    }

    const receipt = await mutationQueue({ prs, access }, async (renew) => {
      row = await read();

      if (row && row.state !== "prepared") return mutationReceipt(row);
      // Reads above and any queue wait cannot authorize a changed checkout or account.
      const fresh = await checkoutContext(core, r.threadId);
      const selected = await prs.repositories.selected(r.repositoryName);

      if (
        fresh.context.headOid !== r.headSha ||
        fresh.head.name !== r.headRepositoryName ||
        fresh.head.ref !== r.headRef ||
        selected.row.id !== r.accountId ||
        selected.row.revision !== r.accessRevision ||
        selected.mapping.revision !== context.selected.mapping.revision
      )
        throw new ConnectError("The checkout or account changed. Refresh and confirm again.", Code.FailedPrecondition);

      for (const [name, ref, sha] of [
        [r.repositoryName, r.baseRef, r.baseSha],
        [r.headRepositoryName, r.headRef, r.headSha],
      ]) {
        const remote = await core.github.http.detailed(
          `/repos/${name}/branches/${encodeURIComponent(ref!)}`,
          { method: "GET", headers: { Authorization: `Bearer ${access.token}` } },
          [access.token, ...(access.secrets ?? [])],
        );

        const branch = Schema.decodeUnknownSync(Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) }))(
          remote.value,
        );

        if (branch.commit.sha !== sha)
          throw new ConnectError("The published branches changed. Refresh and confirm again.", Code.FailedPrecondition);
      }

      await renew();
      row = (
        await run((s) =>
          s.mutationPrepareCreate(owner, client, r, fingerprint, selected.mapping.revision, value.repositoryId),
        )
      )[0];

      if (!row || row.fingerprint !== fingerprint)
        throw new ConnectError("Request changed. Refresh the form.", Code.AlreadyExists);

      if (prepare || row.state !== "prepared") return mutationReceipt(row);
      const claimed = await run((s) => s.mutationClaim(row!, r.confirmationId));

      if (!claimed)
        throw new ConnectError(
          "Confirmation expired or access changed. Refresh and confirm again.",
          Code.FailedPrecondition,
        );

      return sendCreate(core, r, claimed, context, access);
    });

    return finishCreate(core, r, receipt);
  } catch (cause) {
    await run((s) => s.mutationDenied(owner, client, r.threadId, r.clientRequestId, r.action));
    throw githubFailure(cause);
  }
}

async function finishCreate(
  core: GatewayCore,
  r: github.PullRequestMutationRequest,
  receipt: github.PullRequestMutationReceipt,
) {
  try {
    const saved = (await core.github.run((s) => s.mutationGet(core.github.owner, r.clientRequestId)))[0];

    if (saved?.state === "failed") return mutationReceipt(await suggestExisting(core, saved, r));

    if (saved?.state === "accepted") return mutationReceipt(await reconcileCreate(core, saved));
  } catch {
    // The durable receipt remains available for a read-only retry.
  }

  return receipt;
}

async function sendCreate(
  core: GatewayCore,
  r: github.PullRequestMutationRequest,
  row: MutationRow,
  context: Awaited<ReturnType<typeof createContext>>,
  access: Awaited<ReturnType<typeof core.github.access.token>>,
) {
  const { run, prs } = core.github;

  let state = "uncertain",
    detail = uncertainDetail;

  let accepted: MutationRow | undefined;

  try {
    const response = await core.github.http.detailed(
      "/graphql",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation CanopyCreatePullRequest($input:CreatePullRequestInput!){result:createPullRequest(input:$input){pullRequest{id number repository{databaseId nameWithOwner}}}}`,
          variables: {
            input: {
              repositoryId: context.baseRepo.node_id,
              headRepositoryId: context.headRepo.node_id,
              headRefName: `${r.headRepositoryName.split("/")[0]}:${r.headRef}`,
              baseRefName: r.baseRef,
              title: r.title,
              body: r.body,
              draft: r.draft,
              maintainerCanModify: r.maintainerCanModify,
              clientMutationId: r.clientRequestId,
            },
          },
        }),
      },
      [access.token, ...(access.secrets ?? [])],
    );

    await mutationBudget({ prs, access }, response.value, response.headers);
    const parsed = Schema.decodeUnknownSync(Created)(response.value);
    const pr = parsed.data?.result?.pullRequest;

    if (pr && !parsed.errors?.length && String(pr.repository.databaseId) === row.repository_id) {
      accepted = await run((s) =>
        s.mutationCreated(
          row,
          create(github.PullRequestRefSchema, {
            host: "github.com",
            repositoryId: String(pr.repository.databaseId),
            repositoryName: pr.repository.nameWithOwner,
            number: pr.number,
            nodeId: pr.id,
          }),
        ),
      );
    } else if (
      !pr &&
      parsed.errors?.length &&
      parsed.errors.every((e) => ["FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE", "VALIDATION"].includes(e.type ?? ""))
    ) {
      state = "failed";
      detail = "GitHub declined this request. Check for an existing pull request, then link it manually.";
    }
  } catch (cause) {
    if (cause instanceof GitHubHttpFailure && [400, 401, 403, 404, 409, 422, 429].includes(cause.status)) {
      state = "failed";
      detail = "GitHub declined this request. Check repository access and existing pull requests.";
    }
  }

  if (accepted) return mutationReceipt(accepted);

  return mutationReceipt(await run((s) => s.mutationFinish(row, state, "", detail)));
}

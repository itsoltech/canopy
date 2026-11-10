import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { createRequest } from "@canopy/domain/github-lifecycle";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { githubBrowser, connectGitHub, githubThread } from "./support/github-pr.ts";
import { lifecycleFixture } from "./support/github-lifecycle.ts";

const code = (p: Promise<object>) =>
  p.then(
    () => 0,
    (e) => ConnectError.from(e).code,
  );

describe.skipIf(!dockerAvailable)("Create PR from the thread checkout", () => {
  const fixture = lifecycleFixture(),
    state = fixture.state,
    browser = githubBrowser();

  let gw: TestGateway,
    thread: string,
    account: string,
    localHead = state.head;

  const sql = (query: string, values: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const s = yield* SqlClient.SqlClient;

        return yield* s.unsafe(query, values);
      }),
    );

  const installWorker = () =>
    gw.worker.handlers.set("readGitPrContext", (_value, reply) =>
      reply(true, {
        gitPrContext: {
          branch: state.branch,
          headOid: localHead,
          pushRemote: "origin",
          pushRef: state.branch,
          remotes: [
            {
              name: "origin",
              fetchRepositories: ["github.com/itsoltech/canopy"],
              pushRepositories: ["github.com/itsoltech/canopy"],
            },
          ],
        },
      }),
    );

  const context = () => gw.api.getPullRequestCreateContext({ threadId: thread });

  const request = async () =>
    createRequest(await context(), crypto.randomUUID(), "feat: reviewed title", "User-edited Markdown", true, false);

  const prepare = async (r: github.PullRequestMutationRequest) => ({
    ...r,
    confirmationId: (await gw.api.preparePullRequestMutation(r, browser)).confirmationId,
  });

  beforeAll(async () => {
    gw = await startTestGateway({
      github: fixture.options,
      worker: { hello: { capabilities: ["git_pr_context_v1"] } },
    });
    await gw.core.githubDetection.stop();
    installWorker();
    account = await connectGitHub(gw, fixture);
    thread = await githubThread(gw);
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("agent context only drafts; a reviewed create links once, without git push or a model turn", async () => {
    expect((await context()).accountId).toBe("");
    await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
    const value = await context();
    expect(value).toMatchObject({
      published: true,
      headSha: localHead,
      headRef: "feature",
      baseRef: "dev",
      accountId: account,
    });
    const draft = await gw.api.preparePullRequestDraftContext({ threadId: thread, headSha: localHead });
    expect(draft.attachment?.id).toBeTruthy();
    expect(draft.prompt).toContain('"title" and "body"');
    expect(state.creates).toBe(0);
    expect(gw.worker.inputs.size).toBe(0);
    const r = await prepare(await request());
    expect(state.creates).toBe(0);
    const result = await gw.api.createPullRequest(r, browser);
    expect(result.state).toBe("succeeded");
    expect(result.createdPullRequest?.number).toBe(100);
    const again = await gw.api.createPullRequest(r, browser);
    expect(again.createdPullRequest?.id).toBe(result.createdPullRequest?.id);
    const links = await gw.api.listThreadPullRequests({ threadId: thread });
    expect(links.links.length).toBe(1);
    expect(links.links[0]?.source).toBe("auto");
    expect(state.creates).toBe(1);
    expect(gw.worker.inputs.size).toBe(0);
  }, 30_000);

  test("create/link crash resumes by immutable upstream ID after a gateway restart, respecting a tombstone", async () => {
    const r = await prepare(await request());
    // Fail only the local link, after the upstream ID was saved durably.
    await sql(
      "CREATE FUNCTION reject_create_link() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture interrupted local link''; END'",
    );
    await sql(
      "CREATE TRIGGER reject_create_link BEFORE INSERT ON thread_pull_requests FOR EACH ROW EXECUTE FUNCTION reject_create_link()",
    );
    const receipt = await gw.api.createPullRequest(r, browser);
    expect(receipt.state).toBe("accepted");
    expect(receipt.upstreamId).toBe("PR_fixture_101");
    await sql("DROP TRIGGER reject_create_link ON thread_pull_requests");
    await sql("DROP FUNCTION reject_create_link()");
    // A manual unlink on another client must survive the resumed automatic link.
    const current = await gw.api.listThreadPullRequests({ threadId: thread });

    const list = await gw.api.linkThreadPullRequest({
      threadId: thread,
      url: "https://github.com/itsoltech/canopy/pull/101",
      expectedRevision: current.revision,
    });

    const ref = list.links.find((l) => l.summary?.ref?.number === 101)!.summary!.ref!;
    await gw.api.unlinkThreadPullRequest({ threadId: thread, pullRequestId: ref.id, expectedRevision: list.revision });

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({
      storage,
      github: fixture.options,
      worker: { hello: { capabilities: ["git_pr_context_v1"] } },
    });
    await gw.core.githubDetection.stop();
    installWorker();

    const recovered = await gw.api.getPullRequestMutation(
      { threadId: thread, clientRequestId: r.clientRequestId },
      browser,
    );

    expect(recovered.state).toBe("succeeded");
    expect(recovered.createdPullRequest?.id).toBe(ref.id);
    expect(
      (await gw.api.listThreadPullRequests({ threadId: thread })).links.some((l) => l.summary?.ref?.id === ref.id),
    ).toBe(false);
    expect((await gw.api.createPullRequest(r, browser)).state).toBe("succeeded");
    expect(state.creates).toBe(2);
  }, 30_000);

  test("unpublished branch, checkout/published push and account changes require a fresh confirmation", async () => {
    state.published = false;
    expect((await context()).published).toBe(false);
    const unpushed = await request();
    expect(await code(gw.api.preparePullRequestMutation(unpushed, browser))).toBe(Code.FailedPrecondition);
    state.published = true;

    const r = await prepare(await request()),
      before = state.creates;

    localHead = "d".repeat(40);
    expect(await code(gw.api.createPullRequest(r, browser))).toBe(Code.FailedPrecondition);
    localHead = state.head;
    state.head = "e".repeat(40);
    expect(await code(gw.api.createPullRequest(r, browser))).toBe(Code.FailedPrecondition);
    state.head = localHead;
    const other = await connectGitHub(gw, fixture, 102);
    let mapping = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: other,
      expectedRevision: mapping.revision,
    });
    expect(await code(gw.api.createPullRequest(r, browser))).toBe(Code.FailedPrecondition);
    mapping = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: account,
      expectedRevision: mapping.revision,
    });
    expect(state.creates).toBe(before);
  }, 30_000);

  test("an existing PR is verified and suggested without restoring a tombstone or replaying create", async () => {
    let links = await gw.api.listThreadPullRequests({ threadId: thread });
    links = await gw.api.linkThreadPullRequest({
      threadId: thread,
      url: "https://github.com/itsoltech/canopy/pull/42",
      expectedRevision: links.revision,
    });
    const ref = links.links.find((l) => l.summary?.ref?.number === 42)!.summary!.ref!;
    await gw.api.unlinkThreadPullRequest({ threadId: thread, pullRequestId: ref.id, expectedRevision: links.revision });
    state.existing = true;
    state.rejected = true;
    state.existingHead = "f".repeat(40);
    expect(
      (await gw.api.createPullRequest(await prepare(await request()), browser)).existingPullRequest,
    ).toBeUndefined();
    state.existingHead = "";
    const r = await prepare(await request());
    const result = await gw.api.createPullRequest(r, browser);
    expect(result.state).toBe("failed");
    expect(result.existingPullRequest?.id).toBe(ref.id);
    expect((await gw.api.createPullRequest(r, browser)).existingPullRequest?.id).toBe(ref.id);
    links = await gw.api.listThreadPullRequests({ threadId: thread });
    expect(links.links.some((l) => l.summary?.ref?.id === ref.id)).toBe(false);
    expect(
      (
        await gw.api.linkThreadPullRequest({
          threadId: thread,
          url: "https://github.com/itsoltech/canopy/pull/42",
          expectedRevision: links.revision,
        })
      ).links.some((l) => l.summary?.ref?.id === ref.id),
    ).toBe(true);
    state.existing = false;
    state.rejected = false;
  }, 30_000);

  test("confirmation binds thread, text, draft, client and expiry; no replay after loss", async () => {
    const r = await prepare(await request()),
      before = state.creates;

    for (const changed of [
      { title: "Injected title" },
      { body: "Injected body" },
      { draft: false },
      { threadId: crypto.randomUUID() },
    ])
      expect(await code(gw.api.createPullRequest({ ...r, ...changed }, browser))).toBe(Code.AlreadyExists);
    expect(await code(gw.api.createPullRequest(r, githubBrowser()))).toBe(Code.AlreadyExists);
    expect(await code(gw.api.createPullRequest({ ...r, confirmationId: "" }, browser))).toBe(Code.FailedPrecondition);
    await sql("UPDATE github_mutation_receipts SET expires_at=now()-interval '1 second' WHERE request_id=$1::uuid", [
      r.clientRequestId,
    ]);
    expect(await code(gw.api.createPullRequest(r, browser))).toBe(Code.FailedPrecondition);
    expect(state.creates).toBe(before);
    const lost = await prepare(await request());
    state.lost = true;
    expect((await gw.api.createPullRequest(lost, browser)).state).toBe("uncertain");
    expect((await gw.api.createPullRequest(lost, browser)).state).toBe("uncertain");
    expect(state.creates).toBe(before + 1);
    expect(await code(gw.api.getPullRequestCreateContext({ threadId: crypto.randomUUID() }))).toBe(Code.NotFound);
    const audit = await sql("SELECT details::text AS details FROM audit_log WHERE action LIKE 'github.%'");
    expect(JSON.stringify(audit)).not.toContain("User-edited Markdown");
    expect(JSON.stringify(audit)).not.toContain("feat: reviewed title");
  }, 30_000);
});

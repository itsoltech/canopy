import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui, type github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { mutationRequest, sendMutation } from "@canopy/domain/github-mutations";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { githubBrowser, connectGitHub } from "./support/github-pr.ts";
import { lifecycleFixture } from "./support/github-lifecycle.ts";

const code = (p: Promise<object>) =>
  p.then(
    () => 0,
    (e) => ConnectError.from(e).code,
  );

describe.skipIf(!dockerAvailable)("GitHub lifecycle preflight and durable effects", () => {
  const fixture = lifecycleFixture(),
    browser = githubBrowser(),
    state = fixture.state;

  let gw: TestGateway, pr: string, snapshot: github.PullRequestSnapshot;

  const sql = (query: string, values: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const s = yield* SqlClient.SqlClient;

        return yield* s.unsafe(query, values);
      }),
    );

  const request = (action: string, fields: Partial<github.PullRequestMutationRequest> = {}) =>
    Object.assign(mutationRequest(snapshot, crypto.randomUUID(), action), fields);

  const refresh = async () => {
    snapshot = await gw.api.refreshPullRequest({ pullRequestId: pr });

    return snapshot;
  };

  const prepared = async (r: github.PullRequestMutationRequest) => ({
    ...r,
    confirmationId: (await gw.api.preparePullRequestMutation(r, browser)).confirmationId,
  });

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
    await refresh();
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("ready/draft, close/reopen and every repository merge method", async () => {
    expect(
      (await gw.api.setPullRequestDraft(await prepared(request("set_draft", { draft: true })), browser)).state,
    ).toBe("succeeded");
    await refresh();
    expect(snapshot.summary?.state).toBe("draft");
    expect(
      (await gw.api.setPullRequestDraft(await prepared(request("set_draft", { draft: false })), browser)).state,
    ).toBe("succeeded");
    await refresh();
    expect(
      (await gw.api.setPullRequestOpen(await prepared(request("set_open", { enabled: false })), browser)).state,
    ).toBe("succeeded");
    await refresh();
    expect(snapshot.summary?.state).toBe("closed");
    expect(
      (await gw.api.setPullRequestOpen(await prepared(request("set_open", { enabled: true })), browser)).state,
    ).toBe("succeeded");

    for (const method of ["MERGE", "SQUASH", "REBASE"]) {
      state.state = "OPEN";
      await refresh();
      const r = await prepared(request("merge", { method, title: "feat: edited title", body: "Edited commit body" }));
      expect((await gw.api.mergePullRequest(r, browser)).state).toBe("succeeded");
      expect(state.state).toBe("MERGED");

      if (method === "SQUASH") {
        expect(state.mergeTitle).toBe(r.title);
        expect(state.mergeBody).toBe(r.body);
      }
    }

    state.state = "OPEN";
    await refresh();
  }, 30_000);

  test("confirmation binds client, head/base, action parameters and expiry", async () => {
    const r = await prepared(request("merge", { method: "SQUASH", title: "Reviewed commit" }));
    const before = state.writes;
    expect(await code(gw.api.mergePullRequest({ ...r, method: "REBASE" }, browser))).toBe(Code.AlreadyExists);
    expect(await code(gw.api.mergePullRequest(r, githubBrowser()))).toBe(Code.AlreadyExists);
    expect(await code(gw.api.mergePullRequest({ ...r, confirmationId: "" }, browser))).toBe(Code.FailedPrecondition);
    state.head = "d".repeat(40);
    expect(await code(gw.api.mergePullRequest(r, browser))).toBe(Code.FailedPrecondition);

    const refused = await sendMutation(
      {
        ...gw.api,
        mergePullRequest: (value) => gw.api.mergePullRequest(value, browser),
        getPullRequestMutation: (value) => gw.api.getPullRequestMutation(value, browser),
      },
      r,
      (cause) => ConnectError.from(cause).code === Code.FailedPrecondition,
      (cause) => ConnectError.from(cause).rawMessage,
    );

    expect(refused.state).toBe("failed");
    expect(refused.detail).toContain("changed");
    state.head = snapshot.summary!.headSha;
    state.base = "e".repeat(40);
    expect(await code(gw.api.mergePullRequest(r, browser))).toBe(Code.FailedPrecondition);
    state.base = snapshot.baseSha;
    await sql("UPDATE github_mutation_receipts SET expires_at=now()-interval '1 second' WHERE request_id=$1::uuid", [
      r.clientRequestId,
    ]);
    expect(await code(gw.api.mergePullRequest(r, browser))).toBe(Code.FailedPrecondition);
    expect(state.writes).toBe(before);
  }, 30_000);

  test("protection, checks, reviews, conflicts, queue and methods cannot be bypassed", async () => {
    const before = state.writes;

    for (const [key, value] of [
      ["mergeStatus", "BLOCKED"],
      ["checks", "FAILURE"],
      ["review", "REVIEW_REQUIRED"],
      ["mergeable", "CONFLICTING"],
    ] as const) {
      const original = state[key];
      state[key] = value;
      await refresh();
      expect(snapshot.lifecycle?.blockingReasons.length).toBeGreaterThan(0);
      expect(await code(gw.api.preparePullRequestMutation(request("merge", { method: "MERGE" }), browser))).toBe(
        Code.FailedPrecondition,
      );
      state[key] = original;
    }

    state.methods = ["SQUASH"];
    await refresh();
    expect(snapshot.lifecycle?.mergeMethods).toEqual(["SQUASH"]);
    expect(await code(gw.api.preparePullRequestMutation(request("merge", { method: "MERGE" }), browser))).toBe(
      Code.FailedPrecondition,
    );
    state.methods = ["MERGE", "SQUASH", "REBASE"];
    state.queue = true;
    await refresh();
    expect(snapshot.lifecycle?.actions).toContain("enqueue");
    expect(await code(gw.api.preparePullRequestMutation(request("merge", { method: "SQUASH" }), browser))).toBe(
      Code.FailedPrecondition,
    );
    expect(state.writes).toBe(before);
    const enqueue = await prepared(request("queue", { enabled: true }));
    expect((await gw.api.setPullRequestQueue(enqueue, browser)).state).toBe("accepted");
    expect(state.state).toBe("OPEN");
    await refresh();
    expect(snapshot.lifecycle?.inQueue).toBe(true);
    expect(
      (await gw.api.setPullRequestQueue(await prepared(request("queue", { enabled: false })), browser)).state,
    ).toBe("succeeded");
    state.queue = false;
    await refresh();
  }, 30_000);

  test("auto-merge and both update methods are accepted, not presented as merged", async () => {
    const r = await prepared(request("auto_merge", { enabled: true, method: "SQUASH", title: "Future squash" }));
    expect((await gw.api.setPullRequestAutoMerge(r, browser)).state).toBe("accepted");
    await refresh();
    expect(snapshot.lifecycle?.autoMergeMethod).toBe("SQUASH");
    expect(
      (await gw.api.setPullRequestAutoMerge(await prepared(request("auto_merge", { enabled: false })), browser)).state,
    ).toBe("succeeded");

    for (const method of ["MERGE", "REBASE"]) {
      await refresh();
      expect(
        (await gw.api.updatePullRequestBranch(await prepared(request("update_branch", { method })), browser)).state,
      ).toBe("accepted");
      expect(state.update).toBe(method);
      expect(state.state).toBe("OPEN");
    }
  }, 30_000);

  test("fork updates need both head write access and author consent", async () => {
    state.maintainer = false;
    await refresh();
    expect(snapshot.lifecycle?.actions).toContain("update_branch");
    state.fork = true;

    for (const [write, consent] of [
      [false, true],
      [true, false],
    ]) {
      state.headWrite = write!;
      state.maintainer = consent!;
      await refresh();
      expect(snapshot.lifecycle?.actions).not.toContain("update_branch");
      expect(snapshot.lifecycle?.updateBlockingReason).toContain("fork");
      expect(
        await code(gw.api.preparePullRequestMutation(request("update_branch", { method: "MERGE" }), browser)),
      ).toBe(Code.FailedPrecondition);
    }

    state.headWrite = true;
    state.maintainer = true;
    await refresh();
    expect(
      (await gw.api.updatePullRequestBranch(await prepared(request("update_branch", { method: "REBASE" })), browser))
        .state,
    ).toBe("accepted");
    state.fork = false;
    await refresh();
  }, 30_000);

  test("account changes after confirmation and worker/bot actors refuse without effects", async () => {
    const r = await prepared(request("merge", { method: "MERGE" })),
      before = state.writes;

    const account = await connectGitHub(gw, fixture, 102);
    const mapping = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: account,
      expectedRevision: mapping.revision,
    });
    expect(await code(gw.api.mergePullRequest(r, browser))).toBe(Code.FailedPrecondition);
    const current = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: snapshot.accountId,
      expectedRevision: current.revision,
    });
    await refresh();

    for (const token of [gw.workerCredential, "bot-fixture-credential"]) {
      const api = createClient(
        ui.GatewayService,
        createGrpcTransport({
          baseUrl: gw.grpcUrl,
          interceptors: [
            (next) => (req) => {
              req.header.set("authorization", `Bearer ${token}`);

              return next(req);
            },
          ],
        }),
      );

      for (const invoke of [
        () => api.mergePullRequest(r, browser),
        () => api.setPullRequestDraft(r, browser),
        () => api.createPullRequest(r, browser),
        () => api.setPullRequestQueue(r, browser),
        () => api.setPullRequestAutoMerge(r, browser),
        () => api.updatePullRequestBranch(r, browser),
        () => api.setPullRequestOpen(r, browser),
      ])
        expect(await code(invoke())).toBe(Code.Unauthenticated);
    }

    expect(state.writes).toBe(before);
  }, 30_000);

  test("accepted and lost results survive expiry without a second mutation", async () => {
    const accepted = await prepared(request("update_branch", { method: "MERGE" }));
    expect((await gw.api.updatePullRequestBranch(accepted, browser)).state).toBe("accepted");
    const r = await prepared(request("merge", { method: "SQUASH", title: "No replay" }));
    state.lost = true;
    const before = state.writes;
    expect((await gw.api.mergePullRequest(r, browser)).state).toBe("uncertain");
    expect((await gw.api.mergePullRequest(r, browser)).state).toBe("uncertain");
    expect((await gw.api.updatePullRequestBranch(accepted, browser)).state).toBe("accepted");
    expect(state.writes - before).toBe(1);
    const abandoned = request("set_open", { enabled: false });
    state.state = "OPEN";
    await refresh();
    await gw.api.preparePullRequestMutation(abandoned, browser);
    await sql(
      "UPDATE github_mutation_receipts SET state='in_flight',lease_until=now()-interval '1 second' WHERE request_id=$1::uuid",
      [abandoned.clientRequestId],
    );
    expect((await gw.api.setPullRequestOpen(abandoned, browser)).state).toBe("uncertain");
    expect(state.writes - before).toBe(1);

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage, github: fixture.options });
    expect(
      (await gw.api.getPullRequestMutation({ pullRequestId: pr, clientRequestId: accepted.clientRequestId }, browser))
        .state,
    ).toBe("accepted");
    expect((await gw.api.mergePullRequest(r, browser)).state).toBe("uncertain");
    expect(state.writes - before).toBe(1);
  }, 30_000);
});

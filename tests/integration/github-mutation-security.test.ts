import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui, type github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { startGrpcServer } from "@canopy/transport";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { githubBrowser } from "./support/github-pr.ts";
import { linkedRead } from "./support/github-read.ts";
import { mutationFixture } from "./support/github-mutations.ts";

describe.skipIf(!dockerAvailable)("GitHub mutation security boundaries", () => {
  const fixture = mutationFixture(),
    browser = githubBrowser();

  let gw: TestGateway;
  let snapshot: github.PullRequestSnapshot;
  let other: GatewayCore;
  let server: Awaited<ReturnType<typeof startGrpcServer>>;

  const api = (url: string, token = SERVICE_TOKEN) =>
    createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: url,
        interceptors: [
          (next) => (req) => {
            req.header.set("authorization", `Bearer ${token}`);

            return next(req);
          },
        ],
      }),
    );

  const code = (p: Promise<object>) =>
    p.then(
      () => 0,
      (e) => ConnectError.from(e).code,
    );

  const request = (action: string, fields: Partial<github.PullRequestMutationRequest> = {}) =>
    Object.assign(mutationRequest(snapshot, crypto.randomUUID(), action), fields);

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    const { pr } = await linkedRead(gw, fixture);
    snapshot = await gw.api.getPullRequest({ pullRequestId: pr });

    const owner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("mutation-other@example.test", "Other owner")),
    );

    other = new GatewayCore({
      runtime: gw.runtime,
      userId: owner,
      instanceId: "mutation-other",
      sshSecretsKey: gw.secretsKey,
      github: fixture.options,
    });
    server = await startGrpcServer({
      routes: uiRoutes(other),
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
      host: "127.0.0.1",
      port: 0,
    });
  }, 60_000);
  afterAll(async () => {
    await other?.stopSweep();
    await server?.close();
    await gw?.close();
    fixture.close();
  });

  test("foreign owner, PR, review thread and comment IDs are refused before writes", async () => {
    const before = fixture.writes;
    const create = request("create_comment", { body: "Foreign owner" });
    expect(await code(api(server.url).createPullRequestComment(create, browser))).toBe(Code.NotFound);
    expect(
      await code(gw.api.createPullRequestComment({ ...create, pullRequestId: crypto.randomUUID() }, browser)),
    ).toBe(Code.NotFound);
    expect(
      await code(
        gw.api.replyPullRequestReviewThread(
          request("reply", { resourceId: "FOREIGN_THREAD", body: "Wrong PR" }),
          browser,
        ),
      ),
    ).toBe(Code.NotFound);
    expect(
      await code(
        gw.api.updatePullRequestComment(
          request("update_comment", { resourceId: "FOREIGN", commentKind: "issue", body: "Wrong PR" }),
          browser,
        ),
      ),
    ).toBe(Code.NotFound);
    expect(fixture.writes).toBe(before);
  }, 30_000);

  test("admin-capable viewers still cannot edit or delete another author's comment", async () => {
    const before = fixture.writes;
    expect(
      await code(
        gw.api.updatePullRequestComment(
          request("update_comment", { resourceId: "OTHER", commentKind: "issue", body: "Not mine" }),
          browser,
        ),
      ),
    ).toBe(Code.NotFound);
    expect(
      await code(
        gw.api.preparePullRequestMutation(
          request("delete_comment", { resourceId: "OTHER", commentKind: "issue" }),
          browser,
        ),
      ),
    ).toBe(Code.NotFound);
    expect(fixture.writes).toBe(before);
  }, 30_000);

  test("fresh permissions and SHA are checked again after preparation", async () => {
    const r = request("delete_comment", { resourceId: "OWN", commentKind: "issue" });
    const confirmation = await gw.api.preparePullRequestMutation(r, browser);
    const before = fixture.writes;
    fixture.allowed(false);
    expect(
      await code(gw.api.deletePullRequestComment({ ...r, confirmationId: confirmation.confirmationId }, browser)),
    ).toBe(Code.NotFound);
    fixture.allowed(true);
    fixture.head("c".repeat(40));
    expect(
      await code(gw.api.deletePullRequestComment({ ...r, confirmationId: confirmation.confirmationId }, browser)),
    ).toBe(Code.FailedPrecondition);
    fixture.head(snapshot.summary!.headSha);
    expect(fixture.writes).toBe(before);
    expect(fixture.comments.has("OWN")).toBe(true);
    fixture.beforeMutation(() => fixture.allowed(false));

    const declined = await gw.api.createPullRequestComment(
      request("create_comment", { body: "Revoked at GitHub" }),
      browser,
    );

    expect(declined.state).toBe("failed");
    fixture.beforeMutation(() => {});
    fixture.allowed(true);
  }, 30_000);

  test("worker and bot credentials cannot call product mutations or nominate a UI actor", async () => {
    const r = request("create_comment", { body: "Actor spoof" }),
      before = fixture.writes;

    const options = { headers: { ...browser.headers, "canopy-actor": "user" } };

    for (const token of [gw.workerCredential, "bot-fixture-credential"]) {
      const caller = api(gw.grpcUrl, token);

      for (const call of [
        () => caller.createPullRequestComment(r, options),
        () => caller.replyPullRequestReviewThread({ ...r, action: "reply", resourceId: "THREAD_OWN" }, options),
        () => caller.setPullRequestFileViewed({ ...r, action: "viewed", path: "src/safe.ts", viewed: true }, options),
        () =>
          caller.preparePullRequestMutation(
            { ...r, action: "delete_comment", resourceId: "OWN", commentKind: "issue" },
            options,
          ),
      ])
        expect(await code(call())).toBe(Code.Unauthenticated);
    }

    expect(fixture.writes).toBe(before);
  });

  test("request and receipt client bindings cannot be supplied by public payloads", async () => {
    const r = request("create_comment", { body: "Bound to one browser", clientBinding: "a".repeat(64) });
    const saved = await gw.api.createPullRequestComment(r, browser);
    expect(saved.state).toBe("succeeded");
    expect(
      await code(
        gw.api.getPullRequestMutation(
          { pullRequestId: r.pullRequestId, clientRequestId: r.clientRequestId, clientBinding: r.clientBinding },
          githubBrowser(),
        ),
      ),
    ).toBe(Code.NotFound);
    expect(
      await code(
        api(server.url).getPullRequestMutation(
          { pullRequestId: r.pullRequestId, clientRequestId: r.clientRequestId },
          browser,
        ),
      ),
    ).toBe(Code.NotFound);
    expect(await code(gw.api.createPullRequestComment(request("create_comment", { body: "Missing UI binding" })))).toBe(
      Code.Unauthenticated,
    );
  }, 30_000);
});

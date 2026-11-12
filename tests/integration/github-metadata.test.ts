import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui, github } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { startGrpcServer } from "@canopy/transport";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { GitHubMetadataEditor } from "@canopy/domain/github-metadata";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { githubBrowser } from "./support/github-pr.ts";
import { metadataFixture } from "./support/github-metadata.ts";

const code = (promise: Promise<object>) =>
  promise.then(
    () => 0,
    (e) => ConnectError.from(e).code,
  );

describe.skipIf(!dockerAvailable)("GitHub metadata ownership, conflicts and durable effects", () => {
  const fixture = metadataFixture(),
    browser = githubBrowser();

  let gw: TestGateway, pr: string, snapshot: github.PullRequestSnapshot;
  const read = async (kind = "details") => gw.api.getPullRequestMetadata({ pullRequestId: pr, kind, refresh: true });

  const request = async (
    action: string,
    fields: MessageInitShape<typeof github.PullRequestMutationRequestSchema> = {},
  ) =>
    mutationRequest(snapshot, crypto.randomUUID(), action, {
      metadataRevision: (await read()).metadata!.revision,
      ...fields,
    });

  const sql = (query: string, values: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const s = yield* SqlClient.SqlClient;

        return yield* s.unsafe(query, values);
      }),
    );

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
    snapshot = await gw.api.getPullRequest({ pullRequestId: pr });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("pickers include collaborators, org members and teams, exclude the author, and degrade without Members", async () => {
    const page = await read("reviewers");
    expect(page.options.map((o) => o.id)).toEqual(["USER_REVIEWER", "USER_MEMBER", "TEAM_REPO"]);
    expect(page.membersAvailable).toBe(true);
    fixture.state.members = false;
    const fallback = await read("reviewers");
    expect(fallback.options.map((o) => o.id)).toEqual(["USER_REVIEWER"]);
    expect(fallback.membersAvailable).toBe(false);
    expect(fallback.page?.detail).toContain("collaborator");
    fixture.state.members = true;
  }, 30_000);

  test("explicit details, user/team request, re-request, removal, assignees and existing labels", async () => {
    expect(
      (
        await gw.api.updatePullRequestDetails(
          await request("update_details", { title: "Edited title", body: "**Edited** description" }),
          browser,
        )
      ).state,
    ).toBe("succeeded");
    expect((await read()).metadata?.body).toBe("**Edited** description");

    for (const reviewerAction of ["request", "re_request", "remove"]) {
      expect(
        (
          await gw.api.requestPullRequestReviewers(
            await request("request_reviewers", { metadataIds: ["USER_MEMBER", "TEAM_REPO"], reviewerAction }),
            browser,
          )
        ).state,
      ).toBe("succeeded");
    }

    expect(
      (await gw.api.setPullRequestAssignees(await request("set_assignees", { metadataIds: ["USER_AUTHOR"] }), browser))
        .state,
    ).toBe("succeeded");
    expect(
      (await gw.api.setPullRequestLabels(await request("set_labels", { metadataIds: ["LABEL_1", "LABEL_6"] }), browser))
        .state,
    ).toBe("succeeded");
    expect((await read()).metadata?.labels.map((l) => l.color)).toEqual(["a2eeef", "000000"]);
    expect((await gw.api.setPullRequestLabels(await request("set_labels"), browser)).state).toBe("succeeded");
  }, 30_000);

  test("foreign owner/repo/user/team/label IDs, author and Issues permission cannot be bypassed", async () => {
    const before = fixture.state.writes;
    expect(await code(gw.api.getPullRequestMetadata({ pullRequestId: crypto.randomUUID() }))).toBe(Code.NotFound);

    for (const id of ["USER_AUTHOR", "USER_MISSING", "TEAM_OTHER_ORG", "TEAM_FOREIGN_REPO"]) {
      expect(
        await code(
          gw.api.requestPullRequestReviewers(
            await request("request_reviewers", { metadataIds: [id], reviewerAction: "request" }),
            browser,
          ),
        ),
      ).toBe(Code.NotFound);
    }

    expect(
      await code(
        gw.api.requestPullRequestReviewers(
          await request("request_reviewers", { metadataIds: ["USER_FOREIGN"], reviewerAction: "request" }),
          browser,
        ),
      ),
    ).toBe(Code.PermissionDenied);
    expect(
      await code(gw.api.setPullRequestLabels(await request("set_labels", { metadataIds: ["LABEL_FOREIGN"] }), browser)),
    ).toBe(Code.NotFound);
    expect(
      await code(
        gw.api.setPullRequestAssignees(await request("set_assignees", { metadataIds: ["TEAM_REPO"] }), browser),
      ),
    ).toBe(Code.NotFound);
    const foreign = await request("set_labels", { pullRequestId: crypto.randomUUID() });
    expect(await code(gw.api.setPullRequestLabels(foreign, browser))).toBe(Code.NotFound);
    const otherAccount = await request("set_labels", { accountId: crypto.randomUUID() });
    expect(await code(gw.api.setPullRequestLabels(otherAccount, browser))).toBe(Code.FailedPrecondition);
    const wrongRepo = await request("set_labels");
    fixture.state.repositoryId = 888;

    try {
      expect(await code(gw.api.setPullRequestLabels(wrongRepo, browser))).toBe(Code.NotFound);
    } finally {
      fixture.state.repositoryId = 777;
    }

    fixture.state.issues = false;

    try {
      expect(await code(gw.api.setPullRequestLabels(await request("set_labels"), browser))).toBe(
        Code.FailedPrecondition,
      );
      snapshot = await gw.api.getPullRequest({ pullRequestId: pr, refresh: true });
      expect(await code(gw.api.setPullRequestLabels(await request("set_labels"), browser))).toBe(Code.PermissionDenied);
    } finally {
      fixture.state.issues = true;
      await gw.api.listGitHubInstallations({ accountId: snapshot.accountId, refresh: true });
      snapshot = await gw.api.getPullRequest({ pullRequestId: pr, refresh: true });
    }

    expect(fixture.state.writes).toBe(before);
  }, 30_000);

  test("conflicting edits refuse without overwriting; a race after HTTP remains uncertain", async () => {
    const r = await request("update_details", { title: "My edit", body: "My description" });
    const before = fixture.state.writes;
    fixture.state.body = "Someone else's edit";
    expect(await code(gw.api.updatePullRequestDetails(r, browser))).toBe(Code.Aborted);
    expect(fixture.state.writes).toBe(before);
    expect((await read()).metadata?.body).toBe("Someone else's edit");
    fixture.state.race = true;
    const race = await request("update_details", { title: "Racing edit", body: "Description" });
    expect((await gw.api.updatePullRequestDetails(race, browser)).state).toBe("uncertain");
    fixture.state.race = false;
  }, 30_000);

  test("receipts bind selection and client; lost responses and abandoned intents never replay", async () => {
    const r = await request("update_details", { title: "No replay", body: "Private text never audited" });
    fixture.state.lost = true;
    const before = fixture.state.writes;
    expect((await gw.api.updatePullRequestDetails(r, browser)).state).toBe("uncertain");
    expect((await gw.api.updatePullRequestDetails(r, browser)).state).toBe("uncertain");
    expect(await code(gw.api.updatePullRequestDetails({ ...r, title: "Different" }, browser))).toBe(Code.AlreadyExists);
    expect(await code(gw.api.updatePullRequestDetails(r, githubBrowser()))).toBe(Code.AlreadyExists);
    const abandoned = await request("set_labels", { metadataIds: ["LABEL_0"] });
    await gw.api.preparePullRequestMutation(abandoned, browser);
    await sql(
      "UPDATE github_mutation_receipts SET state='in_flight',lease_until=now()-interval '1 second' WHERE request_id=$1::uuid",
      [abandoned.clientRequestId],
    );
    expect((await gw.api.setPullRequestLabels(abandoned, browser)).state).toBe("uncertain");
    expect(fixture.state.writes - before).toBe(1);
    const audit = await sql("SELECT details FROM audit_log WHERE details->>'requestId'=$1", [r.clientRequestId]);
    expect(JSON.stringify(audit)).not.toContain(r.body);
    expect(JSON.stringify(audit)).not.toContain(r.title);
  }, 30_000);

  test("worker and bot credentials cannot invoke any metadata RPC", async () => {
    const r = await request("set_labels");
    const before = fixture.state.writes;

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
        () => api.getPullRequestMetadata({ pullRequestId: pr }),
        () => api.updatePullRequestDetails(r, browser),
        () => api.requestPullRequestReviewers(r, browser),
        () => api.setPullRequestAssignees(r, browser),
        () => api.setPullRequestLabels(r, browser),
      ])
        expect(await code(invoke())).toBe(Code.Unauthenticated);
    }

    expect(fixture.state.writes).toBe(before);
  });

  test("access lost after an acknowledged write leaves an uncertain receipt without replay", async () => {
    const r = await request("set_labels", { metadataIds: ["LABEL_2"] });
    fixture.state.denyAfterWrite = true;
    const before = fixture.state.writes;

    try {
      expect((await gw.api.setPullRequestLabels(r, browser)).state).toBe("uncertain");
      expect((await gw.api.setPullRequestLabels(r, browser)).state).toBe("uncertain");
      expect(fixture.state.writes - before).toBe(1);
    } finally {
      fixture.state.denyAfterWrite = false;
      fixture.state.verificationDenied = false;
    }
  }, 30_000);

  test("the shared editor rolls back an uncertain write and requires an explicit read before another edit", async () => {
    const api = {
      ...gw.api,
      updatePullRequestDetails: (r: github.PullRequestMutationRequest) => gw.api.updatePullRequestDetails(r, browser),
      getPullRequestMutation: (r: github.PullRequestMutationRequestRef) => gw.api.getPullRequestMutation(r, browser),
    };

    const editor = new GitHubMetadataEditor(
      "title",
      api,
      snapshot,
      () => crypto.randomUUID(),
      () => false,
      (e) => ConnectError.from(e).rawMessage,
    );

    await editor.load();
    editor.patch({ title: "Shared draft after a lost response" });
    fixture.state.lost = true;
    const before = fixture.state.writes;
    const pending = editor.apply();
    expect(editor.state.display?.title).toBe("Shared draft after a lost response");
    expect(await pending).toBe(false);
    expect(editor.state.display).toBeUndefined();
    expect(editor.state.receipt?.state).toBe("uncertain");
    expect(await editor.apply()).toBe(false);
    expect(fixture.state.writes - before).toBe(1);
    await editor.load(true);
    expect(editor.state.title).toBe("Shared draft after a lost response");
    expect(editor.state.receipt).toBeUndefined();
    expect(fixture.state.writes - before).toBe(1);
  }, 30_000);

  test("another owner cannot read metadata, mutate it or inspect its receipts through gRPC", async () => {
    const owner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("metadata-other@example.test", "Other owner")),
    );

    const core = new GatewayCore({
      runtime: gw.runtime,
      userId: owner,
      instanceId: "metadata-other",
      sshSecretsKey: gw.secretsKey,
      github: fixture.options,
    });

    const grpc = await startGrpcServer({
      routes: uiRoutes(core),
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
      host: "127.0.0.1",
      port: 0,
    });

    const api = createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: grpc.url,
        interceptors: [
          (next) => (req) => {
            req.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

            return next(req);
          },
        ],
      }),
    );

    const r = await request("set_labels");
    await gw.api.preparePullRequestMutation(r, browser);
    const before = fixture.state.writes;

    try {
      for (const invoke of [
        () => api.getPullRequestMetadata({ pullRequestId: pr }),
        () => api.updatePullRequestDetails({ ...r, action: "update_details", title: "Foreign", body: "" }, browser),
        () =>
          api.requestPullRequestReviewers(
            { ...r, action: "request_reviewers", reviewerAction: "request", metadataIds: ["USER_REVIEWER"] },
            browser,
          ),
        () => api.setPullRequestAssignees({ ...r, action: "set_assignees" }, browser),
        () => api.setPullRequestLabels(r, browser),
        () => api.getPullRequestMutation({ pullRequestId: pr, clientRequestId: r.clientRequestId }, browser),
      ])
        expect(await code(invoke())).toBe(Code.NotFound);
      expect(fixture.state.writes).toBe(before);
    } finally {
      await core.stopSweep();
      await grpc.close();
    }
  }, 30_000);

  test("checked reviewer selection applies only its diff and re-request is an explicit separate write", async () => {
    fixture.state.reviewers = ["USER_REVIEWER"];

    const api = {
      ...gw.api,
      requestPullRequestReviewers: (r: github.PullRequestMutationRequest) =>
        gw.api.requestPullRequestReviewers(r, browser),
      getPullRequestMutation: (r: github.PullRequestMutationRequestRef) => gw.api.getPullRequestMutation(r, browser),
    };

    const editor = new GitHubMetadataEditor(
      "reviewers",
      api,
      snapshot,
      () => crypto.randomUUID(),
      () => false,
      (e) => ConnectError.from(e).rawMessage,
    );

    await editor.load();
    expect(editor.state.ids).toEqual(["USER_REVIEWER"]);
    const before = fixture.state.writes;
    expect(await editor.apply()).toBe(true);
    expect(fixture.state.writes).toBe(before);
    await editor.load();
    editor.toggle("USER_REVIEWER");
    editor.toggle("USER_MEMBER");
    editor.toggle("TEAM_REPO");
    // Expire Summary before the intermediate read, independently of background watch timing.
    fixture.advance(61_000);
    expect(await editor.apply()).toBe(true);
    expect(fixture.state.reviewers.toSorted()).toEqual(["TEAM_REPO", "USER_MEMBER"]);
    expect(fixture.state.writes - before).toBe(2);
    expect(await editor.reRequest("USER_REVIEWER")).toBe(true);
    expect(editor.state.ids).toContain("USER_REVIEWER");
    expect(fixture.state.writes - before).toBe(3);
  }, 30_000);

  test("a partially acknowledged reviewer diff stops on uncertainty without adding or replaying requests", async () => {
    fixture.state.reviewers = ["USER_REVIEWER"];

    const api = {
      ...gw.api,
      requestPullRequestReviewers: (r: github.PullRequestMutationRequest) =>
        gw.api.requestPullRequestReviewers(r, browser),
      getPullRequestMutation: (r: github.PullRequestMutationRequestRef) => gw.api.getPullRequestMutation(r, browser),
    };

    const editor = new GitHubMetadataEditor(
      "reviewers",
      api,
      snapshot,
      () => crypto.randomUUID(),
      () => false,
      (e) => ConnectError.from(e).rawMessage,
    );

    await editor.load();
    editor.toggle("USER_REVIEWER");
    editor.toggle("USER_MEMBER");
    const before = fixture.state.writes;
    fixture.state.lost = true;
    expect(await editor.apply()).toBe(false);
    expect(editor.state.receipt?.state).toBe("uncertain");
    expect(fixture.state.reviewers).toEqual([]);
    expect(await editor.apply()).toBe(false);
    expect(fixture.state.writes - before).toBe(1);
    await editor.load(true);
    expect(editor.state.ids).toEqual([]);
    expect(fixture.state.writes - before).toBe(1);
  }, 30_000);

  test("disconnect between preparation and Apply revokes the intent", async () => {
    const r = await request("set_assignees", { metadataIds: ["USER_REVIEWER"] });
    await gw.api.preparePullRequestMutation(r, browser);
    const before = fixture.state.writes;
    await gw.api.disconnectGitHubAccount({ accountId: snapshot.accountId });
    expect(await code(gw.api.setPullRequestAssignees(r, browser))).toBe(Code.FailedPrecondition);
    expect(fixture.state.writes).toBe(before);
  }, 30_000);
});

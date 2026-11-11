import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { github, ui } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { startGrpcServer } from "@canopy/transport";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { GitHubCiController, ciEffect } from "@canopy/domain/github-ci";
import { ciFixture } from "./support/github-ci.ts";
import { linkedRead, readHead } from "./support/github-read.ts";
import { githubBrowser } from "./support/github-pr.ts";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

const code = (promise: Promise<object>) =>
  promise.then(
    () => 0,
    (e) => ConnectError.from(e).code,
  );

describe.skipIf(!dockerAvailable)("GitHub CI owner boundaries and durable asynchronous commands", () => {
  const fixture = ciFixture(),
    browser = githubBrowser();

  const mode = github.PullRequestRerunMode;
  let gw: TestGateway, pr: string, snapshot: github.PullRequestSnapshot;

  const request = (fields: MessageInitShape<typeof github.PullRequestMutationRequestSchema> = {}) =>
    mutationRequest(snapshot, crypto.randomUUID(), "rerun_checks", {
      runId: "123",
      runAttempt: 1,
      rerunMode: mode.ALL_JOBS,
      ...fields,
    });

  const sql = (query: string, values: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SqlClient.SqlClient).unsafe(query, values);
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

  test("failed/all/single-job use only Actions rerun endpoints; a job includes its dependents", async () => {
    for (const [rerunMode, path] of [
      [mode.FAILED_JOBS, "/runs/123/rerun-failed-jobs"],
      [mode.ALL_JOBS, "/runs/123/rerun"],
      [mode.SINGLE_JOB, "/jobs/456/rerun"],
    ] as const) {
      const r = request({ rerunMode, ...(rerunMode === mode.SINGLE_JOB && { jobId: "456" }) });
      const result = await gw.api.rerunPullRequestChecks(r, browser);
      expect(result.state).toBe("accepted");
      expect(fixture.state.writes.at(-1)?.path).toEndWith(path);
      expect(fixture.state.writes.at(-1)?.body).toEqual({});
      expect((await gw.api.rerunPullRequestChecks(r, browser)).state).toBe("accepted");
    }

    expect([...fixture.state.jobs.values()]).toEqual(["queued", "queued"]);
    expect(ciEffect("job")).toContain("dependent jobs");
    expect(ciEffect("job")).toContain("Deployments");
    expect(fixture.state.writes.length).toBe(3);
  }, 30_000);

  test("foreign run/job/repository/PR/SHA and stale run/job attempt are refused before sending", async () => {
    const before = fixture.state.writes.length;

    for (const fields of [
      { runId: "999" },
      { jobId: "999", rerunMode: mode.SINGLE_JOB },
      { pullRequestId: crypto.randomUUID() },
      { headSha: "c".repeat(40) },
      { runAttempt: 2 },
    ])
      expect(await code(gw.api.rerunPullRequestChecks(request(fields), browser))).not.toBe(0);

    for (const change of [
      { repository: 888 },
      { pullRequest: 99 },
      { head: "d".repeat(40) },
      { jobRun: 999 },
      { jobAttempt: 2 },
      { jobHead: "e".repeat(40) },
    ]) {
      Object.assign(fixture.state, change);

      try {
        expect(
          await code(gw.api.rerunPullRequestChecks(request({ jobId: "456", rerunMode: mode.SINGLE_JOB }), browser)),
        ).not.toBe(0);
      } finally {
        Object.assign(fixture.state, {
          repository: 777,
          pullRequest: 42,
          head: readHead,
          jobRun: 123,
          jobAttempt: 1,
          jobHead: readHead,
        });
      }
    }

    expect(fixture.state.writes.length).toBe(before);
  }, 30_000);

  test("an empty response outside the documented Actions acceptance statuses remains uncertain without replay", async () => {
    const before = fixture.state.writes.length;
    const r = request();
    fixture.state.writeStatus = 200;

    try {
      expect((await gw.api.rerunPullRequestChecks(r, browser)).state).toBe("uncertain");
      expect((await gw.api.rerunPullRequestChecks(r, browser)).state).toBe("uncertain");
      expect(fixture.state.writes.length).toBe(before + 1);
    } finally {
      fixture.state.writeStatus = 0;
    }
  }, 30_000);

  test("cancel needs a fresh client-bound confirmation of the whole run and attempt", async () => {
    fixture.state.status = "in_progress";
    const r = request({ action: "cancel_run", rerunMode: mode.UNSPECIFIED });
    const before = fixture.state.writes.length;
    expect(await code(gw.api.cancelPullRequestCheckRun(r, browser))).toBe(Code.FailedPrecondition);
    const p = await gw.api.preparePullRequestMutation(r, browser);
    expect(fixture.state.writes.length).toBe(before);
    expect(await code(gw.api.cancelPullRequestCheckRun({ ...r, confirmationId: crypto.randomUUID() }, browser))).toBe(
      Code.FailedPrecondition,
    );
    expect(
      await code(gw.api.cancelPullRequestCheckRun({ ...r, confirmationId: p.confirmationId }, githubBrowser())),
    ).toBe(Code.AlreadyExists);
    fixture.state.attempt = 2;
    expect(await code(gw.api.cancelPullRequestCheckRun({ ...r, confirmationId: p.confirmationId }, browser))).toBe(
      Code.FailedPrecondition,
    );
    fixture.state.attempt = 1;
    const result = await gw.api.cancelPullRequestCheckRun({ ...r, confirmationId: p.confirmationId }, browser);
    expect(result.state).toBe("accepted");
    expect(result.detail).toContain("Cancellation requested");
    expect(fixture.state.status).toBe("in_progress");
    expect(fixture.state.writes.at(-1)?.path).toEndWith("/runs/123/cancel");
    fixture.state.status = "completed";
  }, 30_000);

  test("accepted is not done; fresh check/job pages progress through queued and in_progress", async () => {
    const r = request();
    expect((await gw.api.rerunPullRequestChecks(r, browser)).state).toBe("accepted");

    for (const status of ["queued", "in_progress"]) {
      fixture.state.status = status;
      fixture.state.attempt = 2;
      fixture.state.jobAttempt = 2;
      const checks = await gw.api.listPullRequestChecks({ pullRequestId: pr, refresh: true });
      expect(checks.checks[0]?.state).toBe(status);
      const jobs = await gw.api.listPullRequestCheckJobs({ pullRequestId: pr, resourceId: "123", refresh: true });
      expect(jobs.run?.attempt).toBe(2);
      expect(jobs.run?.state).toBe(status);
    }

    fixture.state.status = "completed";
    fixture.state.attempt = 1;
    fixture.state.jobAttempt = 1;
  }, 30_000);

  test("Actions write and user repository rights are independent of Checks read", async () => {
    const before = fixture.state.writes.length;
    fixture.state.actionsWrite = false;
    expect(await code(gw.api.rerunPullRequestChecks(request(), browser))).toBe(Code.PermissionDenied);
    expect((await gw.api.getPullRequest({ pullRequestId: pr, refresh: true })).ciBlockingReason).toContain(
      "Actions write",
    );
    fixture.state.actionsWrite = true;
    fixture.state.push = false;
    expect(await code(gw.api.rerunPullRequestChecks(request(), browser))).toBe(Code.PermissionDenied);
    fixture.state.push = true;
    expect(fixture.state.writes.length).toBe(before);
  }, 30_000);

  test("dispatch/debug/force-cancel and action substitution have no API surface", async () => {
    const before = fixture.state.writes.length;

    for (const fields of [
      { action: "workflow_dispatch" },
      { action: "force_cancel" },
      { rerunMode: mode.UNSPECIFIED },
      { body: '{"enable_debug_logging":true}' },
      { method: "force-cancel" },
    ])
      expect(await code(gw.api.rerunPullRequestChecks(request(fields), browser))).toBe(Code.InvalidArgument);
    expect(ui.GatewayService.methods.some((m) => /dispatch|debug|forceCancel/i.test(m.name))).toBe(false);
    expect(fixture.state.writes.length).toBe(before);
  }, 30_000);

  test("lost responses and restart recovery remain uncertain without replay or secret audit data", async () => {
    const r = request({ rerunMode: mode.SINGLE_JOB, jobId: "456" });
    fixture.state.lost = true;
    const before = fixture.state.writes.length;
    expect((await gw.api.rerunPullRequestChecks(r, browser)).state).toBe("uncertain");
    expect((await gw.api.rerunPullRequestChecks(r, browser)).state).toBe("uncertain");
    expect(await code(gw.api.rerunPullRequestChecks({ ...r, runAttempt: 2 }, browser))).toBe(Code.AlreadyExists);
    const abandoned = request();
    await gw.api.preparePullRequestMutation(abandoned, browser);
    await sql(
      "UPDATE github_mutation_receipts SET state='in_flight',lease_until=now()-interval '1 second' WHERE request_id=$1::uuid",
      [abandoned.clientRequestId],
    );

    const restarted = new GatewayCore({
      runtime: gw.runtime,
      userId: gw.userId,
      instanceId: "ci-restart",
      sshSecretsKey: gw.secretsKey,
      github: fixture.options,
    });

    try {
      const client = await sql("SELECT client_binding FROM github_mutation_receipts WHERE request_id=$1::uuid", [
        abandoned.clientRequestId,
      ]);

      const binding = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ client_binding: Schema.String })))(
        client,
      )[0]!.client_binding;

      expect((await restarted.github.mutations.run(abandoned, binding)).state).toBe("uncertain");
    } finally {
      await restarted.stopSweep();
    }

    expect(fixture.state.writes.length - before).toBe(1);

    const audit = JSON.stringify(
      await sql("SELECT details FROM audit_log WHERE details->>'requestId'=$1", [r.clientRequestId]),
    );

    expect(audit).toContain('"runId":"123"');
    expect(audit).toContain('"jobId":"456"');
    expect(audit).not.toContain("Bearer");
  }, 30_000);

  test("shared mobile/web controller prepares without sending, reports acceptance and never replays on check", async () => {
    const api = {
      ...gw.api,
      preparePullRequestMutation: (r: github.PullRequestMutationRequest) =>
        gw.api.preparePullRequestMutation(r, browser),
      rerunPullRequestChecks: (r: github.PullRequestMutationRequest) => gw.api.rerunPullRequestChecks(r, browser),
      getPullRequestMutation: (r: github.PullRequestMutationRequestRef) => gw.api.getPullRequestMutation(r, browser),
    };

    snapshot = await gw.api.getPullRequest({ pullRequestId: pr, refresh: true });

    const controller = new GitHubCiController(
      api,
      snapshot,
      "123",
      () => crypto.randomUUID(),
      () => false,
      (e) => ConnectError.from(e).rawMessage,
    );

    const before = fixture.state.writes.length;
    await controller.choose("job", "456", "Build");
    expect(controller.state.prepared?.jobId).toBe("456");
    expect(fixture.state.writes.length).toBe(before);
    await controller.confirm();
    expect(controller.state.receipt?.state).toBe("accepted");
    expect(controller.state.open).toBe(true);
    expect(controller.state.jobId).toBe("456");
    expect(controller.state.jobName).toBe("Build");
    fixture.advance(61_000);
    await controller.confirm();
    await controller.check();
    expect(controller.state.open).toBe(false);
    await controller.choose("all");
    expect(controller.state.prepared?.jobId).toBe("");
    expect(fixture.state.writes.length - before).toBe(1);
  }, 30_000);

  test("workers and bots cannot prepare, run, cancel or inspect receipts", async () => {
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
        () => api.preparePullRequestMutation(request()),
        () => api.rerunPullRequestChecks(request()),
        () => api.cancelPullRequestCheckRun(request({ action: "cancel_run", rerunMode: mode.UNSPECIFIED })),
        () => api.getPullRequestMutation({ pullRequestId: pr, clientRequestId: crypto.randomUUID() }),
      ])
        expect(await code(invoke())).toBe(Code.Unauthenticated);
    }
  });

  test("expired confirmation, changed account revision and a mismatched UI snapshot never send CI writes", async () => {
    fixture.state.status = "in_progress";
    const r = request({ action: "cancel_run", rerunMode: mode.UNSPECIFIED });
    const prepared = await gw.api.preparePullRequestMutation(r, browser);
    await sql("UPDATE github_mutation_receipts SET expires_at=now()-interval '1 second' WHERE request_id=$1::uuid", [
      r.clientRequestId,
    ]);
    const before = fixture.state.writes.length;
    expect(
      await code(gw.api.cancelPullRequestCheckRun({ ...r, confirmationId: prepared.confirmationId }, browser)),
    ).toBe(Code.FailedPrecondition);
    expect(await code(gw.api.rerunPullRequestChecks(request({ accountId: crypto.randomUUID() }), browser))).toBe(
      Code.FailedPrecondition,
    );
    expect(
      await code(gw.api.rerunPullRequestChecks(request({ accessRevision: snapshot.accessRevision + 1n }), browser)),
    ).toBe(Code.FailedPrecondition);
    fixture.state.status = "completed";

    const api = {
      ...gw.api,
      preparePullRequestMutation: (r: github.PullRequestMutationRequest) =>
        gw.api.preparePullRequestMutation(r, browser),
    };

    const controller = new GitHubCiController(
      api,
      snapshot,
      "123",
      () => crypto.randomUUID(),
      () => false,
      (e) => ConnectError.from(e).rawMessage,
    );

    await controller.choose("all");
    controller.snapshot = { ...snapshot, accountId: crypto.randomUUID() };
    await controller.confirm();
    expect(controller.state.prepared).toBeUndefined();
    expect(controller.state.detail).toContain("account changed");
    expect(fixture.state.writes.length).toBe(before);
  }, 30_000);

  test("foreign owners cannot access CI, mutations or receipts through gRPC", async () => {
    const owner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("ci-other@example.test", "Other owner")),
    );

    const core = new GatewayCore({
      runtime: gw.runtime,
      userId: owner,
      instanceId: "ci-other",
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

    try {
      const r = request();
      await gw.api.preparePullRequestMutation(r, browser);

      for (const invoke of [
        () => api.listPullRequestCheckJobs({ pullRequestId: pr, resourceId: "123" }),
        () => api.rerunPullRequestChecks(r, browser),
        () => api.cancelPullRequestCheckRun({ ...r, action: "cancel_run", rerunMode: mode.UNSPECIFIED }, browser),
        () => api.getPullRequestMutation({ pullRequestId: pr, clientRequestId: r.clientRequestId }, browser),
      ])
        expect(await code(invoke())).toBe(Code.NotFound);
    } finally {
      await core.stopSweep();
      await grpc.close();
    }
  }, 30_000);
});

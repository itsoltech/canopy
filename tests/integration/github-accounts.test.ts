import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { githubFixture } from "./support/github.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const client = { headers: { "canopy-github-client": randomBytes(32).toString("base64url") } };
const otherClient = { headers: { "canopy-github-client": randomBytes(32).toString("base64url") } };

describe.skipIf(!dockerAvailable)("GitHub accounts over gRPC with local HTTP", () => {
  let gw: TestGateway;
  let fixture: ReturnType<typeof githubFixture>;
  beforeAll(async () => {
    fixture = githubFixture();
    gw = await startTestGateway({ github: fixture.options });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture?.close();
  });

  const begin = () => gw.api.beginGitHubDeviceAuth({ clientRequestId: crypto.randomUUID() }, client);

  async function connect(user: number) {
    fixture.user(user);
    fixture.mode("success");
    const started = await begin();
    fixture.advance(5000);
    await gw.core.github.device.tick();
    const result = await gw.api.getGitHubDeviceAuth({ attemptId: started.attempt!.id }, client);
    expect(result.attempt!.state).toBe("connected");
    // Settle the initial catalogue before a test jumps the clock or changes upstream behavior.
    await gw.api.listGitHubInstallations({ accountId: result.attempt!.accountId });

    return result.attempt!.accountId;
  }

  test("unconfigured is a quiet state and never starts network auth", async () => {
    const unconfigured = new GitHubAccounts(gw.runtime, gw.userId, { ...fixture.options, clientId: "", slug: "" });
    expect((await unconfigured.list()).configured).toBe(false);
    expect(
      (
        await unconfigured.device.begin({
          $typeName: "canopy.ui.v1.BeginGitHubDeviceAuthRequest",
          homeId: "",
          clientBinding: "",
          clientRequestId: "",
        })
      ).configured,
    ).toBe(false);
  });

  test("pending and slow_down persist the upstream interval; a browser cannot read another's attempt", async () => {
    fixture.mode("authorization_pending");
    const started = await begin();
    const id = started.attempt!.id;
    const polls = fixture.polls;
    await gw.core.github.device.tick();
    expect(fixture.polls).toBe(polls);
    fixture.advance(5000);
    await gw.core.github.device.tick();
    expect(fixture.polls).toBe(polls + 1);
    fixture.mode("slow_down");
    fixture.advance(5000);
    await gw.core.github.device.tick();
    expect((await gw.api.getGitHubDeviceAuth({ attemptId: id }, client)).attempt!.intervalSeconds).toBe(10);
    fixture.advance(5000);
    await gw.core.github.device.tick();
    expect(fixture.polls).toBe(polls + 2);
    expect(await failure(gw.api.getGitHubDeviceAuth({ attemptId: id }, otherClient))).toContain("not found");
    await gw.api.cancelGitHubDeviceAuth({ attemptId: id }, client);
    fixture.advance(10_000);
    await gw.core.github.device.tick();
    expect(fixture.polls).toBe(polls + 2);
    expect((await gw.api.getGitHubDeviceAuth({ attemptId: id }, client)).attempt!.state).toBe("cancelled");
  });

  test("expiry and denial remove encrypted codes; replaying a start is idempotent", async () => {
    const request = { clientRequestId: crypto.randomUUID() };
    const started = await gw.api.beginGitHubDeviceAuth(request, client);
    expect((await gw.api.beginGitHubDeviceAuth(request, client)).attempt!.id).toBe(started.attempt!.id);
    fixture.advance(901_000);
    await gw.core.github.device.tick();
    expect((await gw.api.getGitHubDeviceAuth({ attemptId: started.attempt!.id }, client)).attempt!.state).toBe(
      "expired",
    );
    fixture.mode("access_denied");
    const denied = await begin();
    fixture.advance(5000);
    await gw.core.github.device.tick();
    expect((await gw.api.getGitHubDeviceAuth({ attemptId: denied.attempt!.id }, client)).attempt!.state).toBe("denied");

    const codes = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`SELECT id FROM github_device_auth WHERE state<>'pending' AND device_code IS NOT NULL`;
      }),
    );

    expect(codes).toHaveLength(0);
  });

  test("accounts and catalogues are owner scoped and no credential reaches DTOs, logs or workers", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});

    try {
      const id = await connect(101);
      const second = await connect(102);
      expect(id).not.toBe(second);
      expect(await connect(101)).toBe(id);
      const accounts = await gw.api.listGitHubAccounts({});
      expect(accounts.accounts).toHaveLength(2);
      const installations = await gw.api.listGitHubInstallations({ accountId: id });
      expect(installations.installations[0]!.manageUrl).toBe(
        "https://github.com/organizations/organization-101/settings/installations/101",
      );
      const repositories = await gw.api.listGitHubRepositories({ accountId: id, installationId: "101" });
      expect(repositories.repositories[0]!.fullName).toBe("organization-101/canopy");
      const other = crypto.randomUUID();
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES (${other}::uuid,${`${other}@example.test`},'Other','user')`;
        }),
      );
      const foreign = new GitHubAccounts(gw.runtime, other, fixture.options);
      expect((await foreign.list()).accounts).toHaveLength(0);
      expect(await failure(foreign.disconnect(id))).toContain("not found");
      expect(await failure(foreign.catalogue.refresh(id))).toContain("not found");

      const output = inspect(
        [
          accounts,
          installations,
          repositories,
          warn.mock.calls,
          error.mock.calls,
          gw.worker.commands,
          gw.worker.configs,
        ],
        { depth: null },
      );

      for (const secret of fixture.secrets) expect(output.includes(secret)).toBe(false);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("rotating refresh is single-flight across independent services; a second 401 requires reconnect", async () => {
    const id = await connect(103);
    const otherProcess = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    fixture.advance(28_600_000);
    const previous = fixture.refreshes;
    await Promise.all([
      gw.core.github.access.get(id, "/user"),
      otherProcess.access.get(id, "/user"),
      gw.core.github.access.get(id, "/user"),
    ]);
    expect(fixture.refreshes).toBe(previous + 1);
    fixture.apiStatus(401);

    try {
      expect(await failure(gw.api.listGitHubInstallations({ accountId: id, refresh: true }))).toContain("Reconnect");
      expect(fixture.refreshes).toBe(previous + 2);
      expect((await gw.api.listGitHubAccounts({})).accounts.find((a) => a.id === id)!.status).toBe("needs_reconnect");
    } finally {
      fixture.apiStatus(200);
    }
  });

  test("disconnect fences an in-flight refresh and deletes credentials", async () => {
    const id = await connect(104);
    fixture.advance(28_600_000);
    let release = () => {};

    fixture.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const previous = fixture.refreshes;
    const refresh = failure(gw.core.github.access.get(id, "/user"));
    await eventually(
      async () => fixture.refreshes,
      (count) => count > previous,
    );
    await gw.api.disconnectGitHubAccount({ accountId: id });
    release();
    expect(await refresh).toContain("Reconnect");
    fixture.gate(Promise.resolve());
    const row = await gw.core.github.run((s) => s.owned(gw.userId, id));
    expect(row.credentials).toBeNull();
    expect(row.status).toBe("disconnected");
  });

  test("rejected refresh fails closed without reusing a rotating token", async () => {
    const id = await connect(105);
    fixture.advance(28_600_000);
    fixture.refreshStatus(401);
    const previous = fixture.refreshes;
    expect(await failure(gw.core.github.access.get(id, "/user"))).toContain("Reconnect");
    expect(await failure(gw.core.github.access.get(id, "/user"))).toContain("Reconnect");
    expect(fixture.refreshes).toBe(previous + 1);
    fixture.refreshStatus(200);
  });

  test("cancellation wins while GitHub is exchanging the device code", async () => {
    fixture.user(106);
    fixture.mode("success");
    const started = await begin();
    fixture.advance(5000);
    let release = () => {};

    fixture.deviceGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const count = fixture.polls;
    const tick = gw.core.github.device.tick();
    await eventually(
      async () => fixture.polls,
      (n) => n > count,
    );
    expect((await gw.api.cancelGitHubDeviceAuth({ attemptId: started.attempt!.id }, client)).attempt!.state).toBe(
      "cancelled",
    );
    release();
    await tick;
    fixture.deviceGate(Promise.resolve());
    expect((await gw.api.listGitHubAccounts({})).accounts.some((a) => a.githubUserId === "106")).toBe(false);
  });

  test("catalogues paginate both upstream and DTOs without losing installations or repositories", async () => {
    fixture.catalogue(101, true);

    try {
      const id = await connect(107);
      const first = await gw.api.listGitHubInstallations({ accountId: id });
      expect(first.installations).toHaveLength(50);
      expect(first.nextPage).toBe(1);
      const second = await gw.api.listGitHubInstallations({ accountId: id, page: first.nextPage });
      const last = await gw.api.listGitHubInstallations({ accountId: id, page: second.nextPage });
      expect(last.installations).toHaveLength(1);
      expect(last.nextPage).toBe(0);
      const repositories = await gw.api.listGitHubRepositories({ accountId: id, installationId: "107" });

      const middle = await gw.api.listGitHubRepositories({
        accountId: id,
        installationId: "107",
        page: repositories.nextPage,
      });

      const end = await gw.api.listGitHubRepositories({ accountId: id, installationId: "107", page: middle.nextPage });
      expect(
        new Set([...repositories.repositories, ...middle.repositories, ...end.repositories].map((r) => r.repositoryId))
          .size,
      ).toBe(101);
      expect(end.nextPage).toBe(0);
    } finally {
      fixture.catalogue(1);
    }
  }, 15_000);

  test("pending attempts survive a gateway restart and cancellation survives the next restart", async () => {
    fixture.mode("authorization_pending");
    const started = await begin();

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ github: fixture.options, storage });
    expect((await gw.api.getGitHubDeviceAuth({ attemptId: started.attempt!.id }, client)).attempt!.state).toBe(
      "pending",
    );
    await gw.api.cancelGitHubDeviceAuth({ attemptId: started.attempt!.id }, client);
    await gw.close(true);
    gw = await startTestGateway({ github: fixture.options, storage });
    fixture.mode("success");
    fixture.advance(5000);
    await gw.core.github.device.tick();
    expect((await gw.api.getGitHubDeviceAuth({ attemptId: started.attempt!.id }, client)).attempt!.state).toBe(
      "cancelled",
    );
    expect(
      await gw.api.beginGitHubDeviceAuth({}, client).then(
        () => 0,
        (e) => ConnectError.from(e).code,
      ),
    ).toBe(Code.InvalidArgument);
  });

  test("credentials echoed in upstream metadata are redacted before storage and DTOs", async () => {
    fixture.echo(true);

    try {
      const id = await connect(108);
      const accounts = await gw.api.listGitHubAccounts({});
      const installations = await gw.api.listGitHubInstallations({ accountId: id });
      const repositories = await gw.api.listGitHubRepositories({ accountId: id, installationId: "108" });
      const row = await gw.core.github.run((s) => s.owned(gw.userId, id));
      const output = inspect([accounts, installations, repositories, row.login], { depth: null });

      for (const secret of fixture.secrets) expect(output.includes(secret)).toBe(false);
    } finally {
      fixture.echo(false);
    }
  });

  test("an expired refresh lease fails closed after a crash instead of replaying a rotating token", async () => {
    const id = await connect(109);
    const row = await gw.core.github.run((s) => s.owned(gw.userId, id));
    expect(
      await gw.core.github.run((s) => s.refreshClaim(row, crypto.randomUUID(), fixture.options.now!())),
    ).toHaveLength(1);
    fixture.advance(31_000);
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    const previous = fixture.refreshes;
    expect(await failure(restarted.access.get(id, "/user"))).toContain("Reconnect");
    expect(fixture.refreshes).toBe(previous);
    expect((await gw.core.github.run((s) => s.owned(gw.userId, id))).credentials).toBeNull();
  });
});

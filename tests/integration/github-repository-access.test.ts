import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { GatewayStore } from "@canopy/gateway/store";
import { connectGitHub } from "./support/github-pr.ts";
import { repositoryAccessFixture } from "./support/github-repository-access.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("automatic repository accounts through owner-scoped gRPC", () => {
  const fixture = repositoryAccessFixture();
  let gw: TestGateway;
  let first = "";
  let second = "";
  const get = () => gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
  const refresh = (accountId: string) => gw.api.listGitHubInstallations({ accountId, refresh: true });
  const choose = async (accountId: string) =>
    gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId,
      expectedRevision: (await get()).revision,
    });

  const forget = () =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM github_repository_accounts WHERE owner_user_id=${gw.userId}::uuid AND repository_id='777'`;
      }),
    );

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    first = await connectGitHub(gw, fixture);
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("one connected account with an organization installation is selected silently and cached", async () => {
    const calls = fixture.requests.length;
    const selected = await get();
    expect(selected.accountId).toBe(first);
    expect(selected.repositoryId).toBe("777");
    expect(selected.candidates.map((a) => a.id)).toEqual([first]);
    expect((await get()).revision).toBe(selected.revision);
    expect(fixture.requests).toHaveLength(calls);
  });

  test("several accounts with only one matching installation still need no account choice", async () => {
    fixture.access(202, ["other/project"]);
    second = await connectGitHub(gw, fixture, 202);
    const selected = await get();
    expect(selected.accountId).toBe(first);
    expect(selected.candidates.map((a) => a.id)).toEqual([first]);
  });

  test("multiple matches choose deterministically, prefer a person over a bot and remember overrides", async () => {
    fixture.access(202, ["itsoltech/canopy"]);
    await refresh(second);
    await forget();
    expect((await get()).accountId).toBe(first);
    fixture.accountType(101, "Bot");
    expect(await connectGitHub(gw, fixture, 101)).toBe(first);
    await forget();
    expect((await get()).accountId).toBe(second);
    await choose(first);
    const remembered = await get();
    expect(remembered.accountId).toBe(first);
    expect(remembered.candidates).toHaveLength(2);
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);

    try {
      expect((await restarted.prs.repositories.get("itsoltech/canopy")).accountId).toBe(first);
    } finally {
      await restarted.stop();
    }
  });

  test("installation re-list replaces the index, invalidates access and automatically uses the remaining account", async () => {
    const previous = (await gw.core.github.access.token(first)).row.revision;
    fixture.access(101, []);
    expect((await get()).accountId).toBe(first);
    await refresh(first);
    const selected = await get();
    expect(selected.accountId).toBe(second);
    expect(selected.candidates.map((a) => a.id)).toEqual([second]);
    expect((await gw.core.github.access.token(first)).row.revision).toBeGreaterThan(previous);
    const revision = (await gw.core.github.access.token(second)).row.revision;
    await refresh(second);
    expect((await gw.core.github.access.token(second)).row.revision).toBe(revision);
  });

  test("periodic expiry refreshes the index and no access returns an actionable error", async () => {
    fixture.access(202, []);
    fixture.advance(900_001);
    await gw.core.github.background.tick();
    const selected = await get();
    expect(selected.accountId).toBe("");
    expect(selected.candidates).toHaveLength(0);
    const result = await gw.core.github.prs.repositories.selected("itsoltech/canopy").catch(ConnectError.from);
    expect(result).toBeInstanceOf(ConnectError);
    expect(ConnectError.from(result).code).toBe(Code.PermissionDenied);
    expect(ConnectError.from(result).rawMessage).toContain("No connected GitHub account can access itsoltech/canopy");
  });

  test("another owner's installation index and remembered choices cannot authorize this owner", async () => {
    fixture.access(101, ["itsoltech/canopy"]);
    await refresh(first);
    expect((await get()).accountId).toBe(first);
    const owner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("repository-owner@example.test", "Other owner")),
    );

    const foreign = new GitHubAccounts(gw.runtime, owner, fixture.options);
    const calls = fixture.requests.length;

    try {
      const selected = await foreign.prs.repositories.get("itsoltech/canopy");
      expect(selected.accountId).toBe("");
      expect(selected.candidates).toHaveLength(0);
      await expect(foreign.prs.repositories.selected("itsoltech/canopy")).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      await expect(foreign.catalogue.refresh(first, true)).rejects.toMatchObject({ code: Code.NotFound });
      expect(fixture.requests).toHaveLength(calls);
    } finally {
      await foreign.stop();
    }
  });
});

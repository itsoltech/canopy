import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { fakeConnector } from "./support/connector.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";
import { GatewayStore } from "@canopy/gateway/store";
import type { JsonValue } from "@canopy/domain";
import type { connectors, ui } from "@canopy/contracts";

describe.skipIf(!dockerAvailable)("GitHub merged PR evidence for worktree cleanup", () => {
  const dir = tempDir("canopy-worktree-github-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  let fake: ReturnType<typeof fakeConnector>;
  let account: connectors.ConnectorAccount;
  let thread: ui.Thread;

  let branch = "",
    head = "",
    merged = true;

  beforeAll(async () => {
    f = await worktreeFixture(dir);
    fake = fakeConnector({
      call: (name): JsonValue =>
        name === "list_pull_requests"
          ? [{ number: 7, head: { ref: branch, sha: head } }]
          : { merged, head: { ref: branch, sha: head }, base: { repo: { full_name: "canopy-test/repo" } } },
    });
    thread = await f.tree();
    branch = thread.worktree!.branch;
    head = commit(thread.cwd, "feature.txt", "feature\n");
    git(f.repo, "config", `url.${f.origin}.insteadOf`, "https://github.com/canopy-test/repo.git");
    git(f.repo, "remote", "set-url", "origin", "https://github.com/canopy-test/repo.git");
    account = (
      await f.gw.api.saveConnectorAccount({
        connectorType: "github",
        name: "Fixture GitHub",
        url: fake.url,
        authKind: "headers",
        token: fake.secret,
      })
    ).account!;
    await f.settings({ cleanupMerged: true });
  }, 60_000);
  afterAll(async () => {
    fake?.close();
    await f?.close();
  });

  test("an owner account without a worker grant cannot mark a branch merged", async () => {
    expect((await f.entry(thread.worktree!.id)).status?.merged).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("gateway confirms the exact merged PR through the granted account; closed alone and stale heads fail", async () => {
    account = (
      await f.gw.api.setConnectorAccess({
        accountId: account.id,
        expectedRevision: account.revision,
        workerIds: [f.workerId],
      })
    ).account!;
    merged = false;
    expect((await f.entry(thread.worktree!.id)).status?.merged).toBe(false);
    merged = true;
    const entry = await f.entry(thread.worktree!.id);
    expect(entry.status).toMatchObject({ merged: true, unpushed: false, githubRepository: "canopy-test/repo" });
    expect(entry.wouldRemove).toBe(true);
    expect(fake.calls.map((c) => c.name)).toContain("pull_request_read");
    const calls = fake.calls.length;
    const other = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("github-other@x", "Other")));
    expect(await f.gw.core.connectors.worktreeMerged(other, f.workerId, "canopy-test/repo", branch, head)).toBe(false);
    expect(fake.calls).toHaveLength(calls);
    commit(thread.cwd, "after-merge.txt", "new work\n");
    expect((await f.entry(thread.worktree!.id)).status?.merged).toBe(false);
    head = git(thread.cwd, "rev-parse", "HEAD");
  });

  test("worker refuses PR evidence for a different repository or HEAD", async () => {
    const tree = thread.worktree!;
    const connection = f.gw.core.link.connections.get(f.workerId)!;

    for (const proof of [
      { mergedPrHead: head, mergedPrRepository: "another/repository" },
      { mergedPrHead: "0".repeat(40), mergedPrRepository: "canopy-test/repo" },
    ]) {
      const result = await connection.sendCommand(
        {
          case: "scanWorktrees",
          value: {
            fetch: true,
            targets: [
              {
                id: tree.id,
                path: tree.path,
                repoRoot: tree.repoRoot,
                branch,
                baseRef: tree.baseRef,
                ...proof,
              },
            ],
          },
        },
        60_000,
      );

      expect(result.worktreeStatuses[0]).toMatchObject({ merged: false, unpushed: true });
    }
  });

  test("confirmed cleanup sends no connector credentials to the worker", async () => {
    const result = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === thread.worktree!.id);
    expect(result?.removed).toBe(true);

    const rows = await f.sql(
      (sql) =>
        sql<{
          removal_command: Uint8Array | null;
        }>`SELECT removal_command FROM worktrees WHERE id = ${thread.worktree!.id}::uuid`,
    );

    expect(JSON.stringify(rows)).not.toContain(fake.secret);
    expect((await f.entry(thread.worktree!.id)).removed).toBe(true);
  });
});

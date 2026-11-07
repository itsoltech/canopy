import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Provider, ui } from "@canopy/contracts";
import { qualifyId, REMOTE_WORKTREES } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { tempDir } from "@canopy/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("external worktrees on a linked computer", () => {
  const dir = tempDir("canopy-linked-worktrees-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;
  let caller: Awaited<ReturnType<typeof startTestGateway>>;
  let a: LinkedComputers;
  let b: LinkedComputers;
  const external = join(dir, "external");
  const q = (id: string) => qualifyId(id, b.hello().nodeId);

  beforeAll(async () => {
    const data = join(dir, "home");
    mkdirSync(data);
    home = await worktreeFixture(data, { role: "desktop", capabilities: ["git_worktree_discovery", "git_heads"] });
    git(home.repo, "worktree", "add", "-qb", "external/linked", external);
    caller = await startTestGateway({ role: "desktop" });

    const connect = (gw: typeof caller) =>
      linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

    a = connect(caller);
    b = connect(home.gw);
    caller.core.computers = a;
    caller.core.network = a.options.network;
    home.gw.core.computers = b;
    home.gw.core.network = b.options.network;
    await a.start();
    await b.start();
    const invitation = await caller.api.createComputerPairing({});
    await home.gw.api.linkComputer({ address: a.addresses[0]!, code: invitation.code });
    await eventually(async () => a.reachable().includes(b.hello().nodeId), Boolean);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
    await caller?.close();
    await home?.close();
  });

  test("discovery, adoption and settings run at the checkout's home with qualified ids", async () => {
    const refs = await caller.api.listGitRefs({ workspaceId: q(home.workspace.id) });
    const tree = refs.worktrees.find((w) => w.path === external)!;
    expect(tree).toMatchObject({ external: true, workerId: q(home.workerId), branch: "external/linked" });
    expect(tree.id).toContain("~");

    const thread = (
      await caller.api.createThread({
        projectId: q(home.project.id),
        workspaceId: q(home.workspace.id),
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
        worktreeId: tree.id,
      })
    ).thread!;

    expect(thread.cwd).toBe(external);
    expect(thread.worktree?.external).toBe(true);
    await eventually(
      () => caller.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );
    expect(readFileSync(join(external, "worker-started.txt"), "utf8")).toBe(external);
    const entries = (await caller.api.listWorktrees({ workerId: q(home.workerId) })).entries;
    expect(entries.find((entry) => entry.worktree?.id === tree.id)?.worktree?.external).toBe(true);
    expect(
      await eventually(
        async () => (await caller.api.listWorktrees({})).entries.some((entry) => entry.worktree?.id === tree.id),
        Boolean,
        15_000,
      ),
    ).toBe(true);
    expect(await failure(caller.api.removeWorktree({ worktreeId: tree.id }))).toContain("outside Canopy");
    const cleanup = await caller.api.cleanupWorktrees({ workerId: q(home.workerId), dryRun: false });
    expect(cleanup.entries.find((entry) => entry.worktree?.id === tree.id)).toMatchObject({
      removed: false,
      wouldRemove: false,
    });
  });

  test("a home without worktree support refuses placement even with stale caller capabilities", async () => {
    const tree = (await caller.api.listGitRefs({ workspaceId: q(home.workspace.id) })).worktrees.find(
      (w) => w.path === external,
    )!;

    b.options.capabilities = b.hello().capabilities.filter((capability) => capability !== REMOTE_WORKTREES);
    const before = (await home.gw.api.listThreads({})).threads.length;
    expect(
      await failure(
        caller.api.createThread({
          projectId: q(home.project.id),
          workspaceId: q(home.workspace.id),
          provider: Provider.CODEX,
          workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
          worktreeId: tree.id,
        }),
      ),
    ).toContain("not supported yet");
    expect((await home.gw.api.listThreads({})).threads).toHaveLength(before);
  });
});

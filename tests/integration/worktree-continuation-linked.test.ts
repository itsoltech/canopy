import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { tempDir } from "@canopy/testing";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { git } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("continue a removed worktree at its linked home", () => {
  const dir = tempDir("canopy-linked-continuation-");
  let f: Awaited<ReturnType<typeof linkedProjectFixture>>;
  beforeAll(async () => {
    f = await linkedProjectFixture(dir, { shared: true });
    git(f.a.repo, "remote", "set-url", "origin", f.a.origin);
    git(f.b.repo, "remote", "set-url", "origin", f.b.origin);
  }, 90_000);
  afterAll(async () => {
    await f?.close();
  }, 30_000);

  test("the source id routes checkout creation and retry to its home", async () => {
    const source = await f.b.tree();
    await f.b.remove(source.worktree!.id);
    await f.b.gw.api.setThreadArchived({ threadId: source.id, archived: true });
    const suffix = `~${nodeRef(f.lb.hello().nodeId)}`;

    const request = {
      threadId: `${source.id}${suffix}`,
      baseRef: "main",
      clientRequestId: Bun.randomUUIDv7(),
    };

    const localTrees = git(f.a.repo, "worktree", "list", "--porcelain");
    const created = (await f.a.gw.api.continueThreadInWorktree(request)).thread!;
    expect(created.id.endsWith(suffix)).toBe(true);
    expect(created.workspaceId).toBe(`${source.workspaceId}${suffix}`);
    expect(created.workerId).toBe(`${f.b.workerId}${suffix}`);
    const homeId = created.id.slice(0, -suffix.length);
    const home = (await f.b.gw.api.getThread({ threadId: homeId })).thread!;
    await f.b.settled(home);
    expect(created.cwd).not.toBe(source.cwd);
    expect(readFileSync(join(created.cwd, "worker-started.txt"), "utf8")).toBe(created.cwd);
    expect(existsSync(source.cwd)).toBe(false);
    expect((await f.a.gw.api.continueThreadInWorktree(request)).thread!.id).toBe(created.id);
    expect(git(f.a.repo, "worktree", "list", "--porcelain")).toBe(localTrees);
    expect((await f.b.gw.api.getThread({ threadId: source.id })).thread!.archivedAt).toBeDefined();
  }, 20_000);
});

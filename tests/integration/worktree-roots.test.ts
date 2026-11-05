import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { homeWorktreesPath, resolveWorktreeRoots } from "../../apps/worker/src/git/worktree-roots.ts";
import { eventually } from "./support/gateway.ts";
import { worktreeFixture } from "./support/worktrees.ts";

/** Runs `run` with HOME and USERPROFILE pointing at `home`, as a worker started by that user would see them. */
function withHome<A>(home: string, run: () => A): A {
  const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
  process.env["HOME"] = process.env["USERPROFILE"] = home;

  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("worktree root resolution", () => {
  const dir = tempDir("canopy-worktree-roots-");

  test("home folder per platform, without hardcoded separators", () => {
    expect(homeWorktreesPath("C:\\Users\\ada", "win32")).toBe("C:\\Users\\ada\\canopy\\worktrees");
    expect(homeWorktreesPath("/Users/ada", "darwin")).toBe("/Users/ada/canopy/worktrees");
    expect(homeWorktreesPath("/home/ada/", "linux")).toBe("/home/ada/canopy/worktrees");
  });

  test("an unwritable or missing home falls back to the data directory, logged once", () => {
    const data = join(dir, "fallback-data");
    const home = join(dir, "locked-home");
    mkdirSync(home);
    chmodSync(home, 0o500);
    const logs: string[] = [];

    try {
      const roots = withHome(home, () => resolveWorktreeRoots({ dataDir: data, log: (m) => logs.push(m) }));
      expect(roots).toEqual({ primary: realpathSync(join(data, "worktrees")), managed: [roots.primary] });
      expect(logs).toHaveLength(1);
      expect(existsSync(join(home, "canopy"))).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }

    const file = join(dir, "home-file");
    writeFileSync(file, "");
    expect(resolveWorktreeRoots({ dataDir: data, home: file }).primary).toBe(realpathSync(join(data, "worktrees")));
    expect(resolveWorktreeRoots({ dataDir: data, home: "" }).primary).toBe(realpathSync(join(data, "worktrees")));
  });

  test("the override must be an absolute, writable folder", () => {
    expect(() => resolveWorktreeRoots({ dataDir: join(dir, "d"), override: "relative/worktrees" })).toThrow("absolute");
  });
});

describe.skipIf(!dockerAvailable)("worktree roots over gRPC", () => {
  const dir = tempDir("canopy-worktree-roots-grpc-");
  const home = join(dir, "home");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    mkdirSync(home);
    // The previous default: no home folder, worktrees under <data_dir>/worktrees.
    f = await worktreeFixture(dir);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("new worktrees go to the home folder; legacy ones stay listed, cleaned up and removable", async () => {
    const legacyRoot = realpathSync(join(f.data, "worktrees"));
    const kept = await f.tree();
    const removed = await f.tree();
    expect(realpathSync(kept.cwd).startsWith(join(legacyRoot, "repo"))).toBe(true);

    const roots = withHome(home, () => resolveWorktreeRoots({ dataDir: f.data }));
    const homeRoot = realpathSync(join(home, "canopy", "worktrees"));
    expect(roots).toEqual({ primary: homeRoot, managed: [homeRoot, legacyRoot] });
    await f.restart(roots);

    await eventually(
      () => f.gw.api.getOverview({}),
      (o) => o.workers.find((w) => w.id === f.workerId)?.worktreesRoot === homeRoot,
    );
    const fresh = await f.tree();
    expect(realpathSync(fresh.cwd).startsWith(join(homeRoot, "repo"))).toBe(true);

    for (const t of [kept, removed, fresh]) {
      const entry = await f.entry(t.worktree!.id);
      expect(entry.status?.detail).toBe("");
      expect(entry.status?.missing).toBe(false);
    }

    expect((await f.remove(removed.worktree!.id)).removed).toBe(true);
    expect(existsSync(removed.cwd)).toBe(false);

    await f.settings({ cleanupUnchanged: true });
    const cleanup = await f.cleanup(false);
    await f.settings({ cleanupUnchanged: false });
    expect(cleanup.entries.find((e) => e.worktree?.id === kept.worktree!.id)?.removed).toBe(true);
    expect(existsSync(kept.cwd)).toBe(false);
  });

  test("the override wins over the home folder; a configured location wins over both", async () => {
    const override = join(dir, "override");
    const roots = withHome(home, () => resolveWorktreeRoots({ dataDir: f.data, override }));
    expect(roots.primary).toBe(realpathSync(override));
    await f.restart(roots);
    const overridden = await f.tree();
    expect(realpathSync(overridden.cwd).startsWith(join(realpathSync(override), "repo"))).toBe(true);

    const location = join(dir, "configured");
    await f.settings({ location });
    const configured = await f.tree();
    await f.settings({ location: undefined });
    expect(configured.cwd.startsWith(join(location, "repo"))).toBe(true);
  });
});

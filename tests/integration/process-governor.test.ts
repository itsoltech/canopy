import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, waitForProcessStopped } from "@canopy/testing";
import {
  ProcessGovernor,
  PROCESS_LIMITS,
  processGovernor,
  runProcess,
  ProcessTimeoutError,
} from "@canopy/process-governor";
import { git as governedGit, freshGit } from "../../apps/worker/src/git/git.ts";
import { git, commit } from "./support/worktrees.ts";

describe("process governor with owned subprocesses", () => {
  test("100 concurrent status requests over 30 linked worktrees use at most four git slots and share reads", async () => {
    const dir = tempDir("canopy-governor-burst-");
    git(dir, "init", "-q", "-b", "main");
    commit(dir);
    const paths = Array.from({ length: 30 }, (_, i) => join(dir, `tree-${i}`));

    for (let i = 0; i < paths.length; i++) git(dir, "worktree", "add", "-q", "-b", `test-${i}`, paths[i]!);
    processGovernor.invalidate();
    const before = processGovernor.snapshot();
    let peak = 0;

    const timer = setInterval(() => {
      peak = Math.max(peak, processGovernor.snapshot().byKind["git"] ?? 0);
    }, 1);

    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => governedGit(paths[i % 30]!, ["status", "--porcelain=v1"])),
      );

      expect(results.every((r) => r.ok && r.stdout === "")).toBe(true);
      expect(peak).toBeLessThanOrEqual(4);
      expect(processGovernor.snapshot().started - before.started).toBe(30);
      expect(processGovernor.snapshot().joined - before.joined).toBe(70);
      await governedGit(paths[0]!, ["status", "--porcelain=v1"]);
      expect(processGovernor.snapshot().started - before.started).toBe(30);
      writeFileSync(join(paths[0]!, "new-file"), "changed");
      expect((await freshGit(() => governedGit(paths[0]!, ["status", "--porcelain=v1"]))).stdout).toContain("new-file");
    } finally {
      clearInterval(timer);
    }
  }, 30_000);

  test("clicks run ahead of a background backlog and stale work is dropped", async () => {
    const governor = new ProcessGovernor({ ...PROCESS_LIMITS, git: 1 }, 1, 1, 8, () => {});
    const gate = Promise.withResolvers<void>();
    const running = governor.run({ kind: "git" }, () => gate.promise);
    const order: string[] = [];

    const background = governor.run({ kind: "git", priority: "background" }, async () => {
      order.push("background");
    });

    const stale = governor.run({ kind: "git", priority: "background", maxQueueMs: 5 }, async () => {
      order.push("stale");
    });

    const expired = expect(stale).rejects.toThrow("stale");
    await expired;

    const click = governor.run({ kind: "git", priority: "user" }, async () => {
      order.push("user");
    });

    gate.resolve();
    await Promise.all([running, background, click]);
    expect(order).toEqual(["user", "background"]);
    expect(governor.snapshot().dropped).toBe(1);
  });

  test("an interactive join promotes the queued read instead of inheriting a stale background deadline", async () => {
    const governor = new ProcessGovernor({ ...PROCESS_LIMITS, git: 1 }, 1, 1, 2, () => {});
    const gate = Promise.withResolvers<void>();
    const running = governor.run({ kind: "git" }, () => gate.promise);
    const first = governor.run({ kind: "git", priority: "background" }, async () => "background");

    const queued = governor.run(
      { kind: "git", priority: "background", key: "status", maxQueueMs: 1 },
      async () => "status",
    );

    const joined = governor.run({ kind: "git", priority: "user", key: "status" }, async () => "duplicate");
    expect(joined).toBe(queued);
    gate.resolve();
    expect(await joined).toBe("status");
    await Promise.all([running, first]);
    expect(governor.snapshot().joined).toBe(1);
  });

  test.skipIf(process.platform === "win32")(
    "a timeout kills an owned descendant that would otherwise survive its parent",
    async () => {
      const dir = tempDir("canopy-governor-tree-");
      const marker = join(dir, "descendant");
      const pidFile = join(dir, "pid");
      const fixture = join(dir, "tree.ts");
      writeFileSync(
        fixture,
        `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => Bun.write(${JSON.stringify(marker)}, "survived"), 1500); setInterval(() => {}, 1000);`)}], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`,
      );
      await expect(
        runProcess({ argv: [process.execPath, fixture], timeoutMs: 500 }, { kind: "probe" }),
      ).rejects.toBeInstanceOf(ProcessTimeoutError);
      const pid = Number(readFileSync(pidFile, "utf8"));

      await waitForProcessStopped(pid);
      expect(existsSync(marker)).toBe(false);
    },
  );
});

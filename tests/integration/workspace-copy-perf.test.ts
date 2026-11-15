import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { copySelectable } from "@canopy/domain/workspace-copy";
import { tempDir } from "@canopy/testing";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceWorker } from "./support/workspace-worker.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";

/**
 * Opt-in throughput measurement (CANOPY_PERF=1): a realistic checkout of thousands of small files, a few large ones
 * and a packed .git, copied between two real workers on one gateway. Prints files/s and MB/s.
 */
describe.skipIf(!dockerAvailable || process.env["CANOPY_PERF"] !== "1")("workspace copy throughput", () => {
  const dir = tempDir("canopy-copy-perf-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  let target: Awaited<ReturnType<typeof workspaceWorker>>;

  beforeAll(async () => {
    f = await worktreeFixture(dir);
    target = await workspaceWorker(f.gw, join(dir, "target"));
    fill(f.repo);
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-qm", "perf fixture");
    git(f.repo, "gc", "-q");
  }, 180_000);

  afterAll(async () => {
    await target?.close();
    await f?.close();
  }, 60_000);

  test(
    "copies thousands of small files and a few large ones",
    async () => {
      const manifest = (await f.gw.api.getWorkspaceCopyManifest({ workspaceId: f.workspace.id })).manifest!;
      const started = performance.now();
      let last: ui.WorkspaceCopyProgress | undefined;

      for await (const event of f.gw.api.copyWorkspace(
        create(ui.CopyWorkspaceRequestSchema, {
          sourceRef: f.workspace.id,
          targetRef: target.workerId,
          projectRef: (await f.gw.api.createProject({ name: "Perf target" })).project!.id,
          manifestToken: manifest.token,
          ignoredSelection: {
            paths: manifest.entries.filter((e) => copySelectable(e) && e.included).map((e) => e.path),
          },
          confirmedSecrets: manifest.entries.filter((e) => e.secret && e.included).map((e) => e.path),
          parentPath: target.dir,
          name: "perf-copy",
          transferKey: Bun.randomUUIDv7(),
        }),
        { timeoutMs: 30 * 60_000 },
      ))
        last = event;

      const seconds = (performance.now() - started) / 1000;
      expect(last?.status).toBe("completed");
      const mb = Number(last!.totalBytes) / 1024 ** 2;
      console.info(
        `workspace copy: ${last!.totalFiles} files, ${mb.toFixed(1)} MB in ${seconds.toFixed(2)} s · ` +
          `${(last!.totalFiles / seconds).toFixed(0)} files/s · ${(mb / seconds).toFixed(1)} MB/s`,
      );
      expect(readFileSync(join(target.dir, "perf-copy", "big", "asset-0.bin")).length).toBe(8 * 1024 ** 2);
    },
    30 * 60_000,
  );
});

/** ~4,000 source-like files of 0.2–30 KB in nested packages, plus three 8 MB assets. */
function fill(repo: string) {
  for (let p = 0; p < 40; p++) {
    for (let d = 0; d < 5; d++) {
      const folder = join(repo, "packages", `pkg-${p}`, "src", `mod-${d}`);
      mkdirSync(folder, { recursive: true });

      for (let i = 0; i < 20; i++) {
        const size = 200 + ((p * 131 + d * 17 + i * 7919) % 30_000);
        writeFileSync(join(folder, `file-${i}.ts`), randomBytes(size).toString("base64").slice(0, size));
      }
    }
  }

  mkdirSync(join(repo, "big"));

  for (let i = 0; i < 3; i++) writeFileSync(join(repo, "big", `asset-${i}.bin`), randomBytes(8 * 1024 ** 2));
}

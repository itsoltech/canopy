import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { copySelectable } from "@canopy/domain/workspace-copy";
import { tempDir } from "@canopy/testing";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { copyWorker } from "./support/copy-workers.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { git } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("background workspace copies over real workers", () => {
  const dir = tempDir("canopy-copy-jobs-");
  let gw: TestGateway;
  let source: Awaited<ReturnType<typeof copyWorker>>;
  let target: Awaited<ReturnType<typeof copyWorker>>;
  let projectId = "";
  let workspaceId = "";
  const repo = join(dir, "source", "repo");

  beforeAll(async () => {
    gw = await startTestGateway();
    source = await copyWorker(gw, join(dir, "source"), "Source");
    target = await copyWorker(gw, join(dir, "target"), "Target");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\nignored.txt\nskipped.txt\n");

    // Enough files for several frames in every lane, plus large files that take many frames.
    for (let p = 0; p < 30; p++) {
      mkdirSync(join(repo, "src", `pkg-${p}`), { recursive: true });

      for (let i = 0; i < 40; i++)
        writeFileSync(join(repo, "src", `pkg-${p}`, `f-${i}.txt`), randomBytes(2_000 + i * 97));
    }

    writeFileSync(join(repo, "large-a.bin"), randomBytes(5 * 1024 ** 2 + 7));
    writeFileSync(join(repo, "large-b.bin"), randomBytes(3 * 1024 ** 2));
    writeFileSync(join(repo, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repo, "run.sh"), 0o755);
    symlinkSync("run.sh", join(repo, "run-link"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fixture");
    writeFileSync(join(repo, ".env"), "SECRET=fixture");
    writeFileSync(join(repo, "ignored.txt"), "opt in");
    writeFileSync(join(repo, "skipped.txt"), "not chosen");
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "dep.js"), "generated");
    writeFileSync(join(repo, "untracked.txt"), "local work");
    projectId = (await gw.api.createProject({ name: "Copy jobs" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: source.workerId, rootPath: repo })).workspace!
      .id;
  }, 120_000);

  afterAll(async () => {
    gw.core.copyJobs.beforeWrite = () => {};

    await source?.close();
    await target?.close();
    await gw?.close();
  }, 60_000);

  async function request(name: string) {
    const manifest = (await gw.api.getWorkspaceCopyManifest({ workspaceId })).manifest!;
    const ignored = manifest.entries.filter((e) => copySelectable(e) && (e.included || e.path === "ignored.txt"));

    return create(ui.CopyWorkspaceRequestSchema, {
      sourceRef: workspaceId,
      targetRef: target.workerId,
      projectRef: (await gw.api.createProject({ name })).project!.id,
      manifestToken: manifest.token,
      ignoredSelection: { paths: ignored.map((e) => e.path) },
      confirmedSecrets: manifest.entries
        .filter((e) => e.secret && !e.directory && (!copySelectable(e) || ignored.includes(e)))
        .map((e) => e.path),
      parentPath: target.dir,
      name,
      targetName: "Target",
      transferKey: Bun.randomUUIDv7(),
    });
  }

  const job = (id: string) => gw.api.listWorkspaceCopyJobs({}).then((r) => r.jobs.find((j) => j.id === id));

  const settled = (id: string, status = "completed") =>
    eventually(
      () => job(id),
      (j) => j?.status === status,
      60_000,
    );

  /** Progress of one job as the overview stream delivers it. */
  function watchProgress(id: string) {
    const controller = new AbortController();
    const updates: ui.WorkspaceCopyProgress[] = [];

    const done = (async () => {
      try {
        for await (const update of gw.api.watchOverview({}, { signal: controller.signal })) {
          const change = update.change;

          if (change.case === "workspaceCopyJob" && change.value.id === id && change.value.progress)
            updates.push(change.value.progress);
        }
      } catch {
        /* Stopped below. */
      }
    })();

    return {
      stop: async () => {
        controller.abort();
        await done;

        return updates;
      },
    };
  }

  /** Holds every frame after the first `frames` until released. */
  function hold(frames: number) {
    let seen = 0;
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    gw.core.copyJobs.beforeWrite = async () => {
      if (++seen <= frames) return;
      reached.resolve();
      await gate.promise;
    };

    return { reached: reached.promise, release: () => gate.resolve(), frames: () => seen };
  }

  function expectCopy(name: string) {
    const path = join(target.dir, name);

    for (const file of ["src/pkg-7/f-3.txt", "large-a.bin", "large-b.bin", "untracked.txt", ".env", "ignored.txt"])
      expect(readFileSync(join(path, file)).equals(readFileSync(join(repo, file)))).toBe(true);
    expect(lstatSync(join(path, "run.sh")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(path, "run-link"))).toBe("run.sh");
    expect(existsSync(join(path, "skipped.txt"))).toBe(false);
    expect(existsSync(join(path, "node_modules"))).toBe(false);
    expect(git(path, "status", "--porcelain")).toBe(git(repo, "status", "--porcelain"));
    expect(readdirSync(target.dir).filter((p) => p.startsWith(".canopy-copy-"))).toEqual([]);
  }

  test("copies in the background in parallel frames: content, modes, symlinks, ignore rules; publishes the workspace", async () => {
    const input = await request("background");
    const started = await gw.api.startWorkspaceCopy(input);
    expect(started.status).not.toBe("failed");
    const done = await settled(input.transferKey);
    expect(done!.progress!.files).toBe(done!.progress!.totalFiles);
    expect(done!.progress!.workspaceRef).not.toBe("");
    expectCopy("background");
    const overview = await gw.api.getOverview({});
    expect(overview.projects.flatMap((p) => p.workspaces).some((w) => w.id === done!.progress!.workspaceRef)).toBe(
      true,
    );
    // The selection is stored as path hashes only.
    const stored = await gw.core.copyJobs.store.get(input.transferKey);
    expect(stored?.secret_hashes.length).toBeGreaterThan(0);
    expect(JSON.stringify({ ...stored, bytes: 0, total_bytes: 0 })).not.toContain(".env");
  }, 90_000);

  test("refuses an unconfirmed secret before creating a job", async () => {
    const input = await request("unconfirmed");
    input.confirmedSecrets = [];
    expect(await failure(gw.api.startWorkspaceCopy(input))).toContain("Confirm the selected files");
    expect(await job(input.transferKey)).toBeUndefined();
    expect(existsSync(join(target.dir, "unconfirmed"))).toBe(false);
  }, 30_000);

  test("resumes after the target and source workers restart mid-copy, without resending staged files", async () => {
    const input = await request("worker-restart");
    const seen = watchProgress(input.transferKey);
    const pause = hold(4);
    await gw.api.startWorkspaceCopy(input);
    await pause.reached;
    const before = (await job(input.transferKey))!.progress!;
    expect(before.files).toBeLessThan(before.totalFiles);
    await target.restart();
    await source.restart();
    let resent = 0;
    gw.core.copyJobs.beforeWrite = () => void resent++;
    pause.release();
    await settled(input.transferKey);
    expectCopy("worker-restart");
    const updates = await seen.stop();
    expect(updates.length).toBeGreaterThan(1);
    // Files count as they are written and verified, long before the copy is published.
    expect(updates.some((u) => u.files > 0 && u.files < u.totalFiles)).toBe(true);

    // Counters never step back while staged files are confirmed again after the restarts.
    for (const [i, update] of updates.entries()) {
      const previous = updates[i - 1] ?? update;
      expect(update.files).toBeGreaterThanOrEqual(previous.files);
      expect(update.bytes).toBeGreaterThanOrEqual(previous.bytes);
    }

    // The frames held at the restart are lost; staged files are confirmed by hash, not sent again.
    expect(resent).toBeGreaterThan(0);
    expect(resent).toBeLessThan(pause.frames() + 40);
  }, 120_000);

  test("resumes after a gateway restart mid-copy", async () => {
    const input = await request("gateway-restart");
    const pause = hold(3);
    await gw.api.startWorkspaceCopy(input);
    await pause.reached;

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    const stopping = gw.close(true);
    pause.release();
    await stopping;
    gw = await startTestGateway({ storage });
    await source.reconnect(gw);
    await target.reconnect(gw);
    expect((await job(input.transferKey))?.status).toBe("copying");
    gw.core.copyJobs.start();
    await settled(input.transferKey);
    expectCopy("gateway-restart");
  }, 120_000);

  test("runs two copies at once and cancels a third without leaving files", async () => {
    const [a, b] = [await request("concurrent-a"), await request("concurrent-b")];
    await Promise.all([gw.api.startWorkspaceCopy(a), gw.api.startWorkspaceCopy(b)]);
    await Promise.all([settled(a.transferKey), settled(b.transferKey)]);
    expectCopy("concurrent-a");
    expectCopy("concurrent-b");

    const c = await request("cancelled");
    const pause = hold(2);
    await gw.api.startWorkspaceCopy(c);
    await pause.reached;
    const cancelling = gw.api.cancelWorkspaceCopyJob({ id: c.transferKey });
    pause.release();
    expect((await cancelling).status).toBe("cancelled");
    expect(existsSync(join(target.dir, "cancelled"))).toBe(false);
    expect(readdirSync(target.dir).filter((p) => p.startsWith(".canopy-copy-"))).toEqual([]);
    await gw.api.dismissWorkspaceCopyJob({ id: c.transferKey });
    expect(await job(c.transferKey)).toBeUndefined();
  }, 120_000);

  test("another owner's job is invisible and cannot be cancelled, retried or dismissed", async () => {
    const foreign = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("copy-jobs-other@fixture", "Other")),
    );

    const id = Bun.randomUUIDv7();
    await gw.runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`
      INSERT INTO workspace_copy_jobs (id, owner_user_id, source_ref, target_ref, project_ref, parent_path, name, status)
      VALUES (${id}::uuid, ${foreign}::uuid, ${workspaceId}, ${target.workerId}, ${projectId}, ${target.dir}, 'foreign', 'failed')`,
      ),
    );
    expect(await job(id)).toBeUndefined();

    // Start each request only when its expected rejection can be handled immediately.
    for (const call of [
      () => gw.api.cancelWorkspaceCopyJob({ id }),
      () => gw.api.retryWorkspaceCopyJob({ id }),
      () => gw.api.dismissWorkspaceCopyJob({ id }),
    ])
      expect(await failure(call())).toContain("not found");
  }, 30_000);
});

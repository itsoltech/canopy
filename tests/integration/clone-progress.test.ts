import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir, waitForProcessStopped } from "@canopy/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { create } from "@bufbuild/protobuf";
import { ui, type CloneProgress } from "@canopy/contracts";
import { CLONE_PROGRESS_CAPABILITY } from "@canopy/domain/release/protocol";
import { processGovernor } from "@canopy/process-governor";
import { startTestGateway, eventually, failure } from "./support/gateway.ts";
import { workspaceWorker } from "./support/workspace-worker.ts";
import { commit, git } from "./support/worktrees.ts";

/** Real WorkerHost -> WorkerLink gRPC -> GatewayService streaming, with bounded fixture Git diagnostics. */
describe.skipIf(!dockerAvailable)("Git clone progress", () => {
  const dir = tempDir("canopy-clone-progress-");
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let worker: Awaited<ReturnType<typeof workspaceWorker>>;
  let old: Awaited<ReturnType<typeof workspaceWorker>>;
  const savedPath = process.env["PATH"];
  const realGit = Bun.which("git")!;
  const remote = join(dir, "remote.git");

  beforeAll(async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    copyFileSync(new URL("./fixtures/clone-git.ts", import.meta.url), join(bin, "git"));
    chmodSync(join(bin, "git"), 0o755);
    process.env["CANOPY_FIXTURE_REAL_GIT"] = realGit;
    process.env["PATH"] = `${bin}:${savedPath}`;
    git(dir, "init", "-q", "--bare", "-b", "main", remote);
    const seed = join(dir, "seed");
    git(dir, "clone", "-q", remote, seed);
    commit(seed);
    git(seed, "push", "-q", "origin", "main");
    gateway = await startTestGateway();
    worker = await workspaceWorker(gateway, join(dir, "worker"), "Clone worker", true, {
      progress: true,
      stallTimeoutMs: 1200,
    });
    old = await workspaceWorker(gateway, join(dir, "old"), "Old worker");
  }, 60_000);

  afterAll(async () => {
    await old?.close();
    await worker?.close();
    await gateway?.close();
    process.env["PATH"] = savedPath;
    delete process.env["CANOPY_FIXTURE_REAL_GIT"];
  }, 30_000);

  const request = (name: string, workerId = worker.workerId, projectId = "") =>
    create(ui.AddProjectRequestSchema, {
      workerId,
      projectId,
      source: { case: "clone", value: { parentPath: dir, name, url: `file://${remote}` } },
    });

  async function collect(input: ui.AddProjectRequest) {
    const progress: CloneProgress[] = [];
    let result: ui.AddProjectResponse | undefined;
    let error = "";

    try {
      for await (const update of gateway.api.cloneProject(input)) {
        if (update.progress) {
          progress.push(update.progress);
        }

        if (update.result) result = update.result;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    return { progress, result, error };
  }

  test("ordered/throttled structured progress, bounded redacted logs and a registered real clone", async () => {
    const sent: number[] = [];
    const send = worker.link.send;
    worker.link.send = (payload) => {
      if (payload.case === "cloneProgress") sent.push(Date.now());
      send(payload);
    };

    const collected = await collect(request("fixture-logged")).finally(() => (worker.link.send = send));
    const { progress, result, error } = collected;
    expect(error).toBe("");
    expect(result?.workspace?.rootPath).toBe(join(dir, "fixture-logged"));
    expect(git(join(dir, "fixture-logged"), "log", "-1", "--format=%s")).toBe("change");
    const frames = progress.filter((p) => p.sequence > 0);
    expect(frames.length).toBeGreaterThan(4);
    expect(frames.length).toBeLessThan(20);
    expect(frames.map((p) => p.sequence)).toEqual(frames.map((_, i) => i + 1));
    expect(
      frames.some(
        (p) =>
          p.phase === "Receiving objects" &&
          p.percent! > 0 &&
          p.bytes === 12.3 * 1024 ** 2 &&
          p.bytesPerSecond === 3.1 * 1024 ** 2 &&
          p.total === 2700,
      ),
    ).toBe(true);
    expect(frames.at(-1)?.phase).toBe("Updating files");

    // Measure at the worker's real outbound link: transport buffering can deliver spaced frames in a burst.
    expect(frames).toHaveLength(sent.length);

    for (let i = 1; i < sent.length; i++) expect(sent[i]! - sent[i - 1]!).toBeGreaterThanOrEqual(240);
    const allLines = frames.flatMap((p) => p.lines);
    expect(frames.every((p) => p.lines.length <= 30 && p.lines.every((l) => l.length <= 500))).toBe(true);
    expect(allLines.some((line) => line.includes("[remote URL]"))).toBe(true);

    for (const secret of [
      "fixture-url-secret",
      "fixture-query-secret",
      "fixture-header-secret",
      "fixture-password",
      "fixture-token",
      "fixtureprovidersecret",
      "fixture-overlong-secret",
      "fixture quoted password",
      "fixture-json-secret",
      "\u001b",
    ])
      expect(allLines.join("\n")).not.toContain(secret);
  }, 15_000);

  test("stall timeout kills Git and its child, removes only its partial directory", async () => {
    const started = Date.now();
    const collecting = collect(request("fixture-stall"));
    const pid = await pidOf("fixture-stall", "git.pid");
    const child = await pidOf("fixture-stall", "child.pid");
    const { error } = await collecting;
    expect(error).toContain("no progress");
    expect(Date.now() - started).toBeLessThan(6000);
    expect(existsSync(join(dir, "fixture-stall"))).toBe(false);
    expect(existsSync(remote)).toBe(true);
    await waitForProcessStopped(pid);
    await waitForProcessStopped(child);
  }, 10_000);

  test("cancelling the stream kills Git, cleans up and never registers a workspace", async () => {
    const abort = new AbortController();

    const collecting = (async () => {
      try {
        for await (const _ of gateway.api.cloneProject(request("fixture-cancel"), { signal: abort.signal })) {
          /* drain */
        }
      } catch {
        /* client cancellation */
      }
    })();

    const pid = await pidOf("fixture-cancel", "git.pid");
    const child = await pidOf("fixture-cancel", "child.pid");
    abort.abort();
    await collecting;
    expect(
      await eventually(
        async () => existsSync(join(dir, "fixture-cancel")),
        (exists) => !exists,
      ),
    ).toBe(false);
    await waitForProcessStopped(pid);
    await waitForProcessStopped(child);
    expect(
      (await gateway.api.getOverview({})).projects
        .flatMap((p) => p.workspaces)
        .some((w) => w.rootPath.endsWith("fixture-cancel")),
    ).toBe(false);
  }, 10_000);

  test("an old worker stays indeterminate and receives no progress/cancel feature", async () => {
    const added = await collect(request("old-clone", old.workerId));
    expect(added.error).toBe("");
    expect(added.result?.workspace?.rootPath).toBe(join(dir, "old-clone"));
    expect(added.progress).toHaveLength(1);
    expect(added.progress[0]?.percent).toBeUndefined();
    const listed = (await gateway.api.getOverview({})).workers;
    expect(listed.find((w) => w.id === old.workerId)?.cloneProgress).toBe(false);
    expect(listed.find((w) => w.id === worker.workerId)?.cloneProgress).toBe(true);
    expect(gateway.core.link.connections.get(old.workerId)?.hello.capabilities).not.toContain(
      CLONE_PROGRESS_CAPABILITY,
    );
  });

  test("cancellation removes a queued clone without waiting for other Git commands", async () => {
    const release = Array.from({ length: 4 }, () => processGovernor.reserve("git"));
    const abort = new AbortController();
    const name = "queued-clone";

    const collecting = (async () => {
      try {
        for await (const _ of gateway.api.cloneProject(request(name), { signal: abort.signal })) {
          /* drain */
        }
      } catch {
        /* client cancellation */
      }
    })();

    try {
      await eventually(async () => existsSync(join(dir, name)), Boolean);
      expect(existsSync(join(dir, name))).toBe(true);
      abort.abort();
      await collecting;
      expect(
        await eventually(
          async () => existsSync(join(dir, name)),
          (exists) => !exists,
          1000,
        ),
      ).toBe(false);
    } finally {
      abort.abort();

      for (const done of release) done();
    }
  });

  test("auth failures retain safe diagnostics before the error, and retry can use the same directory", async () => {
    const failed = await collect(request("fixture-auth"));
    expect(failed.error).toContain("Sign in to Git on Clone worker");
    expect(failed.progress.at(-1)?.lines.join("\n")).toContain("Authentication failed");
    expect(JSON.stringify(failed.progress)).not.toContain("fixture-url-secret");
    expect(JSON.stringify(failed.progress)).not.toContain("fixture-header-secret");
    expect(existsSync(join(dir, "fixture-auth"))).toBe(false);
    process.env["CANOPY_FIXTURE_AUTH_RECOVERED"] = "1";

    try {
      const retried = await collect(request("fixture-auth"));
      expect(retried.error).toBe("");
      expect(retried.result?.workspace?.rootPath).toBe(join(dir, "fixture-auth"));
    } finally {
      delete process.env["CANOPY_FIXTURE_AUTH_RECOVERED"];
    }

    // Refusing an existing directory never removes it.
    const duplicate = await collect(request("fixture-logged"));
    expect(duplicate.error).toContain("already exists");
    expect(existsSync(join(dir, "fixture-logged", ".git"))).toBe(true);
  });

  test("workspace attachment and owner checks share AddProject policy", async () => {
    const project = (await gateway.api.createProject({ name: "Extra workspace" })).project!;
    const added = await collect(request("workspace-clone", worker.workerId, project.id));
    expect(added.result?.project?.id).toBe(project.id);
    expect(added.result?.attached).toBe(true);
    expect((await collect(request("workspace-duplicate", worker.workerId, project.id))).error).toContain(
      "already has a workspace",
    );
    expect(existsSync(join(dir, "workspace-duplicate"))).toBe(false);

    const other = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("clone-other@localhost", "Other")),
    );

    const foreign = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "Foreign", ownerUserId: other })),
    );

    expect((await collect(request("foreign-clone", foreign.workerId))).error).toContain("worker not found");
    expect(existsSync(join(dir, "foreign-clone"))).toBe(false);
    const unsafe = request("unsafe-clone");

    if (unsafe.source.case === "clone") unsafe.source.value.url = "ext::touch unsafe";
    expect((await collect(unsafe)).error).not.toBe("");
    expect(existsSync(join(dir, "unsafe-clone"))).toBe(false);
    expect(
      await failure(
        gateway.api.addProject({
          workerId: worker.workerId,
          source: {
            case: "clone",
            value: { parentPath: dir, name: "bad-url", url: "https://user:secret@example.invalid/repo" },
          },
        }),
      ),
    ).not.toContain("user:secret");
  });

  async function pidOf(name: string, file: string): Promise<number> {
    const path = join(dir, name, file);
    await eventually(async () => existsSync(path), Boolean);

    return Number(readFileSync(path, "utf8"));
  }
});

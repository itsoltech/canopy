import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { GatewayStore } from "@canopy/gateway/store";
import { WorkspaceCopyOperationSchema, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { COPY_CHUNK_BYTES, copyTotals } from "@canopy/domain/workspace-copy";
import { tempDir } from "@canopy/testing";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { workspaceWorker } from "./support/workspace-worker.ts";
import { eventually, failure } from "./support/gateway.ts";
import { git } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("workspace copies over real worker and computer links", () => {
  const dir = tempDir("canopy-workspace-copy-");
  let fixture: Awaited<ReturnType<typeof linkedProjectFixture>>;
  let target: Awaited<ReturnType<typeof workspaceWorker>>;
  let linked: Awaited<ReturnType<typeof workspaceWorker>>;
  let old: Awaited<ReturnType<typeof workspaceWorker>>;
  let remoteId = "";
  const secret = "fixture-local-secret-contents";

  beforeAll(async () => {
    fixture = await linkedProjectFixture(dir, { shared: true });
    target = await workspaceWorker(fixture.a.gw, join(dir, "target"));
    linked = await workspaceWorker(fixture.b.gw, join(dir, "linked"));
    old = await workspaceWorker(fixture.a.gw, join(dir, "old"), "Older worker", false);
    remoteId = `${linked.workerId}~${nodeRef(fixture.lb.hello().nodeId)}`;
    const repo = fixture.a.repo;
    writeFileSync(join(repo, ".gitignore"), ".env*\n*.local\n.npmrc\nnode_modules/\ntarget/\ndist/\nignored.txt\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "copy fixture");
    writeFileSync(join(repo, ".env"), secret);
    writeFileSync(join(repo, ".npmrc"), "fixture npm configuration");
    writeFileSync(join(repo, "settings.local"), "fixture config");
    mkdirSync(join(repo, ".docker"));
    writeFileSync(join(repo, ".docker", "config.json"), secret);
    writeFileSync(join(repo, "ignored.txt"), "opt in");
    writeFileSync(join(repo, "untracked.txt"), "local work");
    writeFileSync(join(repo, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repo, "run.sh"), 0o755);

    for (const name of ["node_modules", "target", "dist"]) {
      mkdirSync(join(repo, name));
      writeFileSync(join(repo, name, "generated"), "skip by default");
    }

    symlinkSync("untracked.txt", join(repo, "local-link"));
    await eventually(
      () => fixture.a.gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === remoteId && w.workspaceCopy),
    );
  }, 90_000);
  afterAll(async () => {
    await old?.close();
    await target?.close();
    await linked?.close();
    await fixture?.close();
  }, 30_000);

  async function plan() {
    return (await fixture.a.gw.api.getWorkspaceCopyManifest({ workspaceId: fixture.a.workspace.id })).manifest!;
  }

  function request(manifest: Awaited<ReturnType<typeof plan>>, name: string, remote = false) {
    return create(ui.CopyWorkspaceRequestSchema, {
      sourceRef: fixture.a.workspace.id,
      targetRef: remote ? remoteId : target.workerId,
      projectRef: fixture.a.project.id,
      manifestToken: manifest.token,
      paths: manifest.entries.filter((e) => e.included).map((e) => e.path),
      confirmedSecrets: manifest.entries.filter((e) => e.secret && e.included).map((e) => e.path),
      parentPath: remote ? linked.dir : target.dir,
      name,
      transferKey: Bun.randomUUIDv7(),
    });
  }

  async function run(input: ui.CopyWorkspaceRequest) {
    const events: ui.WorkspaceCopyProgress[] = [];

    for await (const event of fixture.a.gw.api.copyWorkspace(input)) events.push(event);

    return events;
  }

  test("lists tracked, untracked and ignored entries with defaults and explicit secret confirmation", async () => {
    const manifest = await plan();

    for (const path of ["README.md", "untracked.txt", ".env", ".npmrc", "settings.local"])
      expect(manifest.entries.find((e) => e.path === path)?.included).toBe(true);

    for (const path of ["node_modules/generated", "target/generated", "dist/generated", "ignored.txt"])
      expect(manifest.entries.find((e) => e.path === path)).toMatchObject({ included: false, ignored: true });
    expect(manifest.entries.find((e) => e.path === ".env")?.secret).toBe(true);
    expect(manifest.entries.find((e) => e.path === ".docker/config.json")?.secret).toBe(true);
    const input = request(manifest, "no-confirmation");
    input.confirmedSecrets = [];
    expect(await failure(run(input))).toContain("Confirm the selected files");
    expect(existsSync(join(target.dir, "no-confirmation"))).toBe(false);
  });

  test("copies a real local checkout, local secrets, modes, safe symlinks and an ignored selection; persists only path hashes", async () => {
    const manifest = await plan();
    const input = request(manifest, "local-copy");
    input.paths.push("ignored.txt");
    input.paths = input.paths.filter((p) => p !== "settings.local");
    const events = await run(input);
    const result = events.at(-1)!;
    expect(result.status).toBe("completed");
    expect(result.files).toBe(result.totalFiles);
    expect(result.bytes).toBe(result.totalBytes);
    const path = join(target.dir, "local-copy");
    expect(readFileSync(join(path, ".env"), "utf8")).toBe(secret);
    expect(readFileSync(join(path, "ignored.txt"), "utf8")).toBe("opt in");
    expect(existsSync(join(path, "settings.local"))).toBe(false);
    expect(existsSync(join(path, "node_modules/generated"))).toBe(false);
    expect(lstatSync(join(path, "run.sh")).mode & 0o111).toBe(0o111);
    expect(readlinkSync(join(path, "local-link"))).toBe("untracked.txt");
    expect(git(path, "rev-parse", "HEAD")).toBe(git(fixture.a.repo, "rev-parse", "HEAD"));
    expect(git(path, "branch", "--show-current")).toBe(git(fixture.a.repo, "branch", "--show-current"));
    expect(git(path, "remote", "get-url", "origin")).toBe(git(fixture.a.repo, "remote", "get-url", "origin"));
    expect(events.some((e) => e.currentFile === ".env")).toBe(false);
    const again = await plan();
    expect(again.entries.find((e) => e.path === "ignored.txt")?.included).toBe(true);
    expect(again.entries.find((e) => e.path === "settings.local")?.included).toBe(false);
    const persisted = await fixture.a.sql((sql) => sql`SELECT included, excluded FROM workspace_copy_presets`);
    expect(JSON.stringify(persisted)).not.toContain(".env");
    expect(JSON.stringify(persisted)).not.toContain(secret);
    const audit = await fixture.a.sql((sql) => sql`SELECT details FROM audit_log WHERE target_type='workspace_copy'`);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(".env");
    await fixture.a.gw.api.removeWorkspace({ workspaceId: result.workspaceRef });
  }, 30_000);

  test("copies through linked gateways and publishes the target home's workspace", async () => {
    const events = await run(request(await plan(), "linked-copy", true));
    const result = events.at(-1)!;
    expect(result.workspaceRef).toContain("~");
    expect(readFileSync(join(linked.dir, "linked-copy", ".env"), "utf8")).toBe(secret);
    expect(
      (await fixture.b.gw.api.getOverview({})).projects
        .flatMap((p) => p.workspaces)
        .some((w) => w.id === result.workspaceRef.split("~")[0]),
    ).toBe(true);
    await fixture.a.gw.api.removeWorkspace({ workspaceId: result.workspaceRef });
  }, 30_000);

  test("refuses symlink escapes, another owner's workspace, older workers and existing targets", async () => {
    symlinkSync(dir, join(fixture.a.repo, "escape"));
    const manifest = await plan();
    expect(manifest.entries.find((e) => e.path === "escape")?.blocked).toContain("outside");
    const input = request(manifest, "unsafe-copy");
    input.paths.push("escape");
    expect(await failure(run(input))).toContain("unavailable");
    rmSync(join(fixture.a.repo, "escape"));
    const older = request(await plan(), "old-copy");
    older.targetRef = old.workerId;
    older.parentPath = old.dir;
    expect(await failure(run(older))).toContain("Update this worker to copy files");

    const foreign = await fixture.a.gw.runtime.runPromise(
      GatewayStore.use((asyncStore) => {
        return asyncStore.ensureUser("copy-other@fixture", "Other");
      }),
    );

    const foreignProject = await fixture.a.gw.runtime.runPromise(
      GatewayStore.use((s) => s.createProject(foreign, "Private")),
    );

    const foreignWorker = await fixture.a.gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "Private", ownerUserId: foreign })),
    );

    const foreignWorkspace = await fixture.a.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.createWorkspace({
          projectId: foreignProject.id,
          workerId: foreignWorker.workerId,
          rootPath: fixture.a.repo,
          label: "Private",
        }),
      ),
    );

    expect(await failure(fixture.a.gw.api.getWorkspaceCopyManifest({ workspaceId: foreignWorkspace.id }))).toContain(
      "workspace not found",
    );
    const existing = request(await plan(), "existing");
    mkdirSync(join(target.dir, "existing"));
    writeFileSync(join(target.dir, "existing", "keep"), "not ours");
    expect(await failure(run(existing))).toContain("copy failed");
    expect(readFileSync(join(target.dir, "existing", "keep"), "utf8")).toBe("not ours");
  }, 30_000);

  test("copies a linked source into a local worker and preserves a linked worktree's branch and index", async () => {
    const checkout = join(fixture.b.dir, "linked-checkout");
    git(fixture.b.repo, "worktree", "add", "-qb", "copy/worktree", checkout);
    writeFileSync(join(checkout, "staged.txt"), "staged local work");
    git(checkout, "add", "staged.txt");
    const project = (await fixture.b.gw.api.createProject({ name: "Linked source" })).project!;

    const workspace = (
      await fixture.b.gw.api.createWorkspace({
        projectId: project.id,
        workerId: fixture.b.workerId,
        rootPath: checkout,
      })
    ).workspace!;

    const sourceRef = `${workspace.id}~${nodeRef(fixture.lb.hello().nodeId)}`;
    const manifest = (await fixture.a.gw.api.getWorkspaceCopyManifest({ workspaceId: sourceRef })).manifest!;
    const input = request(manifest, "worktree-copy");
    input.sourceRef = sourceRef;
    const events = await run(input);
    const destination = join(target.dir, "worktree-copy");
    expect(git(destination, "branch", "--show-current")).toBe("copy/worktree");
    expect(git(destination, "diff", "--cached", "--name-only")).toBe("staged.txt");
    expect(lstatSync(join(destination, ".git")).isDirectory()).toBe(true);
    await fixture.a.gw.api.removeWorkspace({ workspaceId: events.at(-1)!.workspaceRef });
  }, 30_000);

  test("source changes fail safely and do not leak secret contents into captured logs", async () => {
    const logs: string[] = [];

    const spies = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args) => {
        logs.push(Bun.inspect(args, { depth: 8, colors: false }));
      }),
    );

    try {
      const copied = await run(request(await plan(), "logged-copy"));
      expect(readFileSync(join(target.dir, "logged-copy", ".env"), "utf8")).toBe(secret);
      await fixture.a.gw.api.removeWorkspace({ workspaceId: copied.at(-1)!.workspaceRef });
      const manifest = await plan();
      writeFileSync(join(fixture.a.repo, "untracked.txt"), "changed after preview");
      expect(await failure(run(request(manifest, "changed-copy")))).toContain("changed");
      expect(logs.join("\n")).not.toContain(secret);
      expect(existsSync(join(target.dir, "changed-copy"))).toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }, 30_000);

  test("cancels without publishing and cleans only transfer-owned directories", async () => {
    const controller = new AbortController();
    const input = request(await plan(), "cancelled-copy");

    try {
      for await (const event of fixture.a.gw.api.copyWorkspace(input, { signal: controller.signal })) {
        if (event.status === "copying") {
          controller.abort();
          break;
        }
      }
    } catch {
      /* Connect cancellation can win before the iterator closes. */
    }

    await eventually(
      async () => existsSync(join(target.dir, "cancelled-copy")),
      (exists) => !exists,
    );
    expect(readdirSync(target.dir).filter((p) => p.startsWith(".canopy-copy-"))).toEqual([]);
    expect(existsSync(join(target.dir, "existing", "keep"))).toBe(true);
  }, 30_000);

  test("rejects per-file and total size limits before writing any destination", async () => {
    const paths = ["limit-a.bin", "limit-b.bin", "limit-c.bin"].map((name) => join(fixture.a.repo, name));

    try {
      writeFileSync(paths[0]!, "");
      truncateSync(paths[0]!, 8 * 1024 ** 3 + 1);
      expect(await failure(run(request(await plan(), "file-limit")))).toContain("8 GB per file");

      for (const path of paths) {
        writeFileSync(path, "");
        truncateSync(path, 7 * 1024 ** 3);
      }

      expect(await failure(run(request(await plan(), "total-limit")))).toContain("20 GB");
      expect(existsSync(join(target.dir, "file-limit"))).toBe(false);
      expect(existsSync(join(target.dir, "total-limit"))).toBe(false);
    } finally {
      for (const path of paths) rmSync(path, { force: true });
    }
  }, 30_000);

  test("chunks a large file, verifies hashes and refuses a corrupt final chunk", async () => {
    const large = Buffer.alloc(COPY_CHUNK_BYTES * 18 + 19, 0x5a);
    writeFileSync(join(fixture.a.repo, "large.bin"), large);
    const manifest = await plan();
    const events = await run(request(manifest, "large-copy"));
    expect(events.filter((e) => e.currentFile === "large.bin").length).toBeGreaterThan(18);
    expect(readFileSync(join(target.dir, "large-copy", "large.bin")).equals(large)).toBe(true);
    await fixture.a.gw.api.removeWorkspace({ workspaceId: events.at(-1)!.workspaceRef });

    const entry = manifest.entries.find((e) => e.path === "untracked.txt")!;
    const metadata = manifest.entries.filter((e) => e.metadata);
    const token = Bun.randomUUIDv7();

    const command = (operation: MessageInitShape<typeof WorkspaceCopyOperationSchema>) =>
      fixture.a.gw.api.workspaceCopyTarget({
        projectId: fixture.a.project.id,
        workerId: target.workerId,
        sourceRef: fixture.a.workspace.id,
        operation,
      });

    await command({
      action: {
        case: "prepare",
        value: {
          token,
          parentPath: target.dir,
          name: "corrupt-copy",
          entries: [...metadata, entry],
          bytes: copyTotals([...metadata, entry]).bytes,
        },
      },
    });

    const corrupt = command({
      action: {
        case: "write",
        value: {
          token,
          path: entry.path,
          offset: 0n,
          data: readFileSync(join(fixture.a.repo, entry.path)),
          last: true,
          sha256: "0".repeat(64),
        },
      },
    });

    expect(await failure(corrupt)).toContain("integrity");
    await command({ action: { case: "cancel", value: token } });
    expect(existsSync(join(target.dir, "corrupt-copy"))).toBe(false);
  }, 30_000);
});

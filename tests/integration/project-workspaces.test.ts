import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { GatewayStore } from "@canopy/gateway/store";
import { Provider } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { eventually, failure } from "./support/gateway.ts";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { workspaceWorker } from "./support/workspace-worker.ts";
import { git } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("project workspaces on other workers", () => {
  const dir = tempDir("canopy-project-workspaces-");
  let fixture: Awaited<ReturnType<typeof linkedProjectFixture>>;
  let local: Awaited<ReturnType<typeof workspaceWorker>>;
  let remote: Awaited<ReturnType<typeof workspaceWorker>>;
  let remoteId = "";

  beforeAll(async () => {
    fixture = await linkedProjectFixture(dir, { shared: true });
    local = await workspaceWorker(fixture.a.gw, join(dir, "local"));
    remote = await workspaceWorker(fixture.b.gw, join(dir, "remote"), "Linked studio");
    remoteId = `${remote.workerId}~${nodeRef(fixture.lb.hello().nodeId)}`;
    await eventually(
      () => fixture.a.gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === remoteId && w.online && w.homeDirectory === remote.dir),
    );
  }, 90_000);
  afterAll(async () => {
    await local?.close();
    await remote?.close();
    await fixture?.close();
  }, 30_000);

  test("reads an editable origin URL only for an owned workspace, without unsafe origins", async () => {
    const { a, b, lb } = fixture;
    expect((await a.gw.api.getWorkspaceCloneSource({ workspaceId: a.workspace.id })).cloneUrl).toBe(
      "git@GitHub.com:itsoltech/pinpoint.git",
    );
    expect(
      (await a.gw.api.getWorkspaceCloneSource({ workspaceId: `${b.workspace.id}~${nodeRef(lb.hello().nodeId)}` }))
        .cloneUrl,
    ).toBe("https://github.com/itsoltech/pinpoint/");
    const folder = join(local.dir, "unsafe");
    git(local.dir, "init", "-q", folder);
    git(folder, "remote", "add", "origin", "https://user:fixture-password@example.invalid/private.git");
    const project = (await a.gw.api.createProject({ name: "Unsafe origin" })).project!;

    const workspace = (
      await a.gw.api.createWorkspace({ projectId: project.id, workerId: local.workerId, rootPath: folder })
    ).workspace!;

    expect((await a.gw.api.getWorkspaceCloneSource({ workspaceId: workspace.id })).cloneUrl).toBe("");
    expect(await failure(a.gw.api.getWorkspaceCloneSource({ workspaceId: Bun.randomUUIDv7() }))).toContain(
      "workspace not found",
    );
  });

  test("clones onto a second local worker, attaches to the chosen project, and runs a new thread", async () => {
    const { a } = fixture;

    const response = await a.gw.api.addProject({
      projectId: a.project.id,
      workerId: local.workerId,
      source: { case: "clone", value: { parentPath: local.dir, name: "project", url: `file://${a.origin}` } },
    });

    expect(response.attached).toBe(true);
    expect(response.project?.id).toBe(a.project.id);
    expect(response.workspace).toMatchObject({
      projectId: a.project.id,
      workerId: local.workerId,
      rootPath: join(realpathSync(local.dir), "project"),
    });
    expect(git(response.workspace!.rootPath, "rev-parse", "HEAD")).toBe(git(a.repo, "rev-parse", "HEAD"));

    const thread = (
      await a.gw.api.createThread({
        projectId: a.project.id,
        workspaceId: response.workspace!.id,
        provider: Provider.CODEX,
      })
    ).thread!;

    expect(thread.workerId).toBe(local.workerId);
    expect(thread.cwd).toBe(response.workspace!.rootPath);
    expect(
      await failure(
        a.gw.api.addProject({
          projectId: a.project.id,
          workerId: local.workerId,
          source: { case: "clone", value: { parentPath: local.dir, name: "duplicate", url: `file://${a.origin}` } },
        }),
      ),
    ).toContain("already has a workspace");
    expect(existsSync(join(local.dir, "duplicate"))).toBe(false);
  }, 30_000);

  test("routes a shared project to a linked worker's own project and supports path edits and removal", async () => {
    const { a, b } = fixture;

    const response = await a.gw.api.addProject({
      projectId: a.project.id,
      workerId: remoteId,
      source: { case: "clone", value: { parentPath: remote.dir, name: "project", url: `file://${a.origin}` } },
    });

    const workspace = response.workspace!;
    expect(workspace.workerId).toBe(remoteId);
    expect(workspace.projectId).toBe(a.project.id);
    expect(
      (await b.gw.core.overview()).projects
        .find((p) => p.id === b.project.id)
        ?.workspaces.some((w) => w.id === workspace.id.split("~")[0]),
    ).toBe(true);

    const thread = (
      await a.gw.api.createThread({ projectId: a.project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!;

    expect(thread.workerId).toBe(remoteId);
    const path = join(remote.dir, "existing");
    mkdirSync(path);
    expect((await a.gw.api.updateWorkspace({ workspaceId: workspace.id, rootPath: path })).workspace?.rootPath).toBe(
      realpathSync(path),
    );
    await a.gw.api.removeWorkspace({ workspaceId: workspace.id });

    const existing = await a.gw.api.addProject({
      projectId: a.project.id,
      workerId: remoteId,
      source: { case: "directoryPath", value: path },
    });

    expect(existing.workspace?.rootPath).toBe(realpathSync(path));
    expect((await a.gw.api.getThread({ threadId: thread.id })).thread?.cwd).toBe(workspace.rootPath);
  }, 30_000);

  test("refuses another owner's project, workspace or worker before cloning", async () => {
    const { a } = fixture;

    const foreign = await a.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("workspace-other@localhost", "Other")),
    );

    const project = await a.gw.runtime.runPromise(GatewayStore.use((s) => s.createProject(foreign, "Private")));

    const worker = await a.gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ ownerUserId: foreign, name: "Private" })),
    );

    const workspace = await a.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.createWorkspace({ projectId: project.id, workerId: worker.workerId, rootPath: "/private", label: "Private" }),
      ),
    );

    const clone = {
      case: "clone" as const,
      value: { parentPath: local.dir, name: "refused", url: `file://${a.origin}` },
    };

    expect(
      await failure(a.gw.api.addProject({ projectId: project.id, workerId: local.workerId, source: clone })),
    ).toContain("project not found");
    expect(
      await failure(
        a.gw.api.addProject({
          projectId: (await a.gw.api.createProject({ name: "Owned" })).project!.id,
          workerId: worker.workerId,
          source: clone,
        }),
      ),
    ).toContain("worker not found");
    expect(await failure(a.gw.api.getWorkspaceCloneSource({ workspaceId: workspace.id }))).toContain(
      "workspace not found",
    );
    expect(existsSync(join(local.dir, "refused"))).toBe(false);
  });

  test("cleans a failed clone and refuses traversal, symlinks, credentials and executable protocols", async () => {
    const { a } = fixture;
    const projectId = (await a.gw.api.createProject({ name: "Safety" })).project!.id;

    const clone = (name: string, url = `file://${a.origin}`, parentPath = local.dir) =>
      failure(
        a.gw.api.addProject({
          projectId,
          workerId: local.workerId,
          source: { case: "clone", value: { parentPath, name, url } },
        }),
      );

    expect(await clone("failed", `file://${local.dir}/missing.git`)).toContain("Could not clone");
    expect(existsSync(join(local.dir, "failed"))).toBe(false);
    symlinkSync(dir, join(local.dir, "symlink"));
    expect(await clone("symlink")).toContain("already exists");
    expect(await clone("../escaped")).toContain("without slashes");
    expect(await clone("..")).toContain("without slashes");
    expect(await clone("relative", undefined, "relative")).toContain("absolute");
    expect(await clone("credentials", "https://user:fixture-password@example.invalid/repo.git")).toContain(
      "credentials",
    );
    expect(await clone("query", "https://example.invalid/repo.git?token=fixture-password")).toContain("credentials");
    expect(await clone("scp-query", "git@example.invalid:repo.git?token=fixture-password")).toContain("Git URL");
    expect(await clone("ext", "ext::touch% /ignored")).toContain("Git URL");
    expect(existsSync(join(dir, "escaped"))).toBe(false);
    expect(existsSync(join(local.dir, "credentials"))).toBe(false);
  });

  test("explains authentication failures on the target worker and removes the partial clone", async () => {
    const { a } = fixture;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("Sign in", { status: 401, headers: { "WWW-Authenticate": "Basic realm=Git" } }),
    });

    const projectId = (await a.gw.api.createProject({ name: "Private clone" })).project!.id;

    try {
      expect(
        await failure(
          a.gw.api.addProject({
            projectId,
            workerId: local.workerId,
            source: {
              case: "clone",
              value: { parentPath: local.dir, name: "private-clone", url: `http://127.0.0.1:${server.port}/repo.git` },
            },
          }),
        ),
      ).toContain("Sign in to Git on Second worker (SSH key or credential helper), then retry.");
      expect(existsSync(join(local.dir, "private-clone"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { failure } from "./support/gateway.ts";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { commit, git } from "./support/worktrees.ts";

/** Adding projects on a linked computer's worker: listing, folders, clones, git init, origin attach, refusals. */
describe.skipIf(!dockerAvailable)("add projects on a linked computer", () => {
  const dir = tempDir("canopy-add-project-");
  let fixture: Awaited<ReturnType<typeof linkedProjectFixture>>;
  let remoteWorker = "";
  let node = "";

  beforeAll(async () => {
    fixture = await linkedProjectFixture(dir);
    node = fixture.lb.hello().nodeId;
    remoteWorker = `${fixture.b.workerId}~${nodeRef(node)}`;
  }, 90_000);
  afterAll(async () => {
    await fixture?.close();
  }, 30_000);

  const homeProject = async (id: string) =>
    (await fixture.b.gw.api.getOverview({})).projects.find((project) => project.id === id.split("~")[0]);

  test("lists directories on the other computer's worker", async () => {
    const listed = await fixture.a.gw.api.listDirectory({ workerId: remoteWorker, path: fixture.b.dir });
    expect(listed.path).toBe(realpathSync(fixture.b.dir));
    expect(listed.entries.find((entry) => entry.name === "repo")).toMatchObject({ isDir: true, isGitRepo: true });
  });

  test("resolves directory spelling on a linked worker and adds the real path", async () => {
    const path = join(fixture.b.dir, "CASE", "Project");
    mkdirSync(path, { recursive: true });
    const typed = join(fixture.b.dir, "case", "project");

    expect(await fixture.a.gw.api.listDirectory({ workerId: remoteWorker, path: typed })).toMatchObject({
      path: realpathSync(path),
    });

    const added = await fixture.a.gw.api.addProject({
      workerId: remoteWorker,
      source: { case: "directoryPath", value: typed },
    });

    expect(added.workspace?.rootPath).toBe(realpathSync(path));
    expect(
      await failure(fixture.a.gw.api.listDirectory({ workerId: remoteWorker, path: join(path, "missing") })),
    ).toContain("No such directory");
  });

  test("a local folder there becomes a project at its home, with the right workspace", async () => {
    const folder = join(fixture.b.dir, "Notes with a rather long folder name");
    mkdirSync(folder);

    const added = await fixture.a.gw.api.addProject({
      workerId: remoteWorker,
      source: { case: "directoryPath", value: folder },
    });

    expect(added.attached).toBe(false);
    expect(added.project?.nodeId).toBe(node);
    expect(added.project?.name).toBe("Notes with a rather long folder name");
    expect(added.workspace).toMatchObject({ workerId: remoteWorker, rootPath: realpathSync(folder), gitOrigin: "" });
    expect((await homeProject(added.project!.id))?.workspaces.map((w) => w.rootPath)).toEqual([realpathSync(folder)]);
    expect((await fixture.a.gw.core.overview()).projects.some((p) => p.name === added.project?.name)).toBe(false);

    expect(
      await failure(
        fixture.a.gw.api.addProject({ workerId: remoteWorker, source: { case: "directoryPath", value: folder } }),
      ),
    ).toContain("already in “Notes");
  });

  test("clones from a remote into a new folder there, never with credentials in the URL", async () => {
    const remote = join(dir, "served.git");
    const seed = join(dir, "seed");
    git(dir, "init", "-q", "--bare", "-b", "main", remote);
    git(dir, "clone", "-q", remote, seed);
    commit(seed, "README.md", "served");
    git(seed, "push", "-q", "origin", "main");

    const added = await fixture.a.gw.api.addProject({
      workerId: remoteWorker,
      source: { case: "clone", value: { parentPath: fixture.b.dir, name: "served-copy", url: `file://${remote}` } },
    });

    const path = join(realpathSync(fixture.b.dir), "served-copy");
    expect(added.workspace?.rootPath).toBe(path);
    expect(added.project).toMatchObject({ name: "served-copy", nodeId: node });
    expect(git(path, "log", "-1", "--format=%s")).toBe("change");

    const secret = "ghp_never-in-a-message";

    const refused = await failure(
      fixture.a.gw.api.addProject({
        workerId: remoteWorker,
        source: {
          case: "clone",
          value: { parentPath: fixture.b.dir, name: "leak", url: `https://user:${secret}@example.invalid/x.git` },
        },
      }),
    );

    expect(refused).toContain("credentials");
    expect(refused).not.toContain(secret);
    expect(existsSync(join(fixture.b.dir, "leak"))).toBe(false);

    const missing = await failure(
      fixture.a.gw.api.addProject({
        workerId: remoteWorker,
        source: { case: "clone", value: { parentPath: fixture.b.dir, name: "gone", url: `file://${dir}/none.git` } },
      }),
    );

    expect(missing).not.toBe("");
    expect(existsSync(join(fixture.b.dir, "gone"))).toBe(false);
  }, 30_000);

  test("creates a new project folder with git init", async () => {
    const added = await fixture.a.gw.api.addProject({
      workerId: remoteWorker,
      source: { case: "init", value: { parentPath: fixture.b.dir, name: "fresh-start" } },
    });

    const path = join(realpathSync(fixture.b.dir), "fresh-start");
    expect(added.workspace?.rootPath).toBe(path);
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect((await homeProject(added.project!.id))?.name).toBe("fresh-start");
  });

  test("a folder with a known origin joins that project instead of duplicating it", async () => {
    const checkout = join(fixture.b.dir, "second-checkout");
    git(fixture.b.dir, "clone", "-q", fixture.b.origin, checkout);
    git(checkout, "remote", "set-url", "origin", "git@github.com:itsoltech/pinpoint.git");

    const added = await fixture.a.gw.api.addProject({
      workerId: remoteWorker,
      source: { case: "directoryPath", value: checkout },
    });

    expect(added.attached).toBe(true);
    expect(added.project?.id).toBe(`${fixture.b.project.id}~${nodeRef(node)}`);
    expect(added.workspace?.gitOrigin).toBe("github.com/itsoltech/pinpoint");
    expect((await homeProject(added.project!.id))?.workspaces).toHaveLength(2);
  });

  test("refuses paths outside what the worker allows and writes nothing", async () => {
    symlinkSync(dir, join(fixture.b.dir, "outside-link"));

    const init = (parentPath: string, name: string) =>
      failure(
        fixture.a.gw.api.addProject({ workerId: remoteWorker, source: { case: "init", value: { parentPath, name } } }),
      );

    expect(await init("relative/parent", "x")).toContain("absolute");
    expect(await init(fixture.b.dir, "../escaped")).toContain("without slashes");
    expect(await init(fixture.b.dir, "..")).toContain("without slashes");
    expect(await init(fixture.b.dir, "outside-link")).toContain("already exists");
    expect(await init(fixture.b.dir, "repo")).toContain("already exists");
    expect(await init(join(fixture.b.dir, "missing"), "x")).toContain("does not exist");
    expect(existsSync(join(dir, "escaped"))).toBe(false);
    expect(
      await failure(
        fixture.a.gw.api.addProject({ workerId: remoteWorker, source: { case: "directoryPath", value: "relative" } }),
      ),
    ).toContain("absolute");
  });

  test("only the owner's workers, and nothing is queued for an offline worker", async () => {
    const { b, a } = fixture;
    const otherUser = await b.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));

    const foreign = await b.gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "Someone else's", ownerUserId: otherUser })),
    );

    const add = (workerId: string) =>
      failure(
        a.gw.api.addProject({ workerId, source: { case: "init", value: { parentPath: b.dir, name: "foreign" } } }),
      );

    expect(await add(`${foreign.workerId}~${nodeRef(node)}`)).toContain("worker not found");
    expect(await add(b.workerId)).toContain("worker not found");
    b.disconnect();

    try {
      expect(await add(remoteWorker)).toContain("offline");
    } finally {
      await b.connect();
    }

    expect(existsSync(join(b.dir, "foreign"))).toBe(false);
  }, 20_000);
});

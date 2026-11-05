import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { projectChoices } from "@canopy/domain/projects";
import { tempDir } from "@canopy/testing";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GatewayStore } from "@canopy/gateway/store";
import { eventually, failure } from "./support/gateway.ts";
import { linkedProjectFixture } from "./support/linked-projects.ts";

describe.skipIf(!dockerAvailable)("linked projects by Git origin", () => {
  const dir = tempDir("canopy-linked-projects-");
  let fixture: Awaited<ReturnType<typeof linkedProjectFixture>>;
  beforeAll(async () => {
    fixture = await linkedProjectFixture(dir);
  }, 90_000);
  afterAll(async () => {
    await fixture?.close();
  }, 30_000);

  test("two differently named projects merge and the selected workspace creates only at its home", async () => {
    const { a, b, lb } = fixture;
    const overview = await a.gw.api.getOverview({});
    const choices = projectChoices(overview.projects);
    const project = choices.find((choice) => choice.projectIds.includes(a.project.id))!;
    expect(project.name).toBe("Pinpoint");
    expect(project.aliases).toEqual(["Pinpoint on the studio computer with a long project name"]);
    expect(project.workspaces.map((workspace) => workspace.gitOrigin)).toEqual([
      "github.com/itsoltech/pinpoint",
      "github.com/itsoltech/pinpoint",
    ]);
    expect(choices.filter((choice) => choice.kind === "scratch")).toHaveLength(1);

    const remote = project.workspaces.find((workspace) =>
      workspace.workerId.endsWith(`~${nodeRef(lb.hello().nodeId)}`),
    )!;

    expect(remote.projectId).toBe(`${b.project.id}~${nodeRef(lb.hello().nodeId)}`);

    const created = (
      await a.gw.api.createThread({
        projectId: remote.projectId,
        workspaceId: remote.id,
        provider: Provider.CODEX,
        title: "Remote origin choice",
      })
    ).thread!;

    expect(created.nodeId).toBe(lb.hello().nodeId);
    const localId = created.id.split("~")[0]!;
    expect((await b.gw.api.getThread({ threadId: localId })).thread?.projectId).toBe(b.project.id);
    expect(await failure(a.gw.core.getThread(localId))).toContain("not found");
    expect(
      await failure(
        a.gw.api.createThread({ projectId: a.project.id, workspaceId: remote.id, provider: Provider.CODEX }),
      ),
    ).toContain("same computer");
  }, 20_000);

  test("known origin stays available while its worker is offline", async () => {
    const { a, b } = fixture;
    b.disconnect();
    const overview = await b.gw.api.getOverview({});
    const workspace = overview.projects.find((project) => project.id === b.project.id)?.workspaces[0];
    expect(workspace?.gitOrigin).toBe("github.com/itsoltech/pinpoint");
    await b.connect();
    expect((await a.gw.api.getOverview({})).projects.some((project) => project.nodeId)).toBe(true);
  });

  test("metadata is owner-scoped and changing workspace path clears the old origin", async () => {
    const { a } = fixture;

    const original = (await a.gw.api.getOverview({})).projects.find((project) => project.id === a.project.id)!
      .workspaces[0]!;

    await a.gw.runtime.runPromise(
      GatewayStore.use((store) =>
        store.setWorkspaceOrigin(crypto.randomUUID(), original, "unrelated.example/other/project"),
      ),
    );
    expect(
      (await a.gw.api.getOverview({})).projects.find((project) => project.id === a.project.id)?.workspaces[0]
        ?.gitOrigin,
    ).toBe("github.com/itsoltech/pinpoint");
    const noGit = join(a.dir, "without-git");
    mkdirSync(noGit);
    await a.gw.api.updateWorkspace({ workspaceId: original.id, rootPath: noGit });
    const overview = await a.gw.api.getOverview({});
    expect(overview.projects.find((project) => project.id === a.project.id)?.workspaces[0]?.gitOrigin).toBe("");
    expect(projectChoices(overview.projects).find((project) => project.id === a.project.id)?.projectIds).toEqual([
      a.project.id,
    ]);
    await a.gw.api.updateWorkspace({ workspaceId: original.id, rootPath: original.rootPath });
  });

  test("a shut down home keeps its merged identity but refuses creation without queueing", async () => {
    const { a, b, la, lb } = fixture;
    const node = lb.hello().nodeId;
    await eventually(
      () => la.mirror.overview(node),
      (overview) => overview.projects.some((project) => project.workspaces.some((workspace) => workspace.gitOrigin)),
      10_000,
    );
    await lb.close();
    await eventually(
      async () => la.reachable().includes(node),
      (reachable) => !reachable,
    );
    const overview = await a.gw.api.getOverview({});
    const project = projectChoices(overview.projects).find((choice) => choice.projectIds.includes(a.project.id))!;
    expect(project.projectIds).toHaveLength(2);
    const remote = project.workspaces.find((workspace) => workspace.workerId.includes("~"))!;
    const before = (await b.gw.api.listThreads({})).threads.length;
    const start = Date.now();
    expect(
      await failure(
        a.gw.api.createThread({ projectId: remote.projectId, workspaceId: remote.id, provider: Provider.CODEX }),
      ),
    ).toContain("shut down");
    expect(Date.now() - start).toBeLessThan(1_500);
    expect((await b.gw.api.listThreads({})).threads).toHaveLength(before);
  }, 20_000);
});

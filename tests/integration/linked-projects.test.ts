import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { projectChoices } from "@canopy/domain/projects";
import {
  replaceComputerProjects,
  replaceComputerRows,
  retainProjects,
  retainLinkedRows,
  upsertLinkedRows,
} from "@canopy/domain/linked-snapshot";
import { tempDir } from "@canopy/testing";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GatewayStore } from "@canopy/gateway/store";
import { eventually, failure } from "./support/gateway.ts";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { defaultProject, defaultWorkspace } from "../../apps/mobile/src/features/new-thread/placement.ts";

describe.skipIf(!dockerAvailable)("linked projects by Git origin", () => {
  const dir = tempDir("canopy-linked-projects-");
  let fixture: Awaited<ReturnType<typeof linkedProjectFixture>>;
  beforeAll(async () => {
    fixture = await linkedProjectFixture(dir);
  }, 90_000);
  afterAll(async () => {
    await fixture?.close();
  }, 30_000);

  test("phone reconnects reconcile aggregate snapshots, peer snapshots and legacy upserts by identity", async () => {
    const { a, b, lb } = fixture;
    const initial = await a.gw.api.getOverview({});
    let projects = initial.projects;
    let workers = initial.workers;
    expect(projects.filter((project) => project.kind === "scratch")).toHaveLength(2);

    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const stop = new AbortController();
      let aggregate = false;
      let peer = false;
      let legacy = false;

      try {
        for await (const update of a.gw.api.watchOverview(
          { includeSnapshot: true },
          { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]) },
        )) {
          const change = update.change;

          if (change.case === "mobileSnapshot") {
            const overview = change.value.overview!;
            projects = retainProjects(projects, overview.projects, overview.computers);
            workers = retainLinkedRows(workers, overview.workers, overview.computers);
            aggregate = true;
          }

          if (change.case === "computerSnapshot") {
            projects = replaceComputerProjects(projects, change.value.overview?.projects ?? [], change.value.nodeId);
            workers = replaceComputerRows(workers, change.value.overview?.workers ?? [], change.value.nodeId);
            peer = true;
          }

          if (change.case === "project") {
            projects = upsertLinkedRows(projects, [change.value]);
            legacy ||= change.value.nodeId === lb.hello().nodeId;
          }

          if (change.case === "worker") workers = upsertLinkedRows(workers, [change.value]);
          expect(new Set(projects.map((project) => project.id)).size).toBe(projects.length);
          expect(new Set(workers.map((worker) => worker.id)).size).toBe(workers.length);

          if (aggregate && peer && legacy) break;
        }
      } finally {
        stop.abort();
      }

      expect(aggregate && peer && legacy).toBe(true);
      const choices = projectChoices(projects);
      expect(choices).toHaveLength(2);
      expect(choices.filter((project) => project.kind === "scratch")).toHaveLength(1);

      const remote = choices
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.projectId.startsWith(b.project.id))!;

      const recent = [create(ui.ThreadSchema, { projectId: remote.projectId, workspaceId: remote.id })];
      const selected = defaultProject(choices, recent, "")!;
      expect(selected.projectIds).toContain(a.project.id);
      expect(defaultWorkspace(selected, recent, "", () => true)?.id).toBe(remote.id);
    }
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
    ).toContain("is offline since");
    expect(Date.now() - start).toBeLessThan(1_500);
    expect((await b.gw.api.listThreads({})).threads).toHaveLength(before);
  }, 20_000);
});

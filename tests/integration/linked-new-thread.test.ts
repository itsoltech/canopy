import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

describe.skipIf(!dockerAvailable)("new thread on a shared project that lives only on a linked computer", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let projectB: ui.Project;
  let workspaceB: ui.Workspace;
  beforeAll(async () => {
    a = await configComputer("Laptop A");
    b = await configComputer("Studio B");
    projectB = (await b.gateway.api.createProject({ name: "wrk-ai" })).project!;

    workspaceB = (
      await b.gateway.api.createWorkspace({
        projectId: projectB.id,
        workerId: b.gateway.workerId,
        rootPath: "/repo/wrk-ai",
        label: "wrk-ai",
      })
    ).workspace!;

    await pairConfig(a, b);
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));
  }, 90_000);
  afterAll(async () => {
    await a?.close();
    await b?.close();
  }, 30_000);

  const remoteId = () => `${workspaceB.id}~${nodeRef(b.node)}`;

  const sharedOnA = async () =>
    (await a.gateway.api.getOverview({})).projects.find(
      (p) => p.kind !== "scratch" && !p.nodeId && p.workspaces.some((w) => w.id === remoteId()),
    );

  test("A's overview stream keeps B's workspace on the shared project after A republishes it", async () => {
    await wait(async () => Boolean(await sharedOnA()));
    const project = (await sharedOnA())!;
    const remote = project.workspaces.find((w) => w.id === remoteId())!;
    // The picker lists the workers the project's workspaces name: B's worker is in A's overview and online.
    expect((await a.gateway.api.getOverview({})).workers.find((w) => w.id === remote.workerId)?.online).toBe(true);

    const controller = new AbortController();
    const updates: ui.Project[] = [];

    const watching = (async () => {
      try {
        for await (const update of a.gateway.api.watchOverview({}, { signal: controller.signal }))
          if (update.change.case === "project" && update.change.value.id === project.id)
            updates.push(update.change.value);
      } catch {
        /* aborted */
      }
    })();

    try {
      await Bun.sleep(300);
      // Renaming on A republishes A's own row of the shared project to every overview stream.
      await a.gateway.api.renameProject({ projectId: project.id, name: "wrk-ai renamed" });
      await wait(() => updates.some((p) => p.name === "wrk-ai renamed"));
      await Bun.sleep(500);
      const last = updates.at(-1)!;
      expect(last.workspaces.map((w) => w.id)).toContain(remoteId());
      expect(updates.filter((p) => !p.workspaces.some((w) => w.id === remoteId()))).toEqual([]);
    } finally {
      controller.abort();
      await watching;
    }
  }, 30_000);

  test("creating a thread from A on B's worker lives on B", async () => {
    const project = (await sharedOnA())!;

    const created = (
      await a.gateway.api.createThread({
        projectId: project.id,
        workspaceId: remoteId(),
        title: "Remote new thread",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    expect(created.nodeId).toBe(b.node);
    const local = (await b.gateway.api.getThread({ threadId: created.id.split("~")[0]! })).thread;
    expect(local?.projectId).toBe(projectB.id);
  }, 30_000);
});

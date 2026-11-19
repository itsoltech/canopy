import { expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentTool, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, Invalid } from "@canopy/gateway/store";
import { Effect } from "effect";
import { failure, startTestGateway } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "worker status bursts skip project reads, refresh changed origins and retain scratch placement updates",
  async () => {
    const gateway = await startTestGateway({ worker: { hello: { capabilities: ["workspace_origin"] } } });
    const abort = new AbortController();
    const updates = gateway.api.watchOverview({}, { signal: abort.signal, timeoutMs: 30_000 })[Symbol.asyncIterator]();
    const store = await gateway.runtime.runPromise(GatewayStore);
    const lists = spyOn(store, "listProjects");
    let origin = "example.org/team/old";
    gateway.worker.handlers.set("readWorkspaceOrigin", (_value, reply) => reply(true, { workspaceOrigin: origin }));

    async function next() {
      const frame = await updates.next();

      if (frame.done) throw new Error("Overview ended before the expected worker update");

      return frame.value.change;
    }

    // The gateway handles messages from this WorkerLink in order. Its catalog update follows
    // every worker status and any resulting project broadcasts on the same overview stream.
    async function throughCatalog(id: string) {
      gateway.worker.link.send({
        case: "modelCatalog",
        value: {
          configVersion: gateway.worker.configs.at(-1)!.version,
          profiles: [{ provider: Provider.CODEX, profileId: "native", models: [{ id }] }],
        },
      });
      const projects: ui.Project[] = [];
      const routes: string[] = [];
      const workers = new Set<string>();

      for (;;) {
        const change = await next();

        if (change.case === "project") projects.push(change.value);

        if (change.case === "worker") {
          workers.add(change.value.id);

          if (change.value.networkRouteStatus) routes.push(change.value.networkRouteStatus.detail);
        }

        if (
          change.case === "models" &&
          change.value.profiles.some((profile) => profile.models.some((m) => m.id === id))
        )
          return { projects, routes, workers };
      }
    }

    const report = (detail: string) =>
      gateway.worker.link.send({ case: "networkRouteStatus", value: { route: "pinned", detail } });

    try {
      const projectId = (await gateway.api.createProject({ name: "Origin" })).project!.id;

      const add = (rootPath: string) =>
        gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath });

      await add("/repo/kept");
      const removed = (await add("/repo/removed")).workspace!;
      await gateway.api.removeWorkspace({ workspaceId: removed.id });

      for (const name of ["Second", "Third", "Fourth"]) await gateway.api.createProject({ name });

      const added = await gateway.addWorker("New placement");

      for (;;) if ((await next()).case === "feeds") break;
      await throughCatalog("ready");
      lists.mockClear();
      const reports = Array.from({ length: 16 }, (_, index) => `route-${index}`);

      for (const detail of reports) report(detail);
      const burst = await throughCatalog("after-burst");
      expect(burst.routes).toEqual(reports);
      expect(burst.projects.length).toBe(0);
      expect(burst.workers).toEqual(new Set([gateway.workerId]));
      expect(lists).not.toHaveBeenCalled();

      const check = spyOn(gateway.core.cli.checks, "tick").mockResolvedValue(undefined);

      try {
        await gateway.core.cli.start();
      } finally {
        gateway.core.cli.stop();
        check.mockRestore();
      }

      const fleet = await throughCatalog("idle-fleet-poll");
      expect(fleet.workers).toEqual(new Set([gateway.workerId, added.workerId]));
      expect(fleet.projects).toEqual([]);
      expect(lists).toHaveBeenCalledTimes(1);
      lists.mockClear();

      // The removed workspace also has an expired cache entry, but cannot be probed again.
      setSystemTime(new Date(Date.now() + 31_000));
      origin = "example.org/team/new";
      report("check-origin");
      report("same-origin");
      const refreshed = await throughCatalog("after-origin");
      expect(refreshed.projects.map((p) => p.id)).toEqual([projectId]);
      expect(refreshed.projects[0]?.workspaces[0]?.gitOrigin).toBe(origin);
      expect(lists).toHaveBeenCalledTimes(1);

      setSystemTime(new Date(Date.now() + 31_000));

      const access = () =>
        gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER, enabled: false });

      lists.mockImplementationOnce(() => Effect.fail(new Invalid("Project read interrupted")));
      expect(await failure(access())).toContain("Project read interrupted");
      await access();
      expect(lists).toHaveBeenCalledTimes(2);
      setSystemTime(new Date(Date.now() + 2_000));
      await access();
      expect(lists).toHaveBeenCalledTimes(3);
      await throughCatalog("after-retry");

      setSystemTime(new Date(Date.now() + 31_000));
      report("check-unchanged-origin");
      expect((await throughCatalog("unchanged")).projects).toEqual([]);

      setSystemTime(new Date(Date.now() + 31_000));
      origin = "example.org/team/from-unary-read";
      const overview = await gateway.api.getOverview({});
      expect(overview.projects.find((p) => p.id === projectId)?.workspaces[0]?.gitOrigin).toBe(origin);
      report("deliver-discovered-origin");
      const discovered = await throughCatalog("after-discovery");
      expect(discovered.projects.map((p) => p.id)).toEqual([projectId]);
      expect(discovered.projects.find((p) => p.id === projectId)?.workspaces[0]?.gitOrigin).toBe(origin);

      await gateway.connect(added.workerId, added.credential, undefined, { hello: { scratchRoot: "/new/scratch" } });

      for (;;) {
        const change = await next();

        if (change.case !== "project" || change.value.kind !== "scratch") continue;
        const placement = change.value.workspaces.find((workspace) => workspace.workerId === added.workerId);

        if (!placement) continue;
        expect(placement.rootPath).toBe(`/new/scratch/${gateway.userId}`);
        break;
      }
    } finally {
      setSystemTime();
      lists.mockRestore();
      abort.abort();
      await updates.return?.();
      await gateway.close();
    }
  },
  45_000,
);

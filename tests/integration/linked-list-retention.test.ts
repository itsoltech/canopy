import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { awayReason, formatPresenceTime } from "@canopy/domain/computer-presence";
import {
  forgetComputerProjects,
  projectAwayReason,
  retainLinkedRows,
  retainProjects,
  workersWithAvailability,
} from "@canopy/domain/linked-snapshot";
import { eventually, failure } from "./support/gateway.ts";
import { linkedTimeouts } from "./support/linked-timeouts.ts";

describe.skipIf(!dockerAvailable)("merged lists keep a linked computer's committed mirror", () => {
  let f: Awaited<ReturnType<typeof linkedTimeouts>>;
  let remoteBotId: string;

  beforeAll(async () => {
    f = await linkedTimeouts(true);

    const remote = await f.b.api.createBot({
      clientRequestId: crypto.randomUUID(),
      configuration: {
        ...f.bot.configuration!,
        name: "Remote bot",
        workerId: f.b.workerId,
      },
    });

    remoteBotId = qualifyId(remote.bot!.id, f.node);
    expect(
      await eventually(
        async () => (await f.a.api.listBots({})).bots.some((bot) => bot.id === remoteBotId),
        Boolean,
        15_000,
      ),
    ).toBe(true);
    expect(
      await eventually(async () => Boolean(await f.la.mirror.snapshot(f.node, f.remoteThread.id)), Boolean, 15_000),
    ).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await f?.close();
  }, 30_000);

  async function lists() {
    const started = performance.now();

    const [overview, threads] = await Promise.all([
      f.a.api.getOverview({}),
      f.a.api.listThreads({ sidebarOnly: true }),
    ]);

    expect(performance.now() - started).toBeLessThan(500);
    expect(overview.workers.map((worker) => worker.id)).toContain(f.a.workerId);
    expect(overview.workers.map((worker) => worker.id)).toContain(qualifyId(f.b.workerId, f.node));
    expect(threads.threads.map((thread) => thread.id)).toContain(qualifyId(f.remoteThread.id, f.node));
    expect(
      overview.projects.some((project) =>
        project.workspaces.some((workspace) => workspace.workerId === qualifyId(f.b.workerId, f.node)),
      ),
    ).toBe(true);

    return { overview, threads: threads.threads };
  }

  test("web and mobile snapshots retain workers, projects and readable threads across repeated blackholes", async () => {
    const initial = await lists();
    // Aggregate refreshes can omit a home before connection liveness notices the stall.
    expect(retainLinkedRows(initial.threads, [], initial.overview.computers)).toEqual(
      initial.threads.filter((row) => row.nodeId),
    );
    expect(retainLinkedRows(initial.threads, [], [])).toEqual([]);
    expect(retainProjects(initial.overview.projects, [], initial.overview.computers).length).toBeGreaterThan(0);
    expect(forgetComputerProjects(initial.overview.projects, f.node).some((project) => project.nodeId === f.node)).toBe(
      false,
    );

    for (let flap = 0; flap < 2; flap++) {
      f.pa.freeze(true);
      f.pb.freeze(true);

      try {
        // A live-looking socket with silent traffic still returns the committed rows immediately.
        await lists();
        const cold = new AbortController();
        const opened = performance.now();

        try {
          for await (const update of f.a.api.watchThread(
            { threadId: qualifyId(f.remoteThread.id, f.node), pageSize: 24, incremental: true },
            { signal: cold.signal },
          )) {
            expect(update.change.case).toBe("snapshot");
            expect(update.syncing).toBe(true);
            expect(performance.now() - opened).toBeLessThan(500);
            break;
          }
        } finally {
          cold.abort();
        }

        expect(await eventually(async () => !f.la.reachable().includes(f.node), Boolean, 10_000)).toBe(true);
        const { overview, threads } = await lists();
        expect((await f.a.api.listBots({})).bots.map((bot) => bot.id)).toContain(remoteBotId);

        const agentList = await f.a.worker.callTool({
          threadId: f.localThread.id,
          tool: "list_threads",
          args: { scope: "all" },
        });

        expect(agentList.isError).toBe(false);
        expect(JSON.stringify(agentList)).toContain(qualifyId(f.remoteThread.id, f.node));
        const peer = overview.computers.find((computer) => computer.nodeId === f.node)!;
        expect(awayReason(peer, formatPresenceTime)).toBeTruthy();
        const workers = workersWithAvailability(overview.workers, overview.computers);
        expect(workers.find((worker) => worker.id === f.a.workerId)?.online).toBe(true);
        expect(workers.find((worker) => worker.nodeId === f.node)?.online).toBe(false);
        const project = overview.projects.find((project) => project.nodeId === f.node && project.kind !== "scratch")!;
        expect(projectAwayReason(project, workers, overview.computers)).toBeTruthy();
        // Shared web/mobile reconciliation also protects a last-known snapshot from an incomplete reconnect.
        expect(
          retainLinkedRows(
            initial.threads,
            threads.filter((thread) => !thread.nodeId),
            overview.computers,
          ).map((thread) => thread.id),
        ).toContain(qualifyId(f.remoteThread.id, f.node));
        const started = performance.now();
        const threadId = qualifyId(f.remoteThread.id, f.node);
        expect((await f.a.api.getThread({ threadId })).thread?.id).toBe(threadId);
        const controller = new AbortController();

        try {
          for await (const update of f.a.api.watchThread({ threadId }, { signal: controller.signal })) {
            expect(update.syncing).toBe(true);
            expect(update.change.case).toBe("snapshot");
            break;
          }

          for await (const update of f.a.api.watchOverview({ includeSnapshot: true }, { signal: controller.signal })) {
            if (update.change.case !== "mobileSnapshot") continue;
            expect(update.change.value.threads.map((thread) => thread.id)).toContain(threadId);
            expect(update.change.value.overview?.workers.map((worker) => worker.id)).toContain(
              qualifyId(f.b.workerId, f.node),
            );
            break;
          }
        } finally {
          controller.abort();
        }

        expect(performance.now() - started).toBeLessThan(500);
        expect(await failure(f.a.api.sendMessage({ threadId, text: "must not send while offline" }))).toContain(
          "unreachable",
        );
      } finally {
        f.pa.thaw();
        f.pb.thaw();
        await f.la.announce("sleeping");
        await f.la.announce("connected");
      }

      expect(await eventually(async () => f.la.reachable().includes(f.node), Boolean, 5000)).toBe(true);
      const { overview } = await lists();
      expect(
        awayReason(
          overview.computers.find((computer) => computer.nodeId === f.node),
          formatPresenceTime,
        ),
      ).toBeUndefined();
    }
  }, 45_000);
});

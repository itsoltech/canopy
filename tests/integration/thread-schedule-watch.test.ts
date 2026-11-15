import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { routedPinnedTransport } from "@canopy/transport";
import { pairDesktop } from "../../apps/desktop/src/remote-client.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { watchSequenceThread } from "../../apps/gateway/src/core/sequence-thread-watch.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("worker schedules in a local thread sequence watch", () => {
  let gw: TestGateway;
  let desktop: TestGateway["api"];
  let network: NetworkAccess;
  let unmount: () => void;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Schedule watch" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/schedule-watch" }))
      .workspace!.id;
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));

    const paired = await pairDesktop(
      toJsonString(ui.CreateMobilePairingResponseSchema, await gw.api.createDesktopPairing({})),
    );

    desktop = createClient(
      ui.GatewayService,
      routedPinnedTransport(gw.core.mobile.networkRoutes(), paired.token).transport,
    );
  }, 30_000);

  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  async function thread() {
    const id = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Scheduled work",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const ready = await eventually(
      () => gw.api.getThread({ threadId: id }),
      (snapshot) => snapshot.thread?.status === "idle",
    );

    expect(ready.thread?.status).toBe("idle");

    return id;
  }

  async function schedule(threadId: string, kind: "once" | "recurring") {
    const prompt = `Check ${kind} work`;

    const result = await gw.worker.callTool({
      threadId,
      tool: kind === "once" ? "schedule_wakeup" : "schedule_recurring",
      args:
        kind === "once" ? { prompt, delay_seconds: 3600 } : { prompt, cron: "0 * * * *", timezone: "UTC", max_runs: 2 },
    });

    expect(result.isError).toBe(false);
    const stored = (await gw.api.listSchedules({ threadId })).schedules.find((item) => item.prompt === prompt);
    expect(stored).toMatchObject({ threadId, kind, status: "active" });

    return stored!;
  }

  test.each(["once", "recurring"] as const)(
    "%s created while initial controls are yielded is the next update",
    async (kind) => {
      const threadId = await thread();
      const abort = new AbortController();

      const watch = watchSequenceThread(
        gw.core,
        create(ui.WatchThreadRequestSchema, { threadId, sequence: true }),
        abort.signal,
      );

      try {
        expect((await watch.next()).value?.change.case).toBe("snapshot");
        const controls = (await watch.next()).value;
        expect(controls?.change).toMatchObject({ case: "controls", value: { schedules: [] } });
        // Leave the generator paused at its initial controls yield while the real worker writes the schedule.
        const created = await schedule(threadId, kind);
        const update = (await watch.next()).value;
        expect(update?.change).toEqual({ case: "schedule", value: created });
      } finally {
        abort.abort();
        await watch.return();
      }
    },
  );

  test("a paired desktop pinned gRPC watch receives once, recurring and cancellation before a refresh", async () => {
    const threadId = await thread();
    const abort = new AbortController();

    // Shorter than the five-second controls refresh: periodic repair cannot make this test pass.
    const watch = desktop
      .watchThread({ threadId, sequence: true }, { signal: abort.signal, timeoutMs: 4000 })
      [Symbol.asyncIterator]();

    async function nextSchedule() {
      let update = (await watch.next()).value;

      while (update?.change.case === "batch") update = (await watch.next()).value;
      expect(update?.change.case).toBe("schedule");

      return update?.change.value;
    }

    try {
      expect((await watch.next()).value?.change.case).toBe("snapshot");
      expect((await watch.next()).value?.change.case).toBe("controls");
      expect((await watch.next()).value?.change.case).toBe("batch");

      for (const kind of ["once", "recurring"] as const) {
        const created = await schedule(threadId, kind);
        expect(await nextSchedule()).toEqual(created);

        const cancelled = await gw.worker.callTool({
          threadId,
          tool: "cancel_schedule",
          args: { schedule_id: created.id },
        });

        expect(cancelled.isError).toBe(false);
        expect(await nextSchedule()).toMatchObject({ id: created.id, threadId, kind, status: "cancelled" });
      }
    } finally {
      abort.abort();
      await watch.return?.();
    }
  });
});

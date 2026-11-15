import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, github, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { BffReads, type BffReadProjection } from "../../apps/web/src/lib/server/bff-reads.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("BFF shared reads", () => {
  let gateway: TestGateway;
  let threadId = "";

  beforeAll(async () => {
    gateway = await startTestGateway();
    const project = (await gateway.api.createProject({ name: "BFF reads" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project.id,
        workerId: gateway.workerId,
        rootPath: "/repo/bff-reads",
      })
    ).workspace!;

    threadId = (
      await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!.id;
    await eventually(
      () => gateway.api.getThread({ threadId }),
      (response) => response.thread?.status === "idle",
    );
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("two readers share one real gateway RPC and publish a complete projection", async () => {
    const reads = new BffReads();
    const frames: BffReadsFrame[] = [];
    const stop = reads.listen((frame) => frames.push(frame));
    let calls = 0;

    try {
      const fetch = async () => {
        calls++;

        return gateway.api.listBots({ includeArchived: true });
      };

      const [first, second] = await Promise.all([
        reads.read("ListBots", bots.ListBotsResponseSchema, fetch),
        reads.read("ListBots", bots.ListBotsResponseSchema, fetch),
      ]);

      expect(calls).toBe(1);
      expect(first).toEqual(second);
      expect(frames).toHaveLength(1);
      const frame = frames[0];

      if (!frame || !("value" in frame)) throw new Error("Missing ListBots projection");
      expect(frame).toMatchObject({ key: "ListBots", type: bots.ListBotsResponseSchema.typeName });
      expect(frame.value).toEqual({});
    } finally {
      stop();
      reads.close();
    }
  }, 20_000);

  test("a real bot mutation revalidates the visible list and broadcasts its new projection", async () => {
    const reads = new BffReads();
    const controller = new AbortController();

    const stream = gateway.api
      .watchOverview({ includeSnapshot: true }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    const first = (await stream.next()).value;

    if (!first) throw new Error("The gateway did not send an overview snapshot");
    reads.apply(first);
    const frames: BffReadsFrame[] = [];
    const stop = reads.listen((frame) => frames.push(frame));

    try {
      await reads.read("ListBots", bots.ListBotsResponseSchema, () => gateway.api.listBots({ includeArchived: true }));
      frames.length = 0;

      const bot = (
        await gateway.api.createBot({
          clientRequestId: crypto.randomUUID(),
          configuration: {
            name: "BFF mutation",
            shape: "round",
            color: "#22aaff",
            provider: Provider.CODEX,
            providerInstance: "native",
            model: "gpt-6.1-sol",
            workerId: gateway.workerId,
          },
        })
      ).bot!;

      for (;;) {
        const update = (await stream.next()).value;

        if (!update) throw new Error("The overview stream ended before the bot update");
        reads.apply(update);

        if (update.change.case === "bot" && update.change.value.id === bot.id) break;
      }

      await eventually(
        async () => frames.find((frame) => "value" in frame && frame.key === "ListBots"),
        (frame) => Boolean(frame && "value" in frame && JSON.stringify(frame.value).includes(bot.id)),
      );
      await gateway.api.deleteBot({ botId: bot.id });
    } finally {
      stop();
      controller.abort();
      await stream.return?.();
      reads.close();
    }
  }, 30_000);

  test("a soft snapshot gap refreshes loaded projections without private reset frames", async () => {
    const reads = new BffReads();
    const controller = new AbortController();

    const stream = gateway.api
      .watchOverview({ includeSnapshot: true }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    const first = (await stream.next()).value;

    if (!first) throw new Error("The gateway did not send an overview snapshot");
    reads.apply(first);
    let calls = 0;

    const fetch = async () => {
      calls++;

      return gateway.api.listBots({ includeArchived: true });
    };

    await reads.read("ListBots:soft", bots.ListBotsResponseSchema, fetch);
    const frames: BffReadsFrame[] = [];
    const stop = reads.listen((frame) => frames.push(frame));
    frames.length = 0;

    try {
      reads.apply(first, false);
      await Bun.sleep(100);
      expect(calls).toBe(2);
      expect(frames.some((frame) => "reset" in frame)).toBe(false);
    } finally {
      stop();
      controller.abort();
      await stream.return?.();
      reads.close();
    }
  }, 20_000);

  test("private snapshot reset precedes a replacement read even after the listener disconnects", async () => {
    const reads = new BffReads();
    const controller = new AbortController();

    const stream = gateway.api
      .watchOverview({ includeSnapshot: true }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    const first = (await stream.next()).value;

    if (!first) throw new Error("The gateway did not send an overview snapshot");
    reads.apply(first);
    let calls = 0;

    const fetch = async () => {
      calls++;

      return gateway.api.listThreadPullRequests({ threadId });
    };

    const initial = await reads.read(
      "ListThreadPullRequests:" + threadId,
      github.ThreadPullRequestsResponseSchema,
      fetch,
    );

    expect(initial.links).toEqual([]);
    const order: string[] = [];
    const stop = reads.listen((frame) => order.push("reset" in frame ? "reset" : "projection"));
    order.length = 0;

    try {
      reads.apply(first);
      expect(order[0]).toBe("reset");
      stop();
      await reads.read("ListThreadPullRequests:" + threadId, github.ThreadPullRequestsResponseSchema, fetch);
      expect(calls).toBe(2);
    } finally {
      controller.abort();
      await stream.return?.();
      reads.close();
    }
  }, 20_000);

  test("a failed reactive refresh is retried by the next shared read", async () => {
    const reads = new BffReads();
    let calls = 0;

    const fetch = async () => {
      calls++;

      if (calls === 2) throw new Error("temporary gateway failure");

      return gateway.api.listBots({ includeArchived: true });
    };

    try {
      await reads.read("ListBots:retry", bots.ListBotsResponseSchema, fetch);
      reads.apply(create(ui.OverviewUpdateSchema, { change: { case: "botRemoved", value: "missing" } }));
      await Bun.sleep(100);
      await reads.read("ListBots:retry", bots.ListBotsResponseSchema, fetch);
      expect(calls).toBe(3);
    } finally {
      reads.close();
    }
  }, 20_000);

  test.each(["computerSnapshot", "mobileSnapshot"] as const)(
    "a pending private panel read is fenced by %s",
    async (kind) => {
      const reads = new BffReads();
      const gate = Promise.withResolvers<void>();

      const pending = reads.read("GetThreadPanel:" + threadId, ui.ThreadPanelSchema, async () => {
        await gate.promise;

        return gateway.api.getThreadPanel({ threadId });
      });

      await Bun.sleep(10);

      const update =
        kind === "computerSnapshot"
          ? create(ui.OverviewUpdateSchema, {
              change: { case: "computerSnapshot", value: create(ui.LinkedComputerSnapshotSchema, { nodeId: "home" }) },
            })
          : create(ui.OverviewUpdateSchema, {
              change: {
                case: "mobileSnapshot",
                value: { overview: create(ui.GetOverviewResponseSchema), threads: [] },
              },
            });

      reads.apply(update);
      gate.resolve();

      await expect(pending).rejects.toThrow("The session ended");
      reads.close();
    },
  );

  test("close fences an in-flight real gateway read", async () => {
    const reads = new BffReads();
    const gate = Promise.withResolvers<void>();

    const pending = reads.read("ListBots:close", bots.ListBotsResponseSchema, async () => {
      await gate.promise;

      return gateway.api.listBots({ includeArchived: true });
    });

    await Bun.sleep(10);
    reads.close();
    gate.resolve();

    await expect(pending).rejects.toThrow("The session ended");
  }, 20_000);
});

type BffReadsFrame = BffReadProjection;

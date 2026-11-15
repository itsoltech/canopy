import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { NoticeLevel, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { BffWarming } from "../../apps/web/src/lib/server/bff-warming.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe.skipIf(!dockerAvailable)("BFF thread warming", () => {
  let gateway: TestGateway;
  let store: ComputerStore;
  let threadId: string;

  beforeAll(async () => {
    gateway = await startTestGateway();
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const project = (await gateway.api.createProject({ name: "BFF warming" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project.id,
        workerId: gateway.workerId,
        rootPath: "/repo/bff-warming",
      })
    ).workspace!;

    threadId = (
      await gateway.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title: "BFF warming thread",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
       SELECT $1::uuid,'bff-tail-' || n,'agentMessage','completed',
         jsonb_build_object('itemId','bff-tail-' || n,'agentMessage',jsonb_build_object('text','tail ' || n)),n,n
       FROM generate_series(1,180) n`,
      [threadId],
    );
  }, 20_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("fills once from reactive heads, seeds its cursor, and observes without losing the tail", async () => {
    const changes: string[] = [];
    const noticeCodes: string[] = [];

    const warming = new BffWarming(gateway.api, (_id, update) => {
      changes.push(update.change.case ?? "");

      if (update.change.case === "batch")
        noticeCodes.push(
          ...update.change.value.records.flatMap((record) =>
            record.value.case === "notice" ? [record.value.value.notice?.code ?? ""] : [],
          ),
        );
    });

    let writes = 0;
    const originalSet = warming.cache.set.bind(warming.cache);
    warming.cache.set = (snapshot, bytes) => {
      writes++;
      originalSet(snapshot, bytes);
    };

    try {
      warming.select([threadId]);
      const firstHead = await applyFirstHead(warming, threadId);

      const snapshot = await eventually(
        async () => warming.cache.peek(threadId),
        (value) => !!value?.syncCursor,
        10_000,
      );

      expect(warming.warmer.head(threadId)).toEqual(firstHead);
      expect(snapshot?.syncCursor?.appliedSeq).toBeGreaterThanOrEqual(firstHead.appliedSeq);
      expect(snapshot?.items.length).toBeLessThanOrEqual(128);
      expect(snapshot?.items.at(-1)?.item?.itemId).toBe("bff-tail-180");
      expect(warming.warmer.requests).toBe(1);
      expect(changes).toEqual(["snapshot"]);

      const seed = warming.seed(threadId);
      expect(seed?.change.case).toBe("snapshot");

      if (seed?.change.case !== "snapshot") throw new Error("BFF warming did not seed a snapshot");
      expect(seed.change.value.syncCursor).toEqual(snapshot?.syncCursor);

      const beforeItems = snapshot!.items.map((entry) => entry.item?.itemId);
      const beforeCursor = snapshot!.syncCursor!;
      await gateway.api.updateThread({ threadId, title: "Observed while open" });
      const update = await readBatch(beforeCursor);
      const generation = warming.generation;
      const beforeChanges = changes.length;

      warming.observe(threadId, update, generation);

      expect(changes.length).toBe(beforeChanges + 1);
      expect(warming.cache.peek(threadId)?.thread?.title).toBe("Observed while open");
      expect(warming.cache.peek(threadId)?.items.map((entry) => entry.item?.itemId)).toEqual(beforeItems);
      expect(warming.cache.peek(threadId)?.syncCursor?.appliedSeq).toBeGreaterThan(beforeCursor.appliedSeq);

      const safeSnapshot = await applyFirstHead(warming, threadId);
      expect(safeSnapshot.epoch).toBe(beforeCursor.epoch);
      expect(warming.generation).toBe(generation);
      expect(warming.warmer.requests).toBe(1);

      const afterSafeSnapshot = await readBatch(warming.cache.peek(threadId)!.syncCursor!);
      warming.observe(threadId, afterSafeSnapshot, generation);
      expect(warming.cache.peek(threadId)?.thread?.title).toBe("Observed while open");

      const staleGeneration = warming.generation;
      warming.cache.clear();
      const changesBeforeFence = changes.length;
      const writesBeforeFence = writes;
      warming.apply(
        create(ui.OverviewUpdateSchema, {
          change: {
            case: "mobileSnapshot",
            value: { overview: create(ui.GetOverviewResponseSchema), threads: [] },
          },
        }),
      );
      expect(warming.generation).toBe(staleGeneration + 1);
      expect(warming.cache.peek(threadId)).toBeUndefined();

      const staleNotice = create(ui.ThreadUpdateSchema, {
        change: {
          case: "batch",
          value: {
            threadId,
            epoch: beforeCursor.epoch,
            baseSeq: beforeCursor.appliedSeq,
            appliedSeq: beforeCursor.appliedSeq + 1n,
            headSeq: beforeCursor.appliedSeq + 1n,
            caughtUp: true,
            records: [
              {
                seq: beforeCursor.appliedSeq + 1n,
                key: "notice:stale-connectors",
                value: {
                  case: "notice",
                  value: {
                    seq: beforeCursor.appliedSeq + 1n,
                    notice: {
                      code: "connectors_applied",
                      level: NoticeLevel.INFO,
                      message: "Connector tools updated",
                    },
                  },
                },
              },
            ],
          },
        },
      });

      warming.observe(threadId, staleNotice, staleGeneration);
      expect(warming.cache.peek(threadId)).toBeUndefined();
      expect(changes.length).toBe(changesBeforeFence + 1);
      expect(noticeCodes).toEqual(["connectors_applied"]);
      expect(writes).toBe(writesBeforeFence);
    } finally {
      warming.close();
    }
  }, 20_000);

  test.each(["reset", "close"] as const)(
    "fences an in-flight real RPC on %s without writing after abort",
    async (mode) => {
      const started = deferred();
      const release = deferred();
      const settled = deferred();
      const changes: string[] = [];
      let writes = 0;

      const api = {
        ...gateway.api,
        watchThread: (
          request: Parameters<typeof gateway.api.watchThread>[0],
          options?: Parameters<typeof gateway.api.watchThread>[1],
        ) => {
          const source = gateway.api.watchThread(request, options);

          return (async function* () {
            const iterator = source[Symbol.asyncIterator]();

            try {
              const first = await iterator.next();
              started.resolve();

              if (first.done) return;
              await release.promise;
              yield first.value;

              for (;;) {
                const next = await iterator.next();

                if (next.done) return;
                yield next.value;
              }
            } finally {
              await iterator.return?.();
              settled.resolve();
            }
          })();
        },
      } as Client<typeof ui.GatewayService>;

      const warming = new BffWarming(api, (_id, update) => changes.push(update.change.case ?? ""));
      const originalSet = warming.cache.set.bind(warming.cache);
      warming.cache.set = (snapshot, bytes) => {
        writes++;
        originalSet(snapshot, bytes);
      };

      try {
        warming.select([threadId]);
        await applyFirstHead(warming, threadId);
        await started.promise;

        if (mode === "reset") {
          warming.apply(
            create(ui.OverviewUpdateSchema, {
              change: { case: "thread", value: { id: threadId, deletedAt: { seconds: 1n, nanos: 0 } } },
            }),
          );
        } else warming.close();

        release.resolve();
        await settled.promise;
        expect(writes).toBe(0);
        expect(changes).toEqual([]);
        expect(warming.cache.peek(threadId)).toBeUndefined();
      } finally {
        release.resolve();
        warming.close();
        await settled.promise;
      }
    },
    20_000,
  );

  async function applyFirstHead(warming: BffWarming, id: string) {
    const controller = new AbortController();

    try {
      for await (const update of gateway.api.watchOverview(
        { includeSnapshot: true, threadHeadIds: [id] },
        { signal: controller.signal, timeoutMs: 7000 },
      )) {
        warming.apply(update);

        if (update.change.case === "threadHeads") {
          const head = update.change.value.heads.find((value) => value.threadId === id);

          if (head) return head;
        }
      }
    } finally {
      controller.abort();
    }

    throw new Error(`No head for ${id}`);
  }

  async function readBatch(cursor: ui.ThreadSyncCursor) {
    const controller = new AbortController();

    try {
      for await (const update of gateway.api.watchThread(
        { threadId, syncCursor: cursor, sequence: true, background: true, pageSize: 24 },
        { signal: controller.signal, timeoutMs: 7000 },
      )) {
        if (update.change.case === "batch") return update;
      }
    } finally {
      controller.abort();
    }

    throw new Error(`No batch for ${threadId}`);
  }
});

import { create, toBinary } from "@bufbuild/protobuf";
import { ui, computerLink as link, ItemSchema } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { createHash } from "node:crypto";
import { GatewayStore, BackgroundTaskStore, SteerStore, toUiThread } from "../../apps/gateway/src/store/index.ts";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { ThreadMirror, commitMirrorUpdate } from "../../apps/gateway/src/computers/mirror.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { DesktopUpdateStore } from "../../apps/gateway/src/desktop-updates/store.ts";
import { UpdateRunStore } from "../../apps/gateway/src/updates/run-store.ts";
import { createRun, runs, knownSources, setRunStatus } from "../../apps/gateway/src/imports/store.ts";
import { ids, type Dataset } from "./seed.ts";
import type { BenchRuntime } from "./runtime.ts";

export interface Operation {
  readonly name: string;
  readonly run: (runtime: BenchRuntime) => Promise<void>;
}

const generation = "40000000-0000-4000-8000-000000000001";
const cursor = `${generation}:1`;

function turnId(ordinal: number) {
  const hash = createHash("md5").update(`turn-1-${ordinal}`).digest("hex");

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

export function operations(size: Dataset): Operation[] {
  return [
    {
      name: "overview/projects",
      run: async (runtime) => {
        await runtime.runPromise(GatewayStore.use((s) => s.listProjects(ids.owner)));
      },
    },
    {
      name: "sidebar/threads",
      run: async (runtime) => {
        await runtime.runPromise(GatewayStore.use((s) => s.listThreads(ids.owner, "", false, true)));
      },
    },
    ...[undefined, 20].map((pageSize): Operation => ({
      name: pageSize ? "thread/open-page" : "thread/open-full",
      run: async (runtime) => {
        await runtime.runPromise(
          GatewayStore.use((s) =>
            s.snapshot(
              ids.thread,
              undefined,
              false,
              pageSize
                ? { pageSize, beforeTurnId: "", targetItemId: "", historyVersion: "", fromTurnId: "" }
                : undefined,
            ),
          ),
        );
      },
    })),
    {
      name: "thread/history-page",
      run: async (runtime) => {
        const boundary = turnId(Math.max(1, size.longTurns - 20));
        await runtime.runPromise(
          GatewayStore.use((s) =>
            s.snapshot(ids.thread, undefined, false, {
              pageSize: 20,
              beforeTurnId: boundary,
              targetItemId: "",
              historyVersion: "",
              fromTurnId: "",
            }),
          ),
        );
      },
    },
    ...inputOperations(size),
    ...mirrorOperations(size),
    ...importOperations(),
  ];
}

function inputOperations(size: Dataset): Operation[] {
  return [
    {
      name: "send/queue",
      run: async (runtime) => {
        await runtime.runPromise(
          GatewayStore.use((s) =>
            s.enqueueTurn({
              threadId: ids.thread,
              userId: ids.owner,
              clientRequestId: Bun.randomUUIDv7(),
              text: "Synthetic queued message",
            }),
          ),
        );
      },
    },
    {
      name: "send/steer",
      run: async (runtime) => {
        await runtime.runPromise(
          SteerStore.use((s) =>
            s.create({
              threadId: ids.thread,
              turnId: turnId(1),
              userId: ids.owner,
              clientRequestId: Bun.randomUUIDv7(),
              text: "Synthetic steer",
              model: "",
              effort: "",
              permissionMode: "",
            }),
          ),
        );
      },
    },
    {
      name: "thread/mark-seen",
      run: async (runtime) => {
        await runtime.runPromise(
          GatewayStore.use((s) => s.markThreadSeen(ids.owner, ids.thread, BigInt(size.longTurns * 2))),
        );
      },
    },
    {
      name: "search/titles",
      run: async (runtime) => {
        const threads = await runtime.runPromise(
          GatewayStore.use((s) => s.searchThreads(ids.owner, "Benchmark 12", "", 20)),
        );

        threads.map(toUiThread);
      },
    },
    {
      name: "background/list",
      run: async (runtime) => {
        await runtime.runPromise(BackgroundTaskStore.use((s) => s.list(ids.thread, "running", 50)));
      },
    },
    {
      name: "bots/conversation-page",
      run: async (runtime) => {
        const hash = createHash("md5").update("bot-1").digest("hex");
        const bot = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
        await runtime.runPromise(BotStore.use((s) => s.conversation(ids.owner, bot, "", 20)));
      },
    },
    {
      name: "updates/read",
      run: async (runtime) => {
        await new UpdateRunStore(runtime, ids.owner).read();
        await new DesktopUpdateStore(runtime, ids.owner).list();
      },
    },
  ];
}

function mirrorOperations(size: Dataset): Operation[] {
  return [
    {
      name: "mirror/write",
      run: async (runtime) => {
        await commitMirrorUpdate(
          runtime,
          ids.owner,
          "benchmark-peer",
          generation,
          { cursor, generation, overview: null, subscription_id: generation },
          create(link.MirrorUpdateSchema, { snapshot: mirrorSnapshot(size), cursor, commit: true }),
          null,
        );
      },
    },
    {
      name: "mirror/read",
      run: async (runtime) => {
        await mirror(runtime).read("benchmark-peer", ids.thread);
      },
    },
    {
      name: "mirror/list",
      run: async (runtime) => {
        await mirror(runtime).threads("benchmark-peer", create(ui.ListThreadsRequestSchema));
      },
    },
  ];
}

function importOperations(): Operation[] {
  return [
    {
      name: "imports/create",
      run: async (runtime) => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const id = Bun.randomUUIDv7();
            yield* createRun(sql, {
              id,
              ownerId: ids.owner,
              workerId: ids.worker,
              mode: "history",
              alreadyImported: 0,
              items: Array.from({ length: 100 }, (_, n) => ({
                agentCli: "codex",
                rootId: "synthetic",
                nativeId: Bun.randomUUIDv7(),
                sourceKey: Bun.randomUUIDv7(),
                title: `Synthetic import ${n}`,
                cwd: "/benchmark",
                snapshot: { size: "10000", modifiedMs: "0", prefixSha256: "" },
                target: { projectId: "", workspaceId: "", cwd: "/benchmark", mode: "history" },
                bytes: 10000n,
              })),
            });
            yield* setRunStatus(sql, id, "completed");
          }),
        );
      },
    },
    {
      name: "imports/read",
      run: async (runtime) => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runs(sql, ids.owner);
            yield* knownSources(sql, ids.owner, ids.worker);
          }),
        );
      },
    },
  ];
}

const mirror = (runtime: BenchRuntime) => new ThreadMirror(new ComputerStore(runtime, ids.owner, Buffer.alloc(32, 1)));

function mirrorSnapshot(size: Dataset) {
  return create(ui.ThreadSnapshotSchema, {
    thread: create(ui.ThreadSchema, { id: ids.thread, title: "Synthetic mirrored thread" }),
    items: Array.from({ length: size.turns }, (_, n) =>
      create(ui.TimelineItemSchema, {
        item: create(ItemSchema, {
          itemId: `mirror-${n}`,
          content: { case: "agentMessage", value: { text: "x".repeat(size.textBytes) } },
        }),
        firstSeq: BigInt(n + 1),
        lastSeq: BigInt(n + 1),
      }),
    ),
  });
}

export const seedMirrors = (size: Dataset) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO computer_mirror_state(owner_user_id,origin_node_id,generation,cursor,subscription_id)
    VALUES (${ids.owner}::uuid,'benchmark-peer',${generation}::uuid,${cursor},${generation}::uuid)`;
    const snapshot = mirrorSnapshot(size);
    yield* sql`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
    VALUES (${ids.owner}::uuid,'benchmark-peer',${generation}::uuid,${ids.thread}::uuid,
      ${toBinary(ui.ThreadSnapshotSchema, snapshot)},${toBinary(ui.ThreadSchema, snapshot.thread!)})`;
  });

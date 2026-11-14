import { create, toJson } from "@bufbuild/protobuf";
import { bots, ItemSchema, Provider, ui } from "@canopy/contracts";
import { itemStatus, itemType } from "@canopy/domain/items";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ensureDevUser, gatewayRuntime, migrateDatabase } from "../../apps/gateway/src/runtime.ts";
import { GatewayStore } from "../../apps/gateway/src/store/index.ts";
import { longThreadSnapshot } from "../../apps/web/src/lib/features/threads/dev/fixture.ts";
import { workspaceFileLinks } from "./workspace-files.ts";

/** Called only for the disposable database just created by client-stack; never accepts an existing stack. */
export async function seedClient(env: Readonly<Record<string, string | undefined>>) {
  const runtime = gatewayRuntime(env);

  try {
    await migrateDatabase(runtime);
    const owner = await ensureDevUser(runtime, "dev@localhost");

    const worker = await runtime.runPromise(
      GatewayStore.use((store) => store.addWorker({ name: "Benchmark", ownerUserId: owner })),
    );

    const project = Bun.randomUUIDv7();
    const workspace = Bun.randomUUIDv7();
    const thread = Bun.randomUUIDv7();
    const short = Bun.randomUUIDv7();
    const snapshot = longThreadSnapshot({ turns: 1000, answerRepeat: 64 });

    if (env["CANOPY_BENCH_WORKSPACE"] === "1") {
      const last = snapshot.items.findLast((entry) => entry.item?.content.case === "agentMessage");

      if (last?.item?.content.case === "agentMessage")
        last.item.content.value.text = `Workspace files: ${workspaceFileLinks}`;
    }

    // Opening checks: one turn that does not fill the viewport, and a last turn larger than a first page.
    const tail = Bun.randomUUIDv7();

    const seeded = [
      seedRows(thread, snapshot),
      seedRows(short, longThreadSnapshot({ turns: 1 })),
      seedRows(tail, longLastTurn()),
    ];

    const ids = seeded[0]!.ids;
    const titles = ["Synthetic thread (1000 turns)", "Synthetic thread (1 turn)", "Synthetic thread (long last turn)"];

    const threads = Array.from({ length: 500 }, (_, index) => ({
      id: seeded[index]?.thread ?? Bun.randomUUIDv7(),
      title: titles[index] ?? `Synthetic conversation ${index} — sidebar history and long titles`,
      seq: seeded[index]?.lastSeq ?? "0",
    }));

    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projects (id, owner_user_id, name, slug) VALUES (${project}::uuid, ${owner}::uuid, 'Benchmark', 'benchmark')`;
        yield* sql`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES (${workspace}::uuid, ${project}::uuid, ${worker.workerId}::uuid, '/srv/canopy')`;
        yield* sql`INSERT INTO threads (id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, provider_thread_id, worker_id, workspace_id, cwd, status, title, last_seq)
        SELECT id, id, ${project}::uuid, ${owner}::uuid, 'main', 'worker', 'codex', 'benchmark-' || id::text, ${worker.workerId}::uuid, ${workspace}::uuid, '/srv/canopy', 'idle', title, seq
        FROM jsonb_to_recordset(${JSON.stringify(threads)}::jsonb) AS t(id uuid, title text, seq bigint)`;

        for (const rows of seeded) {
          yield* sql`INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input, first_seq, last_seq, queued_at, started_at, completed_at)
          SELECT id, ${rows.thread}::uuid, ordinal, 'completed', 'user', ${owner}::uuid, jsonb_build_object('text', input), first, last, now(), now(), now()
          FROM jsonb_to_recordset(${JSON.stringify(rows.turns)}::jsonb) AS t(id uuid, ordinal int, input text, first bigint, last bigint)`;
          yield* sql`INSERT INTO thread_items (thread_id, item_id, turn_id, parent_item_id, type, status, content, first_seq, last_seq)
          SELECT ${rows.thread}::uuid, id, turn, parent, type, status, content, seq, seq
          FROM jsonb_to_recordset(${JSON.stringify(rows.items)}::jsonb) AS i(id text, turn uuid, parent text, type text, status text, content jsonb, seq bigint)`;
        }

        const configuration = toJson(
          bots.BotConfigurationSchema,
          create(bots.BotConfigurationSchema, {
            name: "Benchmark bot",
            shape: "round",
            color: "#8b5cf6",
            provider: Provider.CODEX,
            providerInstance: "native",
            model: "benchmark",
            workerId: worker.workerId,
            approvalPolicy: "safe",
          }),
        );

        yield* sql`INSERT INTO bots (id, owner_user_id, client_request_id, configuration, provider, provider_instance) VALUES (${Bun.randomUUIDv7()}::uuid, ${owner}::uuid, 'benchmark', ${JSON.stringify(configuration)}::jsonb, 'codex', 'native')`;
      }),
    );

    return { thread, short, tail, worker, turn: ids.values().next().value! };
  } finally {
    await runtime.dispose();
  }
}

/** Turn and item rows of a fixture snapshot, with gateway ids for its turns. */
function seedRows(thread: string, snapshot: ReturnType<typeof longThreadSnapshot>) {
  const ids = new Map(snapshot.turns.map((turn) => [turn.id, Bun.randomUUIDv7()]));

  const items = snapshot.items.flatMap((entry) =>
    entry.item
      ? [
          {
            id: entry.item.itemId,
            turn: ids.get(entry.turnId),
            parent: entry.item.parentItemId || null,
            type: itemType(entry.item),
            status: itemStatus(entry.item),
            content: toJson(ItemSchema, entry.item),
            seq: String(entry.firstSeq),
          },
        ]
      : [],
  );

  const ranges = new Map<string, { first: string; last: string }>();

  for (const entry of snapshot.items) {
    const previous = ranges.get(entry.turnId);
    ranges.set(entry.turnId, { first: previous?.first ?? String(entry.firstSeq), last: String(entry.lastSeq) });
  }

  const turns = snapshot.turns.map((turn) => {
    const range = ranges.get(turn.id);

    if (!range) throw new Error("Fixture turn has no items");

    return { id: ids.get(turn.id), ordinal: turn.ordinal, input: turn.inputText, ...range };
  });

  return { thread, ids, items, turns, lastSeq: String(snapshot.lastSeq) };
}

/** Four turns whose last one has 150 more commands: its work starts before the first page of items. */
function longLastTurn() {
  const snapshot = longThreadSnapshot({ turns: 4 });
  const answer = snapshot.items.findLastIndex((entry) => entry.item?.content.case === "agentMessage");
  const command = snapshot.items.find((entry) => entry.item?.content.case === "commandExecution");
  const turnId = snapshot.items[answer]?.turnId;

  if (!command?.item || !turnId) throw new Error("Fixture turn has no command");
  const item = command.item;

  const extra = Array.from({ length: 150 }, (_, index) =>
    create(ui.TimelineItemSchema, { ...command, turnId, item: { ...item, itemId: `long-turn-command-${index}` } }),
  );

  snapshot.items.splice(answer, 0, ...extra);
  snapshot.items.forEach((entry, index) => {
    entry.firstSeq = BigInt(index + 1);
    entry.lastSeq = entry.firstSeq;
  });
  snapshot.lastSeq = BigInt(snapshot.items.length + 1);

  return snapshot;
}

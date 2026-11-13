import { create, toJson } from "@bufbuild/protobuf";
import { bots, ItemSchema, Provider } from "@canopy/contracts";
import { itemStatus, itemType } from "@canopy/domain/items";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ensureDevUser, gatewayRuntime, migrateDatabase } from "../../apps/gateway/src/runtime.ts";
import { GatewayStore } from "../../apps/gateway/src/store/index.ts";
import { longThreadSnapshot } from "../../apps/web/src/lib/features/threads/dev/fixture.ts";

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
    const snapshot = longThreadSnapshot({ turns: 1000, answerRepeat: 64 });
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

    const threads = Array.from({ length: 500 }, (_, index) => ({
      id: index ? Bun.randomUUIDv7() : thread,
      title: index
        ? `Synthetic conversation ${index} — sidebar history and long titles`
        : "Synthetic thread (1000 turns)",
      seq: index ? "0" : String(snapshot.lastSeq),
    }));

    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projects (id, owner_user_id, name, slug) VALUES (${project}::uuid, ${owner}::uuid, 'Benchmark', 'benchmark')`;
        yield* sql`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES (${workspace}::uuid, ${project}::uuid, ${worker.workerId}::uuid, '/srv/canopy')`;
        yield* sql`INSERT INTO threads (id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, provider_thread_id, worker_id, workspace_id, cwd, status, title, last_seq)
        SELECT id, id, ${project}::uuid, ${owner}::uuid, 'main', 'worker', 'codex', 'benchmark-' || id::text, ${worker.workerId}::uuid, ${workspace}::uuid, '/srv/canopy', 'idle', title, seq
        FROM jsonb_to_recordset(${JSON.stringify(threads)}::jsonb) AS t(id uuid, title text, seq bigint)`;
        yield* sql`INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input, first_seq, last_seq, queued_at, started_at, completed_at)
        SELECT id, ${thread}::uuid, ordinal, 'completed', 'user', ${owner}::uuid, jsonb_build_object('text', input), first, last, now(), now(), now()
        FROM jsonb_to_recordset(${JSON.stringify(turns)}::jsonb) AS t(id uuid, ordinal int, input text, first bigint, last bigint)`;
        yield* sql`INSERT INTO thread_items (thread_id, item_id, turn_id, parent_item_id, type, status, content, first_seq, last_seq)
        SELECT ${thread}::uuid, id, turn, parent, type, status, content, seq, seq
        FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS i(id text, turn uuid, parent text, type text, status text, content jsonb, seq bigint)`;

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

    return { thread, worker };
  } finally {
    await runtime.dispose();
  }
}

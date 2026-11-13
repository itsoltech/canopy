import { createHash } from "node:crypto";
import { clone, create, fromBinary, toBinary, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { bots, computerLink as link } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { linkedMessage, methodNamed, qualify, type RemoteServe } from "./remote.ts";
import type { ComputerStore } from "./store.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";

/** Bot conversations are projections only. A complete replacement commits atomically, like thread mirrors. */
export class BotMirror {
  constructor(readonly store: ComputerStore) {}

  async cursor(node: string): Promise<string> {
    return (
      (
        await this.store.query<{ cursor: string }>(
          "SELECT cursor FROM computer_bot_mirror_state WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
          [this.store.owner, node],
        )
      )[0]?.cursor ?? ""
    );
  }

  async conversations(node: string): Promise<bots.BotConversation[]> {
    const rows = await this.store.query<{ snapshot: Uint8Array }>(
      "SELECT snapshot FROM computer_mirror_bots WHERE owner_user_id=$1::uuid AND origin_node_id=$2 ORDER BY bot_id",
      [this.store.owner, node],
    );

    return rows.map((row) => {
      const value = fromBinary(bots.BotConversationSchema, row.snapshot);
      qualify(bots.BotConversationSchema, value, node);

      return value;
    });
  }

  async *publish(
    request: link.MirrorRequest,
    serve: RemoteServe,
    signal: AbortSignal,
  ): AsyncGenerator<link.BotMirrorUpdate> {
    let cursor = request.cursor;

    while (!signal.aborted) {
      const list = await first<bots.ListBotsResponse>(
        serve(methodNamed("ListBots")!, create(bots.ListBotsRequestSchema, { includeArchived: true }), signal),
      );

      const conversations: bots.BotConversation[] = [];

      for (const bot of list.bots.sort((a, b) => a.id.localeCompare(b.id))) {
        if (signal.aborted) return;

        try {
          conversations.push(
            await first<bots.BotConversation>(
              serve(
                methodNamed("WatchBotConversation")!,
                create(bots.WatchBotConversationRequestSchema, { botId: bot.id }),
                signal,
              ),
            ),
          );
        } catch (error) {
          // Concurrent deletion: retry the whole projection, never commit a partial list.
          if (error instanceof ConnectError && error.code === Code.NotFound) {
            conversations.length = 0;
            break;
          }

          throw error;
        }
      }

      if (conversations.length === list.bots.length) {
        const hash = createHash("sha256");

        for (const c of conversations) hash.update(toBinary(bots.BotConversationSchema, c));
        const next = hash.digest("hex");

        if (cursor !== next) {
          yield create(link.BotMirrorUpdateSchema, { cursor: next, start: true });

          for (const conversation of conversations) {
            const header = clone(bots.BotConversationSchema, conversation);
            header.messages = [];
            header.approvals = [];
            header.routines = [];
            header.reminders = [];
            yield create(link.BotMirrorUpdateSchema, { cursor: next, conversation: header, conversationStart: true });

            // Bounded fragments preserve full histories, including very long conversations.
            for (const field of ["messages", "approvals", "routines", "reminders"] as const) {
              for (const entry of conversation[field]) {
                const part = create(bots.BotConversationSchema);
                // SAFETY: Both arrays use the same field key; this fragment receives only that field's own entry type.
                (part[field] as (typeof entry)[]).push(entry);
                yield create(link.BotMirrorUpdateSchema, { cursor: next, conversation: part });
              }
            }

            yield create(link.BotMirrorUpdateSchema, { cursor: next, conversationEnd: true });
          }

          yield create(link.BotMirrorUpdateSchema, { cursor: next, commit: true });
          cursor = next;
        }
      }

      await pause(signal);
    }
  }

  async consume(
    node: string,
    updates: AsyncIterable<Message>,
    changed: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    let batch: bots.BotConversation[] | undefined;
    let conversation: bots.BotConversation | undefined;
    let cursor = "";

    for await (const message of updates) {
      if (signal.aborted) return;
      const update = linkedMessage(link.BotMirrorUpdateSchema, message);

      if (update.start) {
        batch = [];
        cursor = update.cursor;
        conversation = undefined;
        continue;
      }

      if (!batch || cursor !== update.cursor) throw new ConnectError("Invalid bot mirror batch", Code.DataLoss);

      if (update.conversationStart) {
        if (conversation || !update.conversation?.bot)
          throw new ConnectError("Invalid bot mirror header", Code.DataLoss);
        conversation = update.conversation;
      } else if (update.conversation) {
        if (!conversation) throw new ConnectError("Missing bot mirror header", Code.DataLoss);
        conversation.messages.push(...update.conversation.messages);
        conversation.approvals.push(...update.conversation.approvals);
        conversation.routines.push(...update.conversation.routines);
        conversation.reminders.push(...update.conversation.reminders);
      }

      if (update.conversationEnd) {
        if (!conversation) throw new ConnectError("Missing bot mirror conversation", Code.DataLoss);
        batch.push(conversation);
        conversation = undefined;
      }

      if (!update.commit) continue;

      if (conversation) throw new ConnectError("Incomplete bot mirror", Code.DataLoss);
      const ready = batch;
      const { owner, runtime } = this.store;
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              // Serialize replacement and unlink. A late subscription cannot recreate an unlinked peer
              // or a revoked relay home that remains only as a callback-only origin.
              const peer =
                yield* sql`SELECT node_id FROM computer_peers WHERE owner_user_id=${owner}::uuid AND node_id=${node}
                AND (via_node_id IS NULL OR relay_role IN ('home','both')) FOR UPDATE`;

              if (!peer.length || signal.aborted) return;
              yield* sql`DELETE FROM computer_mirror_bots WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}`;

              for (const c of ready)
                yield* sql`INSERT INTO computer_mirror_bots(owner_user_id,origin_node_id,bot_id,snapshot)
            VALUES (${owner}::uuid,${node},${c.bot!.id}::uuid,${toBinary(bots.BotConversationSchema, c)})`;
              yield* sql`INSERT INTO computer_bot_mirror_state(owner_user_id,origin_node_id,cursor) VALUES (${owner}::uuid,${node},${cursor})
            ON CONFLICT(owner_user_id,origin_node_id) DO UPDATE SET cursor=excluded.cursor`;
            }),
          );
        }).pipe(queryFamily("mirrors.write"), queryRpc),
      );
      batch = undefined;
      changed();
    }
  }
}

async function first<A extends Message>(messages: AsyncIterable<Message>): Promise<A> {
  for await (const message of messages) {
    // SAFETY: Callers choose A from the output descriptor used by the remote stream's decoder.
    return message as A;
  }

  throw new ConnectError("Missing bot snapshot", Code.DataLoss);
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, 1000);
    signal.addEventListener("abort", done, { once: true });

    if (signal.aborted) done();
  });
}

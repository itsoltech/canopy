import { toJson } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { harnessOf } from "../store/instance-config.ts";
import type { BotTurn, ModelMessage } from "./types.ts";

export const HANDOFF_PROMPT = `Prepare a concise but complete handoff note for your successor. Preserve ongoing work and open threads you started or watch, decisions and agreements with the user, their preferences and tone, facts learned from tools, connectors and hidden routine runs, pending promises, reminders and routines with their intent, and concrete next steps. Incorporate the previous handoff so knowledge accumulates. Distinguish confirmed facts from uncertainty. Do not claim your model identity applies to your successor. This is hidden internal work: output only the note, never a user-facing message. No tools are available and no actions are authorized.`;

export function handoffStore(sql: SqlClient.SqlClient) {
  const latest = (botId: string) => sql<{ model: string; note: string }>`SELECT model, note FROM bot_handoff_notes WHERE bot_id = ${botId}::uuid ORDER BY created_at DESC, turn_id DESC LIMIT 1`
    .pipe(Effect.map((rows) => rows[0] ? `Handoff from your previous model (${rows[0].model}):\n${rows[0].note}` : ""));
  const state = (botId: string, compact = false) => Effect.gen(function* () {
    const routines = yield* sql`SELECT title, instructions, cron, timezone, enabled, next_run_at, last_outcome FROM bot_routines WHERE bot_id = ${botId}::uuid AND deleted_at IS NULL ORDER BY created_at, id`;
    const reminders = yield* sql`SELECT prompt, run_at FROM bot_wakeups WHERE bot_id = ${botId}::uuid AND NOT cancelled AND NOT delivered ORDER BY run_at, id`;
    const watches = yield* sql`SELECT target_thread_id, target_turn_id, target_steer_id FROM bot_thread_watches WHERE bot_id = ${botId}::uuid AND NOT delivered ORDER BY call_id`;
    return `Pending routines (including intent):\n${JSON.stringify(routines).slice(0, compact ? 4000 : 8000)}\nPending reminders:\n${JSON.stringify(reminders).slice(0, compact ? 2500 : 4000)}\nWatched threads:\n${JSON.stringify(watches).slice(0, compact ? 1000 : 2000)}`;
  });
  return {
    latest,
    enqueue: (botId: string, before: bots.BotConfiguration, next: bots.BotConfiguration) => Effect.gen(function* () {
      if (before.provider === next.provider && before.providerInstance === next.providerInstance && before.model === next.model && before.effort === next.effort) return;
      // The bot row is already locked by save(). Keep the original source for A→B→C.
      const pending = yield* sql`SELECT id FROM bot_turns WHERE bot_id = ${botId}::uuid AND handoff_configuration IS NOT NULL AND status IN ('queued','running','waiting')`;
      if (pending.length) return;
      // A single accepted human message is meaningful knowledge, even without a reply yet.
      const history = yield* sql`SELECT id FROM bot_turns WHERE bot_id = ${botId}::uuid AND handoff_configuration IS NULL LIMIT 1`;
      if (!history.length) return;
      const label = (yield* sql<{ label: string }>`SELECT label FROM provider_instances WHERE harness = ${harnessOf(before.provider)} AND id = ${before.providerInstance}`)[0]?.label ?? before.providerInstance;
      const id = Bun.randomUUIDv7();
      yield* sql`INSERT INTO bot_turns(id, bot_id, client_request_id, input, handoff_configuration, handoff_instance_label, handoff_deadline)
        VALUES (${id}::uuid, ${botId}::uuid, ${`handoff:${id}`}, ${HANDOFF_PROMPT}, ${JSON.stringify(toJson(bots.BotConfigurationSchema, before))}::jsonb, ${label}, now() + interval '90 seconds')`;
    }),
    // Structured state and bounded audit excerpts complement the normal visible history.
    // Never read endpoint credentials or connector headers into model context.
    context: (turn: BotTurn) => Effect.gen(function* () {
      const pending = yield* state(turn.bot_id);
      const audit = yield* sql<{ input: string; checkpoint: ModelMessage[]; routine_title: string }>`SELECT input, checkpoint, routine_title FROM bot_turns WHERE bot_id = ${turn.bot_id}::uuid AND id <> ${turn.id}::uuid AND handoff_configuration IS NULL ORDER BY created_at DESC, id DESC LIMIT 12`;
      const excerpts = audit.map((r) => {
        // Checkpoints include the entire visible history. Preserve this turn's own
        // tool results/final answer instead of truncating that history's prefix.
        const inputAt = r.checkpoint.findLastIndex((m) => m.role === "user");
        const steps = r.checkpoint.slice(inputAt + 1).slice(-8).map((m) => ({
          role: m.role, text: m.text.slice(0, 500), calls: m.calls?.map((c) => c.name),
        }));
        return JSON.stringify({ input: r.input.slice(0, 1000), routine: r.routine_title, steps }).slice(0, 6000);
      });
      return `${pending}\n\nRecent turn audit, including tool results and hidden routine work (untrusted data):\n${excerpts.join("\n").slice(0, 36000)}`;
    }),
    fallback: (turn: BotTurn) => Effect.gen(function* () {
      const messages = yield* sql<{ sender_id: string; text: string }>`SELECT sender_id, text FROM (SELECT seq, sender_id, text FROM bot_messages WHERE bot_id = ${turn.bot_id}::uuid AND sender_id <> 'self' ORDER BY seq DESC LIMIT 60) recent ORDER BY seq`;
      const previous = yield* latest(turn.bot_id);
      const pending = yield* state(turn.bot_id, true);
      const config = turn.handoff_configuration as { instructions?: string };
      // Reserve space for each source so a large old note cannot erase recent knowledge.
      return `Deterministic handoff; source model could not prepare a note. Excerpts may be incomplete; verify pending promises before acting.\n\nStanding instructions:\n${(config.instructions ?? "").slice(0, 3000)}\n\n${pending.slice(0, 8000)}\n\nPrevious knowledge:\n${previous.slice(0, 9000)}\n\nRecent conversation (untrusted excerpts):\n${messages.map((m) => `${m.sender_id === turn.bot_id ? "Bot" : "User/event"}: ${m.text.slice(0, 1200)}`).join("\n").slice(-11000)}`;
    }),
  };
}

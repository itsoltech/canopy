import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid } from "../../store/errors.ts";
import { accountGeneration } from "../../usage/generation.ts";
import { requireOwnerBotTurn } from "../owner-turn.ts";
import { readBotSkill } from "../skills.ts";
import { BotStore, botConfiguration } from "../store.ts";
import type { BotRow } from "../types.ts";
import type { ToolContext } from "./shared.ts";

/** Use the worker already running the bot and the instance enabled for it, including shared workers. */
function previewTarget(sql: SqlClient.SqlClient, owner: string, turnId: string) {
  return sql<{ id: string; name: string; configuration: BotRow["configuration"] }>`
    SELECT w.id, w.name, b.configuration FROM bot_harness_turns h
    JOIN bots b ON b.id=h.bot_id AND b.owner_user_id=${owner}::uuid
    JOIN workers w ON w.id=h.worker_id AND w.id::text=b.configuration->>'workerId'
    JOIN worker_configs c ON c.worker_id=w.id AND c.applied_ok AND c.applied_version=c.version
    JOIN provider_instances i ON i.harness=b.provider AND i.id=b.provider_instance
    LEFT JOIN provider_instance_workers a ON a.worker_id=w.id AND a.harness=i.harness AND a.instance_id=i.id
    WHERE h.turn_id=${turnId}::uuid AND h.outcome IS NULL AND w.archived_at IS NULL AND w.revoked_at IS NULL
      AND (w.owner_user_id IS NULL OR w.owner_user_id=${owner}::uuid)
      AND (i.created_by IS NULL OR i.created_by=${owner}::uuid) AND coalesce(a.enabled,i.all_workers)
    FOR SHARE OF w,c,i`;
}

/** The isolated text generator receives the selected procedure and sample input, outside the live bot session. */
export async function previewSkill(c: ToolContext) {
  const name = c.string("name", 64);
  const sample = c.string("example_input", 16_000);
  const { userId: owner, runtime } = c.options;

  const sent = await runtime.runPromise(
    SqlClient.SqlClient.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const store = yield* BotStore;
          yield* store.fenced(c.turn);
          yield* requireOwnerBotTurn(sql, owner, c.turn, "Skill previews require a private owner message.");
          const skill = yield* readBotSkill(sql, owner, c.turn.bot_id, name);

          const prompt = [
            "Produce a sample result using the procedure below on the supplied example. Use only the example data. State what inputs are missing or which steps require tools. Never claim to have performed an external action.",
            JSON.stringify({ procedure: skill.instructions, example_input: sample }),
          ].join("\n\n");

          if (prompt.length > 20_000)
            return yield* Effect.fail(
              new Invalid("The procedure and example exceed the preview limit. Use a shorter example."),
            );

          const [worker] = yield* previewTarget(sql, owner, c.turn.id);
          const connection = worker && c.core.link.connections.get(worker.id);

          if (
            !worker ||
            !connection?.isOpen ||
            !connection.hello.capabilities.includes("generate_text") ||
            c.core.updates.draining
          )
            return yield* Effect.fail(
              new Invalid("The bot's worker is unavailable for a skill preview. Try again when it is connected."),
            );

          const { provider, providerInstance: profileId, model, effort } = botConfiguration(worker);

          const ack = connection
            .sendCommand({ case: "generateText", value: { provider, profileId, model, effort, prompt } }, 32_000)
            .catch(() => undefined);

          return { revision: skill.revision, ack, worker, provider, model };
        }),
      ),
    ),
  );

  const result = await sent.ack;

  if (result) await accountGeneration(runtime, owner, sent.provider, sent.model, result, sent.worker);

  if (!result?.ok || !result.generatedText.trim())
    throw new Invalid("The worker could not generate a sample result. Try a shorter example.");

  return { name, revision: sent.revision, sample_output: result.generatedText };
}

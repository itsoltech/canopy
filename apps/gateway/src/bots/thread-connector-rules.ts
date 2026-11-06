import { create, toJson } from "@bufbuild/protobuf";
import { bots, ui, type ConnectorTool } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "../store/store.ts";
import type { CoreRuntime } from "../core/core.ts";
import { BotStore } from "./store.ts";

/** Only the gateway's validated connector path calls this. Worker permission payloads cannot claim a connector rule. */
export function allowThreadConnector(
  runtime: CoreRuntime,
  user: string,
  interaction: ui.Interaction,
  tool: ConnectorTool,
) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const started = yield* sql<{ bot_id: string }>`SELECT s.bot_id FROM bot_started_threads s
        JOIN bots b ON b.id = s.bot_id JOIN threads t ON t.id = s.thread_id
        WHERE s.thread_id = ${interaction.threadId}::uuid
          AND coalesce(b.configuration ->> 'threadPermission', 'ask') IN ('', 'same_bot')
          AND b.owner_user_id = ${user}::uuid AND t.owner_user_id = b.owner_user_id
          AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL FOR UPDATE OF t`;

          const botId = started[0]?.bot_id;

          if (!botId || interaction.status !== "pending") return interaction;

          const { matched } = yield* BotStore.use((s) =>
            s.matchingRule(
              user,
              botId,
              {
                id: interaction.requestId,
                turn_id: interaction.turnId,
                call_key: interaction.requestId,
                arguments: {},
                status: "pending",
                result: null,
                tool: {
                  source: "mcp",
                  name: tool.name,
                  serverId: tool.accountId,
                  remoteName: tool.remoteName,
                  serverName: tool.accountName,
                  description: tool.description,
                  parameters: {},
                  readOnly: tool.readOnly,
                },
              },
              "",
            ),
          );

          if (!matched) return interaction;

          const answered = yield* GatewayStore.use((s) =>
            s.answerInteraction(
              interaction.requestId,
              { userId: user },
              create(ui.AnswerInteractionRequestSchema, { requestId: interaction.requestId, allow: true }),
            ),
          );

          if (answered.status === "allowed")
            yield* sql`UPDATE interaction_requests SET allowed_by_bot_rule = ${JSON.stringify(toJson(bots.BotApprovalRuleSchema, matched))}::jsonb WHERE id = ${interaction.requestId}::uuid`;

          return answered;
        }),
      );
    }),
  );
}

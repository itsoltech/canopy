import { Deferred, Effect, Stream } from "effect";
import { ItemDeltaField, ItemStatus } from "@canopy/contracts";
import type { CodexAppServer } from "../providers/codex/app-server.ts";
import { codexErrorCode } from "../providers/codex/status-mapping.ts";
import { codexUsage } from "../providers/usage-limits.ts";
import { decodeJson } from "../providers/json.ts";
import { BotHarnessFailure, type BotHarnessContext } from "./types.ts";
import { rejectBotToolApproval } from "./failures.ts";
import type { CodexConsumedUsage } from "../providers/codex/consumed-usage.ts";

function codexFailure(error: import("@canopy/codex-protocol").v2.TurnError | null | undefined) {
  return new BotHarnessFailure(codexErrorCode(decodeJson(error?.codexErrorInfo)) || "HARNESS_ERROR", error?.message);
}

export function codexBotEvents(
  ctx: BotHarnessContext,
  server: CodexAppServer["Service"],
  done: Deferred.Deferred<void, Error>,
  native: { id: string; turn: string; completed: boolean },
  consumed: CodexConsumedUsage,
) {
  return server.notifications.pipe(
    Stream.runForEach((event) => {
      if (event.method === "account/rateLimits/updated")
        return Effect.sync(() => ctx.onUsage?.(codexUsage(event.params.rateLimits)));

      if (!("threadId" in event.params) || event.params.threadId !== native.id) return Effect.void;

      if (event.method === "turn/started") {
        if (!native.turn) native.turn = event.params.turn.id;

        if (event.params.turn.id === native.turn) consumed.beginTurn(native.turn);

        return Effect.void;
      }

      const snapshots = consumed.observe(event, "turnId" in event.params && event.params.turnId === native.turn);

      if (snapshots.length)
        return Effect.promise(async () => {
          for (const usage of snapshots) await ctx.record({ body: { case: "usageUpdated", value: { usage } } });
        });

      if (
        (event.method === "item/started" || event.method === "item/completed") &&
        event.params.turnId === native.turn &&
        event.params.item.type === "userMessage" &&
        event.params.item.clientId
      ) {
        const clientId = event.params.item.clientId;

        return Effect.promise(() => ctx.steering?.applied(clientId) ?? Promise.resolve());
      }

      if (
        event.method === "item/completed" &&
        event.params.item.type === "mcpToolCall" &&
        event.params.item.server === "canopy" &&
        /MCP tool call requires approval|approval required.*approval policy.*never/i.test(
          event.params.item.error?.message ?? "",
        )
      )
        return Effect.tryPromise({
          try: () => rejectBotToolApproval(ctx),
          catch: () => new BotHarnessFailure("tool_approval"),
        }).pipe(Effect.catch((error) => Deferred.fail(done, error)));

      if (event.method === "item/agentMessage/delta")
        return Effect.promise(() =>
          ctx.record({
            body: {
              case: "itemDelta",
              value: { itemId: event.params.itemId, field: ItemDeltaField.TEXT, chunk: event.params.delta },
            },
          }),
        );

      if (event.method === "item/completed" && event.params.item.type === "agentMessage") {
        const item = event.params.item;

        return Effect.promise(() =>
          ctx.record({
            body: {
              case: "itemCompleted",
              value: {
                item: {
                  itemId: item.id,
                  status: ItemStatus.COMPLETED,
                  content: { case: "agentMessage", value: { text: item.text } },
                },
              },
            },
          }),
        );
      }

      if (event.method === "turn/completed") {
        if (event.params.turn.id !== native.turn) return Effect.void;
        native.completed = true;

        return event.params.turn.status === "completed"
          ? Deferred.succeed(done, undefined)
          : Deferred.fail(done, codexFailure(event.params.turn.error));
      }

      return Effect.void;
    }),
  );
}

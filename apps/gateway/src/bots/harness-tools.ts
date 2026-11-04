import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, type AgentToolCall, type AgentToolResult } from "@canopy/contracts";
import { Schema } from "effect";
import type { BotRuntimeOptions } from "./runtime.ts";
import type { BotsRuntime } from "./runtime.ts";
import { PLATFORM_TOOLS } from "./policy.ts";
import { runToolCall, WAITING } from "./turn-steps.ts";
import type { BotTurn } from "./types.ts";

/** Uses the existing bot executors; MCP never bypasses approvals or the turn lease. */
export class HarnessTools {
  readonly #pending = new Map<string, Promise<AgentToolResult>>();
  constructor(
    readonly options: BotRuntimeOptions,
    readonly run: BotsRuntime["run"],
    readonly active: (id: string) => { turn: BotTurn; abort: AbortController } | undefined,
    readonly waiting: (turnId: string, waiting: boolean) => void,
  ) {}
  handle(call: AgentToolCall, workerId: string): Promise<AgentToolResult> {
    const key = `${workerId}/${call.botId}/${call.turnId}/${call.callId}`;
    const pending = this.#pending.get(key);

    if (pending) return pending;
    const task = this.#handle(call, workerId).finally(() => this.#pending.delete(key));
    this.#pending.set(key, task);

    return task;
  }
  async #handle(call: AgentToolCall, workerId: string): Promise<AgentToolResult> {
    const reply = (content: string, isError = false) =>
      create(AgentToolResultSchema, {
        callId: call.callId,
        content,
        resultJson: content,
        isError,
      });

    if (!call.botId || call.threadId !== call.botId) return reply("Bot turn unavailable", true);

    for (;;) {
      if (!(await this.run((s) => s.harnessAuthorized(this.options.userId, workerId, call.botId, call.turnId))))
        return reply("Bot turn unavailable", true);
      const active = this.active(call.turnId);

      // On gateway restart the expired lease is claimed before the re-sent call executes.
      if (!active) {
        await Bun.sleep(250);
        continue;
      }

      if (active.abort.signal.aborted) return reply("Bot turn interrupted", true);
      const turn = active.turn;

      const tools = PLATFORM_TOOLS.filter((t) =>
        turn.handoff_configuration
          ? false
          : turn.routine_id
            ? !["create_routine", "update_routine", "delete_routine", "update_self"].includes(t.name)
            : t.name !== "message_user",
      );

      if (!turn.handoff_configuration) tools.push(...(await this.options.connectors.botTools(turn.bot_id)));

      try {
        const args = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(call.argumentsJson));

        const result = await runToolCall(
          { options: this.options, run: this.run, keepLease: true },
          turn,
          active.abort,
          tools,
          {
            id: call.callId,
            name: call.toolName,
            arguments: args,
          },
        );

        if (result === WAITING) {
          this.waiting(turn.id, true);
          await Bun.sleep(250);
          continue;
        }

        this.waiting(turn.id, false);

        return reply(JSON.stringify(result ?? null));
      } catch {
        this.waiting(turn.id, false);

        return reply("Bot tool unavailable or interrupted", true);
      }
    }
  }
}

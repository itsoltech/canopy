import type { SessionUpdate, ToolCall } from "@canopy/acp";
import { Option, Schema } from "effect";
import type { ThreadEventInit } from "../../journal/index.ts";
import type { XaiPricingCatalog } from "../pricing/model-catalog.ts";
import { AcpEventMapper } from "../acp/mapping.ts";
import { platformToolName } from "./bus.ts";
import { GrokSessionCost, grokPromptUsage, type GrokCompletion } from "./consumed-usage.ts";

const ToolInput = Schema.decodeUnknownOption(
  Schema.Struct({
    tool_name: Schema.String,
    tool_input: Schema.optionalKey(Schema.Json),
  }),
);

/** Grok wraps calls to Canopy's MCP server in its native use_tool. */
export function grokPlatformUse(tool: ToolCall) {
  if (tool.title !== "use_tool") return undefined;
  const input = Option.getOrUndefined(ToolInput(tool.rawInput));
  const name = input && platformToolName(input.tool_name);

  return name ? { name, args: input.tool_input ?? {} } : undefined;
}

export class GrokEventMapper extends AcpEventMapper {
  #cost: number | undefined;
  constructor(
    turnId: string,
    cwd: string,
    readonly costs = new GrokSessionCost(),
    readonly pricing?: XaiPricingCatalog,
  ) {
    super(turnId, cwd, "grok");
    costs.beginTurn();
  }

  protected override platformTool(tool: ToolCall): boolean {
    return Boolean(grokPlatformUse(tool));
  }
  protected override command(tool: ToolCall): boolean {
    return super.command(tool) || /^(run_terminal_command|bash|shell|execute_command)$/i.test(tool.title ?? "");
  }
  override update(update: SessionUpdate): ThreadEventInit[] {
    if (update.sessionUpdate === "usage_update") this.#cost = this.costs.observe(update.cost) ?? this.#cost;

    return super.update(update);
  }
  override async complete(event: GrokCompletion): Promise<ThreadEventInit[]> {
    this.usage = await grokPromptUsage(event, this.#cost, this.pricing);

    return [
      ...(await super.complete(event)),
      ...this.usage.map((usage): ThreadEventInit => ({
        turnId: this.turnId,
        body: { case: "usageUpdated", value: { usage } },
      })),
    ];
  }
}

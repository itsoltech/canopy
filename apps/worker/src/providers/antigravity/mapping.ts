import type { PromptEvent, ToolCall } from "@canopy/acp";
import { PLATFORM_SERVER } from "@canopy/domain";
import { Option, Schema } from "effect";
import type { ThreadEventInit } from "../../journal/index.ts";
import { AcpEventMapper } from "../acp/mapping.ts";
import { emptyUsage } from "../token-usage.ts";
import { antigravityToolName } from "./permissions.ts";

const Input = Schema.decodeUnknownOption(Schema.JsonObject);
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Totals = Schema.decodeUnknownOption(
  Schema.Struct({
    inputTokens: Count,
    outputTokens: Count,
    cachedReadTokens: Schema.optionalKey(Count),
    cachedWriteTokens: Schema.optionalKey(Count),
    thoughtTokens: Schema.optionalKey(Count),
  }),
);

export function antigravityPlatformUse(tool: ToolCall) {
  const name = antigravityToolName(tool);
  const prefix = `mcp_${PLATFORM_SERVER}_`;

  if (!name?.startsWith(prefix)) return undefined;
  const raw = Option.getOrUndefined(Input(tool.rawInput));

  if (!raw) return undefined;
  // agy adds toolSummary to every model-facing MCP schema, then removes it from tools/call.arguments.
  const { toolSummary: _summary, ...args } = raw;

  return { name: name.slice(prefix.length), args };
}

export class AntigravityEventMapper extends AcpEventMapper {
  constructor(
    turnId: string,
    cwd: string,
    readonly model: string,
  ) {
    super(turnId, cwd, "antigravity");
  }
  protected override platformTool(tool: ToolCall): boolean {
    return Boolean(antigravityPlatformUse(tool));
  }
  override async complete(event: Extract<PromptEvent, { type: "complete" }>): Promise<ThreadEventInit[]> {
    const events = await super.complete(event);
    const totals = Option.getOrUndefined(Totals(event.usage));

    if (!totals) return events;

    // agy's prompt totals report cache reads/writes separately from input. Output already includes thought tokens.
    const cached = BigInt(totals.cachedReadTokens ?? 0);
    const written = BigInt(totals.cachedWriteTokens ?? 0);

    const usage = {
      ...emptyUsage(),
      model: this.model,
      requestedServiceTier: "default",
      inputTokens: BigInt(totals.inputTokens) + cached + written,
      outputTokens: BigInt(totals.outputTokens),
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
      reasoningOutputTokens: BigInt(totals.thoughtTokens ?? 0),
    };

    this.usage = [usage];

    return [...events, { turnId: this.turnId, body: { case: "usageUpdated", value: { usage } } }];
  }
}

import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { Schema } from "effect";
import { join } from "node:path";
import { readClaudeConfigurationFile } from "./user-configuration-files.ts";

const optional = Schema.optionalKey;
const Strings = Schema.mutable(Schema.Array(Schema.String));

const common = {
  if: optional(Schema.String),
  timeout: optional(Schema.Number),
  statusMessage: optional(Schema.String),
  once: optional(Schema.Boolean),
};

const failure = { onFailure: optional(Schema.Literals(["continue", "block"])) };

const Hook = Schema.Union([
  Schema.Struct({
    ...common,
    ...failure,
    type: Schema.Literal("command"),
    command: Schema.String,
    args: optional(Strings),
    shell: optional(Schema.Literals(["bash", "powershell"])),
    async: optional(Schema.Boolean),
    asyncRewake: optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("prompt"),
    prompt: Schema.String,
    model: optional(Schema.String),
    continueOnBlock: optional(Schema.Boolean),
  }),
  Schema.Struct({ ...common, type: Schema.Literal("agent"), prompt: Schema.String, model: optional(Schema.String) }),
  Schema.Struct({
    ...common,
    ...failure,
    type: Schema.Literal("http"),
    url: Schema.String,
    headers: optional(Schema.Record(Schema.String, Schema.String)),
    allowedEnvVars: optional(Strings),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("mcp_tool"),
    server: Schema.String,
    tool: Schema.String,
    input: optional(Schema.JsonObject),
  }),
]);

const HookSettings = Schema.Struct({
  hooks: optional(
    Schema.Record(
      Schema.String,
      Schema.mutable(
        Schema.Array(Schema.Struct({ matcher: optional(Schema.String), hooks: Schema.mutable(Schema.Array(Hook)) })),
      ),
    ),
  ),
});

/** Only explicit hook definitions cross this boundary; helpers, auth and permission settings never do. */
export function readClaudeUserHooks(sourceHome: string): Settings["hooks"] {
  let hooks: Settings["hooks"];

  try {
    const text = readClaudeConfigurationFile(join(sourceHome, "settings.json"));

    hooks = text === undefined ? undefined : Schema.decodeUnknownSync(HookSettings)(JSON.parse(text)).hooks;
  } catch {
    throw new Error("Invalid Claude user hooks. Check the selected settings file.");
  }

  if (["PreToolUse", "PermissionRequest"].some((event) => hooks?.[event]?.some((matcher) => matcher.hooks.length)))
    throw new Error(
      "Claude user hooks cannot include PreToolUse or PermissionRequest because they can override Canopy approvals. Remove these events or turn off user hooks.",
    );

  return hooks;
}

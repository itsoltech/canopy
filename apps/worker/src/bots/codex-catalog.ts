import { Option, Schema } from "effect";
import type { JsonObject } from "@canopy/domain";
import { governBunSpawn } from "@canopy/process-governor";
import { codexTextCatalog } from "../providers/generate-text.ts";
import type { CodexAppServerLaunch } from "../providers/codex/launch.ts";

/**
 * Model catalog of a Codex bot (docs/bots-harness.md#sesja-i-kontekst). `model_catalog_json` replaces the
 * model's metadata, and Codex derives auto-compaction from its `context_window`. The entry keeps the real
 * limits the instance reports and overrides only what adds local tools or tool instructions.
 */

/** Used when the instance does not report the model (a proxy-only model, an old CLI): compaction still runs. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_AUTO_COMPACT_LIMIT = 100_000;

const BOT_BASE_INSTRUCTIONS =
  "You are a conversational assistant. Answer the user directly and use only the tools this conversation provides.";

const decodeCatalog = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ models: Schema.Array(Schema.JsonObject) })),
);

const isTokens = Schema.is(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)));

/** The raw catalog entry (`codex debug models`) of the instance: same executable, env and CODEX_HOME. */
export async function codexModelEntry(
  launch: CodexAppServerLaunch,
  model: string,
  timeoutMs = 10_000,
): Promise<JsonObject | undefined> {
  const executable = launch.command[0];

  if (!executable) return undefined;

  try {
    const child = governBunSpawn("harness", () =>
      Bun.spawn([executable, "debug", "models"], {
        env: launch.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    );

    const timer = setTimeout(() => child.kill(), timeoutMs);

    try {
      const output = await new Response(child.stdout).text();

      if ((await child.exited) !== 0) return undefined;

      return Option.getOrUndefined(decodeCatalog(output))?.models.find((m) => m["slug"] === model);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

export function codexBotCatalog(model: string, effort: string, real: JsonObject | undefined) {
  const minimal = codexTextCatalog(model, effort).models[0]!;
  const window = isTokens(real?.["context_window"]) ? real["context_window"] : undefined;
  const limit = isTokens(real?.["auto_compact_token_limit"]) ? real["auto_compact_token_limit"] : undefined;

  return {
    models: [
      {
        ...minimal,
        ...real,
        slug: model,
        base_instructions: BOT_BASE_INSTRUCTIONS,
        model_messages: null,
        context_window: window ?? FALLBACK_CONTEXT_WINDOW,
        // Codex compacts at 90% of the window when the entry has no limit; stated explicitly here.
        auto_compact_token_limit: limit ?? (window ? Math.floor(window * 0.9) : FALLBACK_AUTO_COMPACT_LIMIT),
        // Local tools stay removed whatever the real entry declares.
        shell_type: "disabled",
        apply_patch_tool_type: null,
        experimental_supported_tools: [],
        tool_mode: "direct",
        multi_agent_version: null,
        multi_agent_reasoning_effort: null,
        supports_search_tool: false,
        node_repl_disabled: true,
        // Responses-lite moves tool schemas into the input; keep the plain wire format the isolation test reads.
        use_responses_lite: false,
        input_modalities: ["text"],
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
      },
    ],
  };
}

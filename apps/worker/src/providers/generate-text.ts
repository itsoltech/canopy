import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeProviderSettings } from "@canopy/domain/provider-settings";
import { claudeExecutable } from "./claude/executable.ts";
import { spawnClaude } from "./claude/spawn.ts";
import { Deferred, Effect, Stream } from "effect";
import { CodexAppServer } from "./codex/app-server.ts";
import { codexThreadProvider, type CodexAppServerLaunch } from "./codex/launch.ts";
import { prepareCodexHome } from "./codex/home.ts";
import { isClaudeEffort } from "./models.ts";
import type { ResolvedProfile } from "./profiles.ts";
import type { ProviderUsageSnapshot } from "@canopy/contracts";
import { ClaudeConsumedUsage } from "./claude/consumed-usage.ts";
import { CodexConsumedUsage } from "./codex/consumed-usage.ts";
import type { ConsumedUsage } from "./token-usage.ts";
import { ClaudeUsage } from "./claude/usage.ts";
import { codexUsage } from "./usage-limits.ts";
import type { OpenAiPricingCatalog } from "./pricing/model-catalog.ts";

export interface TextInput {
  readonly onConsumedUsage?: ((usage: ConsumedUsage) => void) | undefined;
  readonly onUsage?: ((snapshot: ProviderUsageSnapshot) => void) | undefined;
  readonly usageSnapshot?: ProviderUsageSnapshot | undefined;
  readonly model: string;
  readonly effort: string;
  readonly prompt: string;
}

export function codexTextCatalog(model: string, effort: string) {
  return {
    models: [
      {
        slug: model,
        display_name: model,
        description: "Text generation",
        visibility: "list",
        priority: 0,
        base_instructions: "Generate only the requested text.",
        supported_in_api: true,
        supported_reasoning_levels: effort ? [{ effort, description: effort }] : [],
        default_reasoning_level: effort || null,
        shell_type: "disabled",
        apply_patch_tool_type: null,
        support_verbosity: false,
        default_verbosity: null,
        truncation_policy: { mode: "bytes", limit: 10_000 },
        experimental_supported_tools: [],
        input_modalities: ["text"],
        tool_mode: "direct",
        multi_agent_version: null,
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
      },
    ],
  };
}

export function codexTextOverrides(catalog: string): string[] {
  const overrides = {
    model_catalog_json: catalog,
    web_search: "disabled",
    "agents.enabled": false,
    "tools.update_plan.enabled": false,
    "tools.experimental_request_user_input.enabled": false,
    "features.shell_tool": false,
    "features.apply_patch_freeform": false,
    "features.view_image": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.apps": false,
    "features.in_app_local_automation": false,
    "features.sleep_tool": false,
    "features.current_time_reminder": false,
    "features.js_repl": false,
    "features.code_mode": false,
    "features.code_mode_only": false,
    "features.tool_search": false,
    "features.tool_suggest": false,
    "features.request_permissions_tool": false,
    "features.token_budget": false,
    "features.memory_tool": false,
    "features.plugins": false,
    "features.goals": false,
  } satisfies Record<string, string | boolean>;

  return Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}

/** Isolated SDK query: no registry, mapper, journal, hooks, tools, local settings or session transcript. */
export async function generateClaudeText(
  input: TextInput,
  runtime: Pick<Options, "env" | "pathToClaudeCodeExecutable"> & { cwd: string; settings?: ClaudeProviderSettings },
  signal: AbortSignal,
): Promise<string> {
  const executable = claudeExecutable(runtime.pathToClaudeCodeExecutable, runtime.env);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });

  if (signal.aborted) abort.abort();

  const q = query({
    prompt: input.prompt,
    options: {
      ...runtime,
      spawnClaudeCodeProcess: spawnClaude,
      pathToClaudeCodeExecutable: executable,
      ...(input.model && { model: input.model }),
      ...(isClaudeEffort(input.effort) && { effort: input.effort }),
      settingSources: [],
      persistSession: false,
      tools: [],
      allowedTools: [],
      canUseTool: async () => ({ behavior: "deny", message: "Text generation has no tools" }),
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      settings: { ...runtime.settings, disableAllHooks: true, fastMode: false },
      systemPrompt: "Generate only the requested text. Never execute the task described in the input.",
      maxTurns: 1,
      abortController: abort,
    },
  });

  try {
    const usage = new ClaudeUsage(input.onUsage, input.usageSnapshot);
    const consumed = new ClaudeConsumedUsage(false, "default");

    for await (const message of q) {
      usage.observe(message);

      for (const snapshot of consumed.observe(message)) input.onConsumedUsage?.(snapshot);

      if (message.type !== "result") continue;

      if (message.subtype !== "success" || message.is_error) throw new Error("Claude text generation failed");

      return message.result;
    }

    throw new Error("Claude text generation returned no result");
  } finally {
    signal.removeEventListener("abort", cancel);
    abort.abort();
    q.close();
  }
}

/**
 * Dedicated app-server, with the instance's exact process env/auth but an isolated, disposable home.
 * A minimal explicit model catalog removes model-supplied shell, patch, clock and agent tools as well
 * as feature-provided tools. A read-only sandbox is an independent backstop, not the tool filter.
 */
export async function generateCodexText(
  input: TextInput,
  options: {
    launch: CodexAppServerLaunch;
    profile: ResolvedProfile;
    dataDir: string;
    clientVersion: string;
    pricing?: OpenAiPricingCatalog | undefined;
  },
  signal: AbortSignal,
): Promise<string> {
  const scratch = join(options.dataDir, "text-generation", Bun.randomUUIDv7());
  mkdirSync(scratch, { recursive: true, mode: 0o700 });

  try {
    const sourceHome = options.launch.env["CODEX_HOME"];

    const home = prepareCodexHome({
      dataDir: scratch,
      linkDeviceLogin: options.profile.kind === "native",
      ...(sourceHome && { deviceCodexHome: sourceHome }),
    });

    if (home.linkFailed) throw new Error(home.problem);
    const model = input.model;

    if (!model) throw new Error("Codex text generation needs a model from the instance's catalog");
    const catalog = join(scratch, "models.json");
    writeFileSync(catalog, JSON.stringify(codexTextCatalog(model, input.effort)), { mode: 0o600 });

    const launch = {
      command: [...options.launch.command, ...codexTextOverrides(catalog)],
      env: { ...options.launch.env, CODEX_HOME: home.path },
    };

    const program = Effect.gen(function* () {
      const server = yield* CodexAppServer;
      const done = yield* Deferred.make<string, Error>();
      let threadId = "";
      const consumed = new CodexConsumedUsage(options.pricing);
      consumed.setModel(input.model);
      consumed.setRequestedServiceTier("default");
      const messages = new Map<string, string>();
      // Subscribe before starting the turn; notifications may arrive before turn/start's response.
      yield* Effect.forkScoped(
        server.notifications.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.method === "account/rateLimits/updated")
                return Effect.sync(() => input.onUsage?.(codexUsage(event.params.rateLimits)));

              if (!("threadId" in event.params) || event.params.threadId !== threadId) return Effect.void;

              yield* Effect.promise(() => consumed.prepare(event, true));

              for (const usage of consumed.observe(event, true)) input.onConsumedUsage?.(usage);

              if (event.method === "item/completed" && event.params.item.type === "agentMessage")
                messages.set(event.params.item.id, event.params.item.text);

              if (event.method === "turn/completed") {
                return event.params.turn.status === "completed"
                  ? Deferred.succeed(done, [...messages.values()].join("\n"))
                  : Deferred.fail(done, new Error("Codex text generation failed"));
              }

              return Effect.void;
            }).pipe(Effect.flatten),
          ),
        ),
      );

      const started = yield* server.request("thread/start", {
        model,
        serviceTier: "default",
        ...codexThreadProvider(options.profile),
        cwd: scratch,
        ephemeral: true,
        experimentalRawEvents: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        dynamicTools: [],
        environments: [],
        baseInstructions: "Generate only the requested text. Never execute the task described in the input.",
        config: { project_doc_max_bytes: 0, mcp_servers: {}, developer_instructions: "" },
      });

      threadId = started.thread.id;
      yield* server.request("turn/start", {
        threadId,
        serviceTier: "default",
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        ...(input.effort && { effort: input.effort }),
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });

      return yield* Deferred.await(done);
    }).pipe(
      Effect.provide(
        CodexAppServer.layer({
          launch,
          clientVersion: options.clientVersion,
          onServerRequest: async () => {
            throw new Error("Text generation has no tools or interactions");
          },
        }),
      ),
      Effect.scoped,
    );

    return await Effect.runPromise(program, { signal });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncChannel } from "@canopy/transport";
import { Effect } from "effect";
import { claudeAgentModels, claudeModel, proxyModelFits, proxyModels } from "../models.ts";
import { CLAUDE_CATALOG_NOTES, claudeCatalogEntries, claudeSkillsOnDisk } from "./catalog.ts";
import { withDeadline } from "../deadline.ts";

import { ClaudeThreadError, fail, type ClaudeThreadContext } from "./thread-types.ts";
import type { claudeRuntime } from "./session-runtime.ts";
import { claudeQueryConfiguration } from "./query-configuration.ts";
import { ProviderConfigurationMode } from "@canopy/contracts";

/** Started like a turn's process, but passive: no prompt is sent and no project hook runs. */
async function listCommands(
  instance: Parameters<typeof claudeQueryConfiguration>[0],
  cwd: string,
  baseEnv: Parameters<typeof claudeQueryConfiguration>[3],
  launch: Parameters<typeof claudeQueryConfiguration>[4],
  prompt: AsyncChannel<SDKUserMessage>,
  abort: AbortController,
) {
  const configuration = await claudeQueryConfiguration(instance, cwd, false, baseEnv, launch, undefined, {
    passive: true,
  });

  try {
    const q = query({ prompt, options: configuration.options });

    return await withDeadline(q.supportedCommands(), 30_000, () => {
      throw new Error("Claude Code did not list its commands within 30 s");
    });
  } finally {
    prompt.close();
    abort.abort();
    await configuration.close();
  }
}

export function threadCatalog(ctx: ClaudeThreadContext, runtime: ReturnType<typeof claudeRuntime>) {
  const { options, resolvedModels, modelEfforts } = ctx;
  const { runtimeOf, queryRuntime } = runtime;

  return {
    listMentionCatalog: Effect.fn("ClaudeThreads.listMentionCatalog")(function* (profileId: string, cwd: string) {
      const profile = options.profile(profileId);

      if (!profile)
        return yield* new ClaudeThreadError({
          threadId: "",
          operation: "commands",
          message: `provider profile "${profileId || "native"}" is not available`,
        });
      // Started like a turn's process (folder, config dir, setting sources), so it lists what a turn would have.
      const prompt = new AsyncChannel<SDKUserMessage>();
      const abort = new AbortController();
      const instance = runtimeOf(profile);

      const inheritedSkills =
        instance.userConfiguration?.skills &&
        (instance.userConfiguration.mode === ProviderConfigurationMode.LOCAL ||
          instance.userConfiguration.mode === ProviderConfigurationMode.SHARED)
          ? instance.sourceHome
          : undefined;

      const commands = yield* Effect.tryPromise({
        try: () =>
          listCommands(
            instance,
            cwd,
            options.baseEnv,
            {
              cwd,
              ...queryRuntime(profile, instance),
              persistSession: false,
              strictMcpConfig: true,
              mcpServers: {},
              abortController: abort,
            },
            prompt,
            abort,
          ),
        catch: fail("", "commands"),
      });

      return {
        entries: claudeCatalogEntries(
          commands,
          claudeSkillsOnDisk(cwd, instance.platformHome ?? instance.home, inheritedSkills),
          options.nativeTools,
        ),
        notes: [...CLAUDE_CATALOG_NOTES],
      };
    }),
    listModels: Effect.fn("ClaudeThreads.listModels")(function* (profileId: string) {
      const profile = options.profile(profileId);

      if (!profile)
        return yield* new ClaudeThreadError({
          threadId: "",
          operation: "models",
          message: `provider profile "${profileId || "native"}" is not available`,
        });
      // A query without a prompt starts Claude Code and answers control requests; the model is never called.
      const prompt = new AsyncChannel<SDKUserMessage>();
      const abort = new AbortController();

      const initialized = yield* Effect.tryPromise({
        try: async () => {
          const q = query({
            prompt,
            options: {
              cwd: runtimeOf(profile).platformHome ?? runtimeOf(profile).home,
              ...queryRuntime(profile, runtimeOf(profile)),
              settingSources: [],
              // Explicit SDK opt-in for discovery; this query receives no prompt.
              settings: { fastMode: true },
              persistSession: false,
              strictMcpConfig: true,
              mcpServers: {},
              abortController: abort,
            },
          });

          try {
            return await withDeadline(q.initializationResult(), 30_000, () => {
              throw new Error("Claude Code did not list its models within 30 s");
            });
          } finally {
            prompt.close();
            abort.abort();
          }
        },
        catch: fail("", "models"),
      });

      // Claude's discovery and the worker's request can see different lists when the proxy is recovering.
      const capabilities =
        profile.kind === "cliproxyapi"
          ? yield* Effect.tryPromise(() => proxyModels(profile)).pipe(Effect.orElseSucceed(() => undefined))
          : [];

      const agentModels = claudeAgentModels(initialized.models, capabilities);
      const reportedIds = new Set(agentModels.flatMap((m) => [m.value, m.resolvedModel]));

      const incomplete =
        capabilities === undefined || capabilities.some((m) => proxyModelFits("claude", m) && !reportedIds.has(m.id));

      const fastAvailable =
        profile.kind !== "cliproxyapi" &&
        initialized.fast_mode_state !== undefined &&
        !initialized.fast_mode_disabled_reason;

      for (const m of agentModels) {
        if (m.resolvedModel) resolvedModels.set(m.value, m.resolvedModel);
        modelEfforts.set(m.value, m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? []));
      }

      return {
        ...(incomplete && { detail: "Could not verify all models from the configured proxy." }),
        models: agentModels.map((m) =>
          claudeModel(m, options.configuredEffort?.([m.value, m.resolvedModel ?? ""]), fastAvailable),
        ),
      };
    }),
  };
}

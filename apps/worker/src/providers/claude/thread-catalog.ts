import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncChannel } from "@canopy/transport";
import { Effect } from "effect";
import { claudeAgentModels, claudeModel, proxyModels, type ProxyModel } from "../models.ts";
import { CLAUDE_CATALOG_NOTES, claudeCatalogEntries, claudeSkillsOnDisk } from "./catalog.ts";
import { withDeadline } from "../deadline.ts";

import { ClaudeThreadError, fail, type ClaudeThreadContext } from "./thread-types.ts";
import type { claudeRuntime } from "./session-runtime.ts";

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

      const commands = yield* Effect.tryPromise({
        try: async () => {
          const q = query({
            prompt,
            options: {
              cwd,
              ...queryRuntime(profile, runtimeOf(profile)),
              persistSession: false,
              strictMcpConfig: true,
              mcpServers: {},
              abortController: abort,
            },
          });

          try {
            return await withDeadline(q.supportedCommands(), 30_000, () => {
              throw new Error("Claude Code did not list its commands within 30 s");
            });
          } finally {
            prompt.close();
            abort.abort();
          }
        },
        catch: fail("", "commands"),
      });

      return {
        entries: claudeCatalogEntries(commands, claudeSkillsOnDisk(cwd, runtimeOf(profile).home), options.nativeTools),
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

      const models = yield* Effect.tryPromise({
        try: async () => {
          const q = query({
            prompt,
            options: {
              cwd: runtimeOf(profile).home,
              ...queryRuntime(profile, runtimeOf(profile)),
              settingSources: [],
              persistSession: false,
              strictMcpConfig: true,
              mcpServers: {},
              abortController: abort,
            },
          });

          try {
            return await withDeadline(q.supportedModels(), 30_000, () => {
              throw new Error("Claude Code did not list its models within 30 s");
            });
          } finally {
            prompt.close();
            abort.abort();
          }
        },
        catch: fail("", "models"),
      });

      // Through a proxy: its capabilities say which listed models cannot run an agent turn (optional).
      const capabilities =
        profile.kind === "cliproxyapi"
          ? yield* Effect.tryPromise(() => proxyModels(profile)).pipe(Effect.orElseSucceed((): ProxyModel[] => []))
          : [];

      const agentModels = claudeAgentModels(models, capabilities);

      for (const m of agentModels) {
        if (m.resolvedModel) resolvedModels.set(m.value, m.resolvedModel);
        modelEfforts.set(m.value, m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? []));
      }

      return {
        models: agentModels.map((m) => claudeModel(m, options.configuredEffort?.([m.value, m.resolvedModel ?? ""]))),
      };
    }),
  };
}

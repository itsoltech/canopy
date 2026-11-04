import { Context } from "effect";
import { CodexThreads } from "../providers/codex/threads.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import type { ResolvedProfile } from "../providers/profiles.ts";
import { codexProfileGroup, usableBy } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export interface WantedRuntime {
  key: string;
  start(): Promise<void>;
}

/** Compare effective instance settings, never the worker-wide config version. Keys stay in memory. */
export function wantedRuntimes(ctx: HostContext): Map<string, WantedRuntime> {
  const wanted = new Map<string, WantedRuntime>();
  const config = ctx.state.config;

  if (!config) return wanted;

  for (const [group, settings] of ctx.ops.codexGroups(config))
    wanted.set(`codex/${group}`, { key: settings.key, start: () => ctx.ops.startCodex(group, settings, config) });

  for (const status of config.profiles) {
    const profile = status.resolved;

    if (!profile) continue;

    for (const harness of ["claude", "grok"] as const) {
      const provider = config[harness];

      if (!provider.enabled || !usableBy(profile, harness)) continue;
      const key = JSON.stringify({ provider, profile, nativeTools: config.nativeTools });
      wanted.set(`${harness}/${profile.id}`, {
        key,
        start: () =>
          harness === "claude" ? ctx.ops.startClaude(profile, key, config) : ctx.ops.startGrok(profile, key, config),
      });
    }
  }

  return wanted;
}

export function runtimeKeys(ctx: HostContext): Map<string, string> {
  return new Map([
    ...[...ctx.state.codex].map(([id, handle]) => [`codex/${id}`, handle.key] as const),
    ...[...ctx.state.claude].map(([id, handle]) => [`claude/${id}`, handle.key] as const),
    ...[...ctx.state.grok].map(([id, handle]) => [`grok/${id}`, handle.key] as const),
  ]);
}

export function instanceKey(harness: string, id: string): string {
  return `${harness}/${harness === "codex" ? codexProfileGroup(id || "native") : id || "native"}`;
}

/** Admission, running turns and owned background tasks all hold their original runtime snapshot. */
export function runtimeBusy(ctx: HostContext, key: string): boolean {
  if (ctx.state.runtimeUsers.get(key)) return true;

  for (const turn of ctx.state.running)
    if (ctx.state.threadInstances.get(turn.split("/")[0] ?? "") === key) return true;
  const [harness, id = ""] = key.split("/");

  if (harness === "codex") {
    const handle = ctx.state.codex.get(id);

    if (!handle) return false;
    const threads = Context.get(handle.context, CodexThreads);

    return threads.hasActiveTurns() || threads.backgroundTasks().size > 0;
  }

  if (harness === "claude") {
    const handle = ctx.state.claude.get(id);

    if (!handle) return false;
    const threads = Context.get(handle.context, ClaudeThreads);

    return threads.hasActiveTurns() || threads.backgroundTasks().size > 0;
  }

  return false;
}

export async function stopRuntime(ctx: HostContext, key: string): Promise<void> {
  const [harness, id = ""] = key.split("/");

  if (harness === "codex") await ctx.ops.stopCodex(id);
  else if (harness === "claude") await ctx.ops.stopClaude(id);
  else {
    const previous = ctx.state.grok.get(id);
    ctx.state.grok.delete(id);
    await previous?.runtime.close();
  }
}

export function matchingProfile(profile: ResolvedProfile, id: string): ResolvedProfile | undefined {
  return profile.id === (id || "native") ? profile : undefined;
}

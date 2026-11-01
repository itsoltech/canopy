/**
 * Provider-native orchestration is disabled by default and replaced by platform tools that
 * both Claude and Codex get (docs/agent-bus.md):
 * - subagents -> side threads (spawn_thread, send_message, ...),
 * - scheduling / automations -> platform schedules (schedule_wakeup, schedule_recurring, ...).
 * - account connectors of the device owner (Codex `apps`: ChatGPT-connected apps) -> off, they would give
 *   platform agents access to the device owner's personal accounts.
 * Goals stay enabled on purpose: platform goals use them as their engine (docs/goals.md).
 * Platform tools are durable, visible in the thread tree and controllable; native ones live
 * only inside the provider process.
 *
 * An agent template may opt back in per category.
 */

/**
 * Claude Code tools for native multi-agent work: subagents (Agent, formerly Task), multi-agent scripts
 * (Workflow) and agent-to-agent messaging (ListAgents, SendMessage, SubagentHandback).
 */
export const CLAUDE_SUBAGENT_TOOLS = ["Agent", "Task", "Workflow", "ListAgents", "SendMessage", "SubagentHandback"] as const;
/** Claude Code tools that schedule work outside the platform. */
export const CLAUDE_SCHEDULING_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "RemoteTrigger"] as const;

/** Codex features that expose subagent tools (spawn_agent, wait, ...). */
export const CODEX_SUBAGENT_FEATURES = ["multi_agent", "multi_agent_v2"] as const;
/** Codex features that schedule or delay work outside the platform. */
export const CODEX_SCHEDULING_FEATURES = ["in_app_local_automation", "sleep_tool"] as const;
/** Codex features that connect the device owner's ChatGPT account apps (built-in `codex_apps` MCP server). */
export const CODEX_CONNECTOR_FEATURES = ["apps"] as const;

export interface NativeToolPolicy {
  readonly nativeSubagents: boolean;
  readonly nativeScheduling: boolean;
  /** Device owner's account connectors (Codex apps). Absent = off. */
  readonly nativeConnectors?: boolean;
}

export const DEFAULT_NATIVE_TOOL_POLICY: NativeToolPolicy = { nativeSubagents: false, nativeScheduling: false, nativeConnectors: false };

/** Merged into Claude `query()` options. `disallowedTools` removes tools from the model context entirely. */
export function claudeNativeToolOptions(policy: NativeToolPolicy): { disallowedTools: string[] } {
  return {
    disallowedTools: [
      ...(policy.nativeSubagents ? [] : CLAUDE_SUBAGENT_TOOLS),
      ...(policy.nativeScheduling ? [] : CLAUDE_SCHEDULING_TOOLS),
    ],
  };
}

/** `-c` overrides for `codex app-server`. Applied per process; threads inherit them. */
export function codexNativeToolOverrides(policy: NativeToolPolicy): string[] {
  const features: [string, boolean][] = [
    ...CODEX_SUBAGENT_FEATURES.map((f): [string, boolean] => [f, policy.nativeSubagents]),
    ...CODEX_SCHEDULING_FEATURES.map((f): [string, boolean] => [f, policy.nativeScheduling]),
    ...CODEX_CONNECTOR_FEATURES.map((f): [string, boolean] => [f, policy.nativeConnectors ?? false]),
  ];
  return features.flatMap(([feature, enabled]) => ["-c", `features.${feature}=${String(enabled)}`]);
}

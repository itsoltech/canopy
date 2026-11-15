import { createHash } from "node:crypto";
import { AgentTool, type RunAgentTool } from "@canopy/contracts";

export type AgentToolScope = Partial<Pick<RunAgentTool, "session" | "platform" | "deviceId">>;

/** Thread ids remain recognizable; every caller applies the same fallback for other session labels. */
export function agentToolSession(value: string): string {
  if (!value || /^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;

  return `canopy-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function agentToolScopeArgs(tool: AgentTool, scope: AgentToolScope): string[] {
  const session = scope.session ? ["--session", agentToolSession(scope.session)] : [];

  if (tool !== AgentTool.DEVICE) return session;
  const platform = scope.platform ? ["--platform", scope.platform] : [];

  if (!scope.deviceId) return [...session, ...platform];

  if (["ios", "macos", "apple"].includes(scope.platform ?? ""))
    return [...session, ...platform, "--udid", scope.deviceId];

  if (["android", "harmonyos", "vega"].includes(scope.platform ?? ""))
    return [...session, ...platform, "--serial", scope.deviceId];

  throw new Error("A device ID requires an explicit Apple, Android, HarmonyOS or Vega platform");
}

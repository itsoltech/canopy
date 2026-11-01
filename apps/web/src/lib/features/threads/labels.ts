import { PermissionMode, Provider } from "@open-agents/contracts";

export const providerLabel = (provider: Provider): string => (provider === Provider.CLAUDE ? "Claude" : provider === Provider.CODEX ? "Codex" : "Agent");

/** Permission modes offered when creating a thread (value = enum key, sent to the form action). */
export const permissionModes = [
  { value: "ASK", label: "Ask first", description: "Asks before writing files or running commands." },
  { value: "ACCEPT_EDITS", label: "Accept edits", description: "Edits files in the workspace, asks for everything else." },
  { value: "READ_ONLY", label: "Read only", description: "Reads files, never changes them." },
  { value: "FULL_AUTO", label: "Full auto", description: "Runs without asking, sandboxed to the workspace." },
] as const satisfies readonly { value: keyof typeof PermissionMode; label: string; description: string }[];

export function permissionLabel(mode: PermissionMode): string {
  return permissionModes.find((m) => PermissionMode[m.value] === mode)?.label ?? "Ask first";
}

/** Who started a turn (`ui.Turn.trigger`), when it was not the user typing in this UI. */
export function triggerLabel(trigger: string): string | undefined {
  switch (trigger) {
    case "agent_bus":
      return "Sent by an agent";
    case "schedule":
      return "Scheduled";
    case "interaction":
      return "After an answer";
    case "goal":
      return "Goal";
    case "provider":
      return "Background work finished";
    case "recovery":
      return "Resumed after restart";
    default:
      return undefined;
  }
}

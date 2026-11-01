import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { PermissionMode } from "@open-agents/contracts";

/**
 * Platform permission modes -> Claude Code permission mode + sandbox, aligned with Codex (codex/permissions.ts):
 *
 * | Mode | Claude | Prompts |
 * |---|---|---|
 * | ASK (and unspecified) | `default` | every edit and command goes through canUseTool -> the platform |
 * | ACCEPT_EDITS | `acceptEdits` | edits in the workspace pass, the rest asks |
 * | READ_ONLY | `dontAsk` | nothing asks; what needs approval (edits, shell) is denied |
 * | FULL_AUTO | `acceptEdits` + sandboxed Bash | nothing asks; shell runs in the OS sandbox (writes stay in the workspace) |
 *
 * FULL_AUTO never means bypassPermissions: without the sandbox (bubblewrap on Linux, Seatbelt on macOS)
 * a command fails instead of running unconfined (failIfUnavailable).
 */
export interface ClaudePermissions {
  readonly options: Pick<Options, "permissionMode" | "sandbox">;
  /** canUseTool allows without asking (FULL_AUTO); questions to the user still go to the platform. */
  readonly autoAllow: boolean;
}

export function claudePermissions(mode: PermissionMode): ClaudePermissions {
  switch (mode) {
    case PermissionMode.ACCEPT_EDITS:
      return { options: { permissionMode: "acceptEdits" }, autoAllow: false };
    case PermissionMode.READ_ONLY:
      return { options: { permissionMode: "dontAsk" }, autoAllow: false };
    case PermissionMode.FULL_AUTO:
      return {
        options: {
          permissionMode: "acceptEdits",
          sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
        },
        autoAllow: true,
      };
    default:
      return { options: { permissionMode: "default" }, autoAllow: false };
  }
}

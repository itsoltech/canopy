import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { PermissionMode } from "@canopy/contracts";

/**
 * Platform permission modes -> Claude Code permission mode + sandbox, aligned with Codex (codex/permissions.ts):
 *
 * | Mode | Claude | Prompts |
 * |---|---|---|
 * | ASK (and unspecified) | `default` | every edit and command goes through canUseTool -> the platform |
 * | ACCEPT_EDITS | `acceptEdits` | edits in the workspace pass, the rest asks |
 * | READ_ONLY | `dontAsk` | nothing asks; what needs approval (edits, shell) is denied |
 * | FULL_AUTO | `acceptEdits` + sandboxed Bash | nothing asks; shell runs in the OS sandbox (writes stay in the workspace) |
 * | FULL_ACCESS | `acceptEdits`, sandbox off | nothing asks; edits and shell run anywhere the worker's OS user can |
 *
 * FULL_AUTO never means bypassPermissions and never runs a command unconfined. The sandbox (bubblewrap on Linux,
 * Seatbelt on macOS) auto-allows the commands it confines; where it is unavailable (Windows, Linux without
 * bubblewrap) the session still starts, and a shell command reaches canUseTool, which asks the user instead of
 * allowing it. FULL_ACCESS is not bypassPermissions either: canUseTool allows every tool, so questions to the user
 * (AskUserQuestion) still reach the platform. The sandbox is off explicitly, also when the repository's settings
 * turn it on.
 */
export interface ClaudePermissions {
  readonly options: Pick<Options, "permissionMode" | "sandbox">;
  readonly autoAllow: AutoAllow;
}

/**
 * What canUseTool allows without asking; questions to the user always go to the platform.
 * `unconfined-shell-asks`: every tool but a shell command the sandbox did not confine (FULL_AUTO).
 */
export type AutoAllow = "none" | "unconfined-shell-asks" | "all";

/** Claude Code's shell tools; the sandbox auto-allows them only when it confines the command. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

export const autoAllows = (autoAllow: AutoAllow, toolName: string): boolean =>
  autoAllow === "all" || (autoAllow === "unconfined-shell-asks" && !SHELL_TOOLS.has(toolName));

export function claudePermissions(mode: PermissionMode): ClaudePermissions {
  switch (mode) {
    case PermissionMode.ACCEPT_EDITS:
      return { options: { permissionMode: "acceptEdits" }, autoAllow: "none" };
    case PermissionMode.READ_ONLY:
      return { options: { permissionMode: "dontAsk" }, autoAllow: "none" };
    case PermissionMode.FULL_AUTO:
      return {
        options: {
          permissionMode: "acceptEdits",
          sandbox: {
            enabled: true,
            // Without a sandbox the turn runs and unconfined commands ask (autoAllow), instead of failing at start.
            failIfUnavailable: false,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
          },
        },
        autoAllow: "unconfined-shell-asks",
      };
    case PermissionMode.FULL_ACCESS:
      return { options: { permissionMode: "acceptEdits", sandbox: { enabled: false } }, autoAllow: "all" };
    default:
      return { options: { permissionMode: "default" }, autoAllow: "none" };
  }
}

/** Whether the mode runs Bash in the OS sandbox (only FULL_AUTO turns it on). */
export const sandboxed = (permissions: ClaudePermissions): boolean => permissions.options.sandbox?.enabled === true;

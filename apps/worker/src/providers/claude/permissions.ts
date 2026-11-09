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
 * | FULL_AUTO | `acceptEdits` + sandboxed Bash | nothing asks; shell runs in the OS sandbox (writes stay in the workspace); on Windows shell commands ask |
 * | FULL_ACCESS | `acceptEdits`, sandbox off | nothing asks; edits and shell run anywhere the worker's OS user can |
 *
 * FULL_AUTO never means bypassPermissions and never runs a command unconfined. On Linux (bubblewrap) and macOS
 * (Seatbelt) a command fails instead of running unconfined when the sandbox cannot start (failIfUnavailable), and
 * canUseTool allows everything: a command reaching it still runs in the sandbox (Claude Code's own auto-allow skips
 * some confined commands, e.g. `cd x && rm y`). Windows has no sandbox in Claude Code, so there the session starts
 * without it and a shell command reaches canUseTool unconfined, which asks the user instead of allowing it.
 * FULL_ACCESS is not bypassPermissions either: canUseTool allows every tool, so questions to the user
 * (AskUserQuestion) still reach the platform. The sandbox is off explicitly, also when the repository's settings
 * turn it on.
 */
export interface ClaudePermissions {
  readonly options: Pick<Options, "permissionMode" | "sandbox">;
  readonly autoAllow: AutoAllow;
}

/**
 * What canUseTool allows without asking; questions to the user always go to the platform.
 * `unconfined-shell-asks`: every tool but the shell, which runs unconfined (FULL_AUTO on Windows).
 */
export type AutoAllow = "none" | "unconfined-shell-asks" | "all";

/** Claude Code's shell tools; a sandbox confines them where Claude Code has one. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

export const autoAllows = (autoAllow: AutoAllow, toolName: string): boolean =>
  autoAllow === "all" || (autoAllow === "unconfined-shell-asks" && !SHELL_TOOLS.has(toolName));

export function claudePermissions(
  mode: PermissionMode,
  platform: NodeJS.Platform = process.platform,
): ClaudePermissions {
  // Claude Code has no OS sandbox on Windows: a required one would fail every turn at start.
  const noSandbox = platform === "win32";

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
            failIfUnavailable: !noSandbox,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
          },
        },
        autoAllow: noSandbox ? "unconfined-shell-asks" : "all",
      };
    case PermissionMode.FULL_ACCESS:
      return { options: { permissionMode: "acceptEdits", sandbox: { enabled: false } }, autoAllow: "all" };
    default:
      return { options: { permissionMode: "default" }, autoAllow: "none" };
  }
}

/** Whether the mode runs Bash in the OS sandbox (only FULL_AUTO turns it on). */
export const sandboxed = (permissions: ClaudePermissions): boolean => permissions.options.sandbox?.enabled === true;

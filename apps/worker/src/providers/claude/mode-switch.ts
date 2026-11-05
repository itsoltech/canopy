import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "@canopy/contracts";
import { claudePermissions, sandboxed } from "./permissions.ts";

/** What a mode switch changes on a live session (Session has these fields). */
export interface ModeSwitchable {
  mode: PermissionMode;
  autoAllow: boolean;
  readonly query: Pick<Query, "applyFlagSettings" | "setPermissionMode">;
}

/**
 * A live process (kept by background tasks) takes the next turn's mode before the turn starts: Claude Code's
 * permission mode, the sandbox (the flag settings layer, where Options.sandbox lives) and auto-allow in
 * canUseTool. Nothing of the previous turn waits for a decision any more (no turn runs).
 */
export async function switchSessionMode(session: ModeSwitchable, mode: PermissionMode): Promise<void> {
  const current = claudePermissions(session.mode);
  const next = claudePermissions(mode);

  // Nothing is auto-allowed while switching: FULL_AUTO only once the sandbox is on, FULL_ACCESS once it is off.
  session.autoAllow = false;

  if (sandboxed(next) !== sandboxed(current)) {
    // Options.sandbox is the settings' sandbox; live, only an explicit `enabled: false` turns it off
    // (`sandbox: null` leaves the one from the start in place and sandboxed Bash stays auto-allowed).
    type FlagSandbox = NonNullable<Parameters<Query["applyFlagSettings"]>[0]["sandbox"]>;

    // SAFETY: claudePermissions constructs sandbox settings with defined properties only;
    // applyFlagSettings uses the same settings contract with stricter optional-property declarations.
    const sandbox = (next.options.sandbox ?? { enabled: false }) as FlagSandbox;
    await session.query.applyFlagSettings({ sandbox });
  }

  await session.query.setPermissionMode(next.options.permissionMode ?? "default");
  session.mode = mode;
  session.autoAllow = next.autoAllow;
}

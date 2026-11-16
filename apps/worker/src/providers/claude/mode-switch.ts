import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "@canopy/contracts";
import { claudePermissions, sandboxed, type AutoAllow } from "./permissions.ts";

/** What a mode switch changes on a live session (Session has these fields). */
export interface ModeSwitchable {
  mode: PermissionMode;
  autoAllow: AutoAllow;
  readonly query: Pick<Query, "applyFlagSettings" | "setPermissionMode">;
}

interface ModeSwitchControls {
  check?(): void;
  invalidate?(): void;
  applied?(): Promise<void>;
}

const switches = new WeakMap<ModeSwitchable, Promise<void>>();

/** Completion waits for controls and their durable event before releasing the original turn. */
export const pendingSessionMode = (session: ModeSwitchable): Promise<void> | undefined => switches.get(session);

/**
 * Changes Claude Code's permission mode and sandbox (the flag settings layer), then commits auto-allow.
 * Live updates fence every SDK response and persist their event while completion still pins the original turn.
 */
export function switchSessionMode(
  session: ModeSwitchable,
  mode: PermissionMode,
  controls: ModeSwitchControls = {},
): Promise<void> {
  const next = (switches.get(session) ?? Promise.resolve()).then(async () => {
    controls.check?.();

    try {
      await applyMode(session, mode, controls.check);
      await controls.applied?.();
      session.mode = mode;
      session.autoAllow = claudePermissions(mode).autoAllow;
    } catch (error) {
      session.autoAllow = "none";
      controls.invalidate?.();
      throw error;
    }
  });

  const settled = next.catch(() => {});
  switches.set(session, settled);
  void settled.then(() => {
    if (switches.get(session) === settled) switches.delete(session);
  });

  return next;
}

async function applyMode(session: ModeSwitchable, mode: PermissionMode, check?: () => void): Promise<void> {
  const current = claudePermissions(session.mode);
  const next = claudePermissions(mode);

  // Nothing is auto-allowed while switching: FULL_AUTO only once the sandbox is on, FULL_ACCESS once it is off.
  session.autoAllow = "none";

  if (next.options.sandbox?.enabled === false || sandboxed(next) !== sandboxed(current)) {
    // Options.sandbox is the settings' sandbox; live, only an explicit `enabled: false` turns it off
    // (`sandbox: null` leaves the one from the start in place and sandboxed Bash stays auto-allowed).
    type FlagSandbox = NonNullable<Parameters<Query["applyFlagSettings"]>[0]["sandbox"]>;

    // SAFETY: claudePermissions constructs sandbox settings with defined properties only;
    // applyFlagSettings uses the same settings contract with stricter optional-property declarations.
    const sandbox = (next.options.sandbox ?? { enabled: false }) as FlagSandbox;
    await session.query.applyFlagSettings({ sandbox });
    check?.();
  }

  check?.();
  await session.query.setPermissionMode(next.options.permissionMode ?? "default");
  check?.();
}

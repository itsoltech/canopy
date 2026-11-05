import { describe, expect, test } from "bun:test";
import { PermissionMode } from "@canopy/contracts";
import { switchSessionMode, type ModeSwitchable } from "./mode-switch.ts";
import { claudePermissions } from "./permissions.ts";

/** A live session whose query records what the switch sent to Claude Code. */
function live(mode: PermissionMode) {
  const sent: unknown[] = [];
  const permissions = claudePermissions(mode);

  const session: ModeSwitchable = {
    mode,
    autoAllow: permissions.autoAllow,
    query: {
      applyFlagSettings: async (settings) => void sent.push({ sandbox: settings.sandbox }),
      setPermissionMode: async (permissionMode) => void sent.push({ permissionMode }),
    },
  };

  return { session, sent };
}

describe("claudePermissions", () => {
  test("Full access starts without a sandbox and allows every tool; Full auto stays sandboxed", () => {
    expect(claudePermissions(PermissionMode.FULL_ACCESS)).toEqual({
      options: { permissionMode: "acceptEdits", sandbox: { enabled: false } },
      autoAllow: true,
    });
    expect(claudePermissions(PermissionMode.FULL_AUTO)).toEqual({
      options: {
        permissionMode: "acceptEdits",
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
        },
      },
      autoAllow: true,
    });
  });

  test("switching mid-thread toggles the sandbox between Full auto and Full access", async () => {
    const { session, sent } = live(PermissionMode.FULL_AUTO);

    await switchSessionMode(session, PermissionMode.FULL_ACCESS);
    expect(sent).toEqual([{ sandbox: { enabled: false } }, { permissionMode: "acceptEdits" }]);
    expect([session.mode, session.autoAllow]).toEqual([PermissionMode.FULL_ACCESS, true]);

    sent.length = 0;
    await switchSessionMode(session, PermissionMode.FULL_AUTO);
    expect(sent).toEqual([
      { sandbox: claudePermissions(PermissionMode.FULL_AUTO).options.sandbox },
      { permissionMode: "acceptEdits" },
    ]);

    // Full access to Ask: no sandbox either way, auto-allow off.
    const ask = live(PermissionMode.FULL_ACCESS);
    await switchSessionMode(ask.session, PermissionMode.ASK);
    expect(ask.sent).toEqual([{ permissionMode: "default" }]);
    expect(ask.session.autoAllow).toBe(false);
  });
});

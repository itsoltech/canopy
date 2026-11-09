import { describe, expect, test } from "bun:test";
import { PermissionMode } from "@canopy/contracts";
import { switchSessionMode, type ModeSwitchable } from "./mode-switch.ts";
import { autoAllows, claudePermissions } from "./permissions.ts";

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
      autoAllow: "all",
    });
    expect(claudePermissions(PermissionMode.FULL_AUTO)).toEqual({
      options: {
        permissionMode: "acceptEdits",
        sandbox: {
          enabled: true,
          failIfUnavailable: false,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
        },
      },
      autoAllow: "unconfined-shell-asks",
    });
  });

  test("Full auto without a working sandbox asks before a shell command runs unconfined", () => {
    // The sandbox auto-allows what it confines; a shell command reaching canUseTool was not confined (Windows).
    const { autoAllow } = claudePermissions(PermissionMode.FULL_AUTO);

    expect(["Bash", "PowerShell"].map((tool) => autoAllows(autoAllow, tool))).toEqual([false, false]);
    expect(["Edit", "Write", "WebFetch", "mcp__docs__search"].every((tool) => autoAllows(autoAllow, tool))).toBe(true);
    expect(autoAllows(claudePermissions(PermissionMode.FULL_ACCESS).autoAllow, "PowerShell")).toBe(true);
    expect(autoAllows(claudePermissions(PermissionMode.ASK).autoAllow, "Edit")).toBe(false);
  });

  test("switching mid-thread toggles the sandbox between Full auto and Full access", async () => {
    const { session, sent } = live(PermissionMode.FULL_AUTO);

    await switchSessionMode(session, PermissionMode.FULL_ACCESS);
    expect(sent).toEqual([{ sandbox: { enabled: false } }, { permissionMode: "acceptEdits" }]);
    expect([session.mode, session.autoAllow]).toEqual([PermissionMode.FULL_ACCESS, "all"]);

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
    expect(ask.session.autoAllow).toBe("none");
  });
});

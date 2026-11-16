import { describe, expect, test } from "bun:test";
import { PermissionMode } from "@canopy/contracts";
import { pendingSessionMode, switchSessionMode, type ModeSwitchable } from "./mode-switch.ts";
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
  test("Full access starts without a sandbox and allows every tool; Full auto requires the sandbox", () => {
    expect(claudePermissions(PermissionMode.FULL_ACCESS, "linux")).toEqual({
      options: { permissionMode: "acceptEdits", sandbox: { enabled: false } },
      autoAllow: "all",
    });
    expect(claudePermissions(PermissionMode.FULL_AUTO, "linux")).toEqual({
      options: {
        permissionMode: "acceptEdits",
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
        },
      },
      autoAllow: "all",
    });
  });

  test("Full auto on Windows starts without the sandbox and asks before a shell command runs unconfined", () => {
    const { options, autoAllow } = claudePermissions(PermissionMode.FULL_AUTO, "win32");

    expect(options.sandbox?.failIfUnavailable).toBe(false);
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

  test("concurrent switches wait for the previous durable outcome before sending another SDK control", async () => {
    const { session, sent } = live(PermissionMode.FULL_AUTO);
    const entered = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<void>();

    const first = switchSessionMode(session, PermissionMode.FULL_ACCESS, {
      applied: async () => {
        entered.resolve();
        await persisted.promise;
      },
    });

    await entered.promise;
    const second = switchSessionMode(session, PermissionMode.FULL_AUTO);
    const pending = pendingSessionMode(session);

    expect(pending).toBeDefined();
    expect(sent).toEqual([{ sandbox: { enabled: false } }, { permissionMode: "acceptEdits" }]);
    expect([session.mode, session.autoAllow]).toEqual([PermissionMode.FULL_AUTO, "none"]);
    persisted.resolve();
    await Promise.all([first, second, pending]);
    expect(sent).toEqual([
      { sandbox: { enabled: false } },
      { permissionMode: "acceptEdits" },
      { sandbox: claudePermissions(PermissionMode.FULL_AUTO).options.sandbox },
      { permissionMode: "acceptEdits" },
    ]);
    expect([session.mode, session.autoAllow]).toEqual([PermissionMode.FULL_AUTO, "all"]);
  });

  test("Full access explicitly disables an inherited sandbox from every non-sandboxed mode", async () => {
    for (const mode of [PermissionMode.ASK, PermissionMode.ACCEPT_EDITS, PermissionMode.READ_ONLY]) {
      const { session, sent } = live(mode);
      await switchSessionMode(session, PermissionMode.FULL_ACCESS);
      expect(sent).toEqual([{ sandbox: { enabled: false } }, { permissionMode: "acceptEdits" }]);
      expect(session.autoAllow).toBe("all");
    }
  });

  test("a failed permission control disables approval and invalidates a partially unsandboxed session", async () => {
    const { session, sent } = live(PermissionMode.FULL_AUTO);
    let invalidated = false;
    let recorded = false;
    session.query.setPermissionMode = async () => {
      throw new Error("SDK rejected permission mode");
    };

    await expect(
      switchSessionMode(session, PermissionMode.FULL_ACCESS, {
        invalidate: () => {
          invalidated = true;
        },
        applied: async () => {
          recorded = true;
        },
      }),
    ).rejects.toThrow("SDK rejected permission mode");
    expect(sent).toEqual([{ sandbox: { enabled: false } }]);
    expect([session.mode, session.autoAllow, invalidated, recorded]).toEqual([
      PermissionMode.FULL_AUTO,
      "none",
      true,
      false,
    ]);
  });

  test("the guard fences a stale SDK response before another control or permission event", async () => {
    const { session, sent } = live(PermissionMode.FULL_AUTO);
    const apply = session.query.applyFlagSettings;
    let current = true;
    let invalidated = false;
    let recorded = false;
    session.query.applyFlagSettings = async (settings) => {
      await apply(settings);
      current = false;
    };

    await expect(
      switchSessionMode(session, PermissionMode.FULL_ACCESS, {
        check: () => {
          if (!current) throw new Error("turn ended");
        },
        invalidate: () => {
          invalidated = true;
        },
        applied: async () => {
          recorded = true;
        },
      }),
    ).rejects.toThrow("turn ended");
    expect(sent).toEqual([{ sandbox: { enabled: false } }]);
    expect([session.autoAllow, invalidated, recorded]).toEqual(["none", true, false]);
  });
});

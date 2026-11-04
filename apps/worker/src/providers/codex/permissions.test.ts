import { describe, expect, test } from "bun:test";
import { PermissionMode } from "@canopy/contracts";
import type { v2 } from "@canopy/codex-protocol";
import { codexPermissions, codexTurnPermissions } from "./permissions.ts";

describe("codexPermissions", () => {
  test("maps every platform mode; unspecified is the safest (ask)", () => {
    expect(codexPermissions(PermissionMode.ASK)).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(codexPermissions(PermissionMode.UNSPECIFIED)).toEqual(codexPermissions(PermissionMode.ASK));
    expect(codexPermissions(PermissionMode.ACCEPT_EDITS)).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(codexPermissions(PermissionMode.READ_ONLY)).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(codexPermissions(PermissionMode.FULL_AUTO)).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
  });

  test("turn/start overrides carry the same policy and sandbox (explicit every turn)", () => {
    const workspace: v2.SandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };

    expect(codexTurnPermissions(PermissionMode.ASK)).toEqual({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(codexTurnPermissions(PermissionMode.ACCEPT_EDITS)).toEqual({
      approvalPolicy: "on-request",
      sandboxPolicy: workspace,
    });
    expect(codexTurnPermissions(PermissionMode.READ_ONLY)).toEqual({
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(codexTurnPermissions(PermissionMode.FULL_AUTO)).toEqual({
      approvalPolicy: "never",
      sandboxPolicy: workspace,
    });
  });
});

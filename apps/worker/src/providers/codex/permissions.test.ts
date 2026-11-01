import { describe, expect, test } from "bun:test";
import { PermissionMode } from "@open-agents/contracts";
import { codexPermissions } from "./permissions.ts";

describe("codexPermissions", () => {
  test("maps every platform mode; unspecified is the safest (ask)", () => {
    expect(codexPermissions(PermissionMode.ASK)).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(codexPermissions(PermissionMode.UNSPECIFIED)).toEqual(codexPermissions(PermissionMode.ASK));
    expect(codexPermissions(PermissionMode.ACCEPT_EDITS)).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPermissions(PermissionMode.READ_ONLY)).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(codexPermissions(PermissionMode.FULL_AUTO)).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
  });
});

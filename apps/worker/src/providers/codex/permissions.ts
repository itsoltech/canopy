import { PermissionMode } from "@open-agents/contracts";
import type { v2 } from "@open-agents/codex-protocol";

/**
 * Platform permission modes -> Codex approval policy + sandbox.
 *
 * In Codex, writes inside a workspace-write sandbox need no approval; anything outside the sandbox
 * escalates to an approval request (on-request) or is refused (never). So "ask for edits" means a
 * read-only sandbox where every write escalates.
 */
export function codexPermissions(mode: PermissionMode): { approvalPolicy: v2.AskForApproval; sandbox: v2.SandboxMode } {
  switch (mode) {
    case PermissionMode.ACCEPT_EDITS:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case PermissionMode.READ_ONLY:
      return { approvalPolicy: "never", sandbox: "read-only" };
    case PermissionMode.FULL_AUTO:
      // No prompts, still sandboxed to the workspace (danger-full-access is never chosen implicitly).
      return { approvalPolicy: "never", sandbox: "workspace-write" };
    default:
      // ASK and unspecified: every write or command outside read-only asks the user.
      return { approvalPolicy: "on-request", sandbox: "read-only" };
  }
}

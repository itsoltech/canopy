import type { PermissionRequest, PermissionResult, ToolCall } from "@canopy/acp";
import { PermissionMode, type ThreadSpec } from "@canopy/contracts";
import { Option, Schema } from "effect";
import { askAcpPermission, selectPermission, type AcpPermissionEntry } from "../acp/permissions.ts";
import type { AcpThreadOptions } from "../acp/thread-types.ts";
import { workspaceEdit } from "../edit-scope.ts";

const NativeName = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));
const FileInput = Schema.decodeUnknownOption(Schema.Struct({ Path: Schema.String }));

/** The native tool name is an Antigravity extension on ACP tool calls; title is only a presentation label. */
export function antigravityToolName(tool: ToolCall): string | undefined {
  return Option.getOrUndefined(NativeName(tool))?.name;
}

function editable(cwd: string, call: ToolCall): boolean {
  const name = antigravityToolName(call);

  if (call.kind !== "edit" || (name !== "write_file" && name !== "edit_file")) return false;
  const input = Option.getOrUndefined(FileInput(call.rawInput));

  return Boolean(
    input && workspaceEdit(cwd, input.Path) && call.locations?.every(({ path }) => workspaceEdit(cwd, path)) !== false,
  );
}

export async function antigravityPermission(
  spec: ThreadSpec,
  entry: AcpPermissionEntry,
  request: PermissionRequest,
  signal: AbortSignal,
  interact: AcpThreadOptions["interact"],
  allowSkillRead?: (tool: ToolCall) => boolean,
): Promise<PermissionResult> {
  if (signal.aborted || !entry.turnId) return { outcome: { outcome: "cancelled" } };

  if (allowSkillRead?.(request.toolCall)) return selectPermission(request, true);

  // The private agent inherits no MCP servers. Only delegate an exact tool actually listed by a
  // worker-owned endpoint; the bridge authorizes the call and its arguments at execution time.
  const name = antigravityToolName(request.toolCall);

  if (name && request.toolCall.kind === "other") {
    for (const [server, tools] of entry.mcpTools) {
      const prefix = `mcp_${server}_`;

      if (name.startsWith(prefix) && tools.has(name.slice(prefix.length))) return selectPermission(request, true);
    }
  }

  if (entry.mode === PermissionMode.READ_ONLY) return selectPermission(request, false);

  if (entry.mode === PermissionMode.FULL_ACCESS) return selectPermission(request, true);

  if (entry.mode === PermissionMode.ACCEPT_EDITS && editable(spec.cwd, request.toolCall))
    return selectPermission(request, true);

  const { toolCallId: _id, status: _status, ...operation } = request.toolCall;

  const grantKey =
    operation.rawInput !== undefined || operation.content?.length || operation.locations?.length
      ? JSON.stringify(operation)
      : undefined;

  return askAcpPermission(
    spec,
    entry,
    request,
    signal,
    {
      toolLabel: "Antigravity tool",
      grantKey,
      select: (allow) => selectPermission(request, allow),
    },
    interact,
  );
}

import type { PermissionRequest, PermissionResult } from "@canopy/acp";
import { PermissionMode, type ThreadSpec, type InteractionRequest, type InteractionResponse } from "@canopy/contracts";
import { askAcpPermission, type AcpPermissionEntry } from "../acp/permissions.ts";
import { workspaceEdit } from "../edit-scope.ts";
import { decodeJson, isString, jsonObject } from "../json.ts";

export async function grokPermission(
  spec: ThreadSpec,
  entry: AcpPermissionEntry | undefined,
  request: PermissionRequest,
  signal: AbortSignal,
  interact: (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionResponse>,
): Promise<PermissionResult> {
  const select = (allow: boolean): PermissionResult => {
    const option =
      request.options.find((row) => row.kind === (allow ? "allow_once" : "reject_once")) ??
      request.options.find((row) => row.kind === (allow ? "allow_always" : "reject_always"));

    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };

  if (!entry?.turnId || signal.aborted) return { outcome: { outcome: "cancelled" } };

  if (entry.mode === PermissionMode.READ_ONLY) return select(false);

  if (entry.mode === PermissionMode.FULL_AUTO || entry.mode === PermissionMode.FULL_ACCESS) return select(true);

  if (entry.mode === PermissionMode.ACCEPT_EDITS) {
    const name = request.toolCall.title ?? "";
    const args = jsonObject(decodeJson(request.toolCall.rawInput ?? null));
    const targets = [args?.["path"], args?.["file_path"], args?.["filePath"]].filter(isString);

    if (
      /^(write_file|edit_file|str_replace_editor)$/.test(name) &&
      targets.length > 0 &&
      targets.every((path) => workspaceEdit(spec.cwd, path))
    )
      return select(true);
  }

  const grantKey = JSON.stringify([request.toolCall.title, request.toolCall.rawInput]);

  return askAcpPermission(spec, entry, request, signal, { toolLabel: "Grok tool", select, grantKey }, interact);
}

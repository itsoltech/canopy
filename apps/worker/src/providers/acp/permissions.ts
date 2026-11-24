import { create } from "@bufbuild/protobuf";
import type { PermissionRequest, PermissionResult } from "@canopy/acp";
import {
  InteractionKind,
  InteractionRequestSchema,
  type PermissionMode,
  type InteractionRequest,
  type InteractionResponse,
  type ThreadSpec,
} from "@canopy/contracts";
import { decodeJson } from "../json.ts";
import { threadSecretOutputGuard } from "../../runtime/thread-secrets.ts";
import { redactToolOutput } from "../secret-tool-output.ts";

export interface AcpPermissionEntry {
  turnId: string;
  mode: PermissionMode;
  approvals: Set<string>;
  /** Latest tools/list replies from authenticated MCP bridges owned by this process. */
  mcpTools: ReadonlyMap<string, ReadonlySet<string>>;
}

export function selectPermission(request: PermissionRequest, allow: boolean): PermissionResult {
  const option = request.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));

  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export async function askAcpPermission(
  spec: ThreadSpec,
  entry: AcpPermissionEntry,
  request: PermissionRequest,
  signal: AbortSignal,
  choice: { toolLabel: string; grantKey: string | undefined; select(allow: boolean): PermissionResult },
  interact: (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionResponse>,
): Promise<PermissionResult> {
  if (choice.grantKey !== undefined && entry.approvals.has(choice.grantKey)) return choice.select(true);
  const { redact } = threadSecretOutputGuard(spec.threadId);
  const { rawInput, content, locations } = request.toolCall;

  const details = {
    ...(rawInput !== undefined && { input: decodeJson(rawInput) }),
    ...(content && { content: decodeJson(content) }),
    ...(locations && { locations: decodeJson(locations) }),
  };

  const answer = await interact(
    create(InteractionRequestSchema, {
      requestId: crypto.randomUUID(),
      threadId: spec.threadId,
      turnId: entry.turnId,
      itemId: `${entry.turnId}:${request.toolCall.toolCallId}`,
      kind: InteractionKind.PERMISSION,
      toolName: redact(request.toolCall.title ?? choice.toolLabel),
      requestJson: JSON.stringify(redactToolOutput(details, redact)),
    }),
    signal,
  );

  if (answer.allow && answer.allowForSession && !answer.cancelled && !signal.aborted && choice.grantKey !== undefined)
    entry.approvals.add(choice.grantKey);

  return signal.aborted || answer.cancelled ? { outcome: { outcome: "cancelled" } } : choice.select(answer.allow);
}

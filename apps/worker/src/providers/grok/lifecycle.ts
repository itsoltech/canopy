import { create } from "@bufbuild/protobuf";
import type { PermissionRequest, PermissionResult } from "@canopy/grok-acp";
import {
  InteractionKind,
  InteractionRequestSchema,
  PermissionMode,
  type InteractionRequest,
  type InteractionResponse,
  type ThreadSpec,
} from "@canopy/contracts";

export type GrokCleanup = (() => void | Promise<void>) | undefined;

export interface GrokPermissionEntry {
  turnId: string;
  mode: PermissionMode;
  approvals: Set<string>;
}

/** Run every cleanup, preserving later resources even when an earlier close fails. */
export async function closeGrokResources(cleanups: readonly GrokCleanup[]): Promise<void> {
  const errors: unknown[] = [];

  for (const cleanup of cleanups) {
    if (!cleanup) continue;

    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];

  if (errors.length > 1) throw new AggregateError(errors, "Grok resource cleanup failed");
}

export async function grokPermission(
  spec: ThreadSpec,
  entry: GrokPermissionEntry | undefined,
  request: PermissionRequest,
  signal: AbortSignal,
  interact: (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionResponse>,
): Promise<PermissionResult> {
  const selected = (allow: boolean): PermissionResult => {
    const option =
      request.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ??
      request.options.find((o) => o.kind === (allow ? "allow_always" : "reject_always"));

    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };

  if (!entry?.turnId || signal.aborted) return { outcome: { outcome: "cancelled" } };

  if (entry.mode === PermissionMode.READ_ONLY) return selected(false);

  if (entry.mode === PermissionMode.FULL_AUTO || entry.mode === PermissionMode.FULL_ACCESS) return selected(true);

  if (
    entry.mode === PermissionMode.ACCEPT_EDITS &&
    (request.toolCall.kind === "edit" ||
      /^(write_file|edit_file|apply_patch|str_replace_editor)$/.test(request.toolCall.title ?? ""))
  )
    return selected(true);
  const approval = JSON.stringify([request.toolCall.title, request.toolCall.rawInput]);

  if (entry.approvals.has(approval)) return selected(true);

  const answer = await interact(
    create(InteractionRequestSchema, {
      requestId: crypto.randomUUID(),
      threadId: spec.threadId,
      turnId: entry.turnId,
      itemId: `${entry.turnId}:${request.toolCall.toolCallId}`,
      kind: InteractionKind.PERMISSION,
      toolName: request.toolCall.title ?? "Grok tool",
      requestJson: JSON.stringify({ input: request.toolCall.rawInput }),
    }),
    signal,
  );

  if (answer.allow && answer.allowForSession && !signal.aborted) entry.approvals.add(approval);

  return signal.aborted || answer.cancelled ? { outcome: { outcome: "cancelled" } } : selected(answer.allow);
}

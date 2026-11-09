import { create } from "@bufbuild/protobuf";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { InteractionKind, InteractionRequestSchema, type ThreadSpec } from "@canopy/contracts";
import { decodeJson } from "../json.ts";
import { BUS_SERVER } from "./mapping.ts";
import { autoAllows, type AutoAllow } from "./permissions.ts";

import type { ClaudeThreadsOptions } from "./thread-types.ts";

export function sessionPermissions(options: ClaudeThreadsOptions) {
  const canUseTool =
    (spec: ThreadSpec, turnId: () => string, autoAllow: () => AutoAllow): CanUseTool =>
    async (toolName, input, context) => {
      if (toolName.startsWith(`mcp__${BUS_SERVER}__`) && context.mcpServer?.source === "sdk")
        return { behavior: "allow", updatedInput: input };
      const question = toolName === "AskUserQuestion";

      if (!question && autoAllows(autoAllow(), toolName)) return { behavior: "allow", updatedInput: input };

      const answer = await options.interact(
        create(InteractionRequestSchema, {
          requestId: Bun.randomUUIDv7(),
          threadId: spec.threadId,
          turnId: turnId(),
          itemId: context.toolUseID,
          kind: question ? InteractionKind.QUESTION : InteractionKind.PERMISSION,
          toolName,
          requestJson: JSON.stringify({
            input,
            ...(context.title && { title: context.title }),
            ...(context.description && { description: context.description }),
            ...(context.decisionReason && { reason: context.decisionReason }),
            ...(context.blockedPath && { blockedPath: context.blockedPath }),
          }),
        }),
      );

      if (answer.cancelled) return { behavior: "deny", message: "cancelled by the user", interrupt: true };

      if (question) {
        const answers = answer.answerJson ? decodeJson(JSON.parse(answer.answerJson)) : {};

        return { behavior: "allow", updatedInput: { ...input, answers } };
      }

      return answer.allow
        ? {
            behavior: "allow",
            updatedInput: input,
            ...(answer.allowForSession && context.suggestions && { updatedPermissions: context.suggestions }),
          }
        : { behavior: "deny", message: answer.message || "denied by the user" };
    };

  return canUseTool;
}

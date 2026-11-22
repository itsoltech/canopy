import { create } from "@bufbuild/protobuf";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { InteractionKind, InteractionRequestSchema, type ThreadSpec } from "@canopy/contracts";
import { decodeJson, isString } from "../json.ts";
import { workspaceEdit } from "../edit-scope.ts";
import { BUS_SERVER } from "./mapping.ts";
import { autoAllows, type AutoAllow } from "./permissions.ts";

import type { ClaudeThreadsOptions } from "./thread-types.ts";

const editorPath = new Map([
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
]);

export function sessionPermissions(options: ClaudeThreadsOptions) {
  const canUseTool =
    (spec: ThreadSpec, turnId: () => string, autoAllow: () => AutoAllow): CanUseTool =>
    async (toolName, input, context) => {
      if (spec.sandboxProfile && toolName === "SandboxNetworkAccess")
        return { behavior: "deny", message: "The Sandbox profile does not allow this destination." };

      if (toolName.startsWith(`mcp__${BUS_SERVER}__`) && context.mcpServer?.source === "sdk")
        return { behavior: "allow", updatedInput: input };
      const question = toolName === "AskUserQuestion";

      const policy = autoAllow();
      const field = editorPath.get(toolName);
      const path = field ? input[field] : undefined;

      if (
        policy !== "all" &&
        autoAllows(policy, toolName) &&
        field &&
        (!isString(path) ||
          !workspaceEdit(spec.cwd, path) ||
          (context.blockedPath && !workspaceEdit(spec.cwd, context.blockedPath)))
      )
        return { behavior: "deny", message: "This edit is outside the thread's workspace." };

      if (!question && autoAllows(policy, toolName)) return { behavior: "allow", updatedInput: input };

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

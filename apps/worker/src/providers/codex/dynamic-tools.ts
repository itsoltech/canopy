import { create } from "@bufbuild/protobuf";
import type { v2 } from "@canopy/codex-protocol";
import { AgentToolCallSchema, InteractionKind, InteractionRequestSchema, type ThreadSpec } from "@canopy/contracts";
import { agentBusToolSpecs, agentBusToolsFor, isPlatformServer, PLATFORM_SERVER, viewImageSpec } from "@canopy/domain";
import { Schema } from "effect";
import { decodeJson, jsonObject, jsonString } from "../json.ts";
import { toolCallId } from "../tool-call-id.ts";
import type { ServerRequestHandler } from "./app-server.ts";
import { RpcError } from "./rpc.ts";

import type { CodexThreadContext } from "./thread-types.ts";

/**
 * Name of the platform's view_image among Codex's dynamic tools. Codex has a built-in tool of that name (local image
 * files for models that take images), so the platform's is namespaced (docs/codex-adapter.md, "view_image").
 */
export const CODEX_VIEW_IMAGE_TOOL = "view_image";
export const CODEX_VIEW_IMAGE_NAMESPACE = PLATFORM_SERVER;

export function codexViewImageTool(): v2.DynamicToolSpec {
  const spec = viewImageSpec();

  return {
    type: "namespace",
    name: CODEX_VIEW_IMAGE_NAMESPACE,
    description: "Canopy platform tools.",
    tools: [
      {
        type: "function",
        name: CODEX_VIEW_IMAGE_TOOL,
        description: spec.description,
        inputSchema: decodeJson(spec.inputSchema),
      },
    ],
  };
}

/**
 * Agent bus tools for a thread, as Codex dynamic tools. Codex accepts them only in thread/start and keeps
 * them with the thread (verified live: across resume in a new process and in forks). A fork therefore has
 * its source's tools; the gateway authorizes every call by the caller's depth anyway.
 * Goals are Codex's own (thread/goal/*), not agent bus tools.
 */
export function codexAgentBusTools(depth: number): v2.DynamicToolSpec[] {
  return agentBusToolSpecs(agentBusToolsFor(depth)).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    inputSchema: decodeJson(tool.inputSchema),
  }));
}

/** Dynamic tools of a new thread: the agent bus (when enabled) and view_image. */
export function dynamicTools(spec: ThreadSpec, viewImage: boolean): { dynamicTools?: v2.DynamicToolSpec[] } {
  const tools = [
    ...(spec.enableAgentBus ? codexAgentBusTools(spec.depth) : []),
    ...(viewImage ? [codexViewImageTool()] : []),
  ];

  return tools.length > 0 ? { dynamicTools: tools } : {};
}

export function isViewImageCall(call: { namespace?: string | null; tool: string }): boolean {
  return call.tool === CODEX_VIEW_IMAGE_TOOL && isPlatformServer(call.namespace);
}

export function serverRequestHandler(ctx: CodexThreadContext): ServerRequestHandler {
  const { options, byCodex, connectorCatalog } = ctx;

  return async (request) => {
    const params = Schema.decodeUnknownSync(
      Schema.Struct({
        threadId: Schema.optionalKey(Schema.String),
        turnId: Schema.optionalKey(Schema.String),
        itemId: Schema.optionalKey(Schema.String),
      }),
    )(request.params);

    const entry = params.threadId ? byCodex.get(params.threadId) : undefined;

    const interact = (kind: InteractionKind, toolName: string) => {
      if (!entry) throw new RpcError(request.method, -32602, "unknown thread");

      return options.interact(
        create(InteractionRequestSchema, {
          requestId: Bun.randomUUIDv7(),
          threadId: entry.platformId,
          turnId: params.turnId ? (entry.codexToPlatform.get(params.turnId) ?? "") : "",
          itemId: params.itemId ?? "",
          kind,
          toolName,
          requestJson: JSON.stringify(params),
        }),
      );
    };

    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        const answer = await interact(
          InteractionKind.PERMISSION,
          request.method.includes("command") ? "shell" : "apply_patch",
        );

        return {
          decision: answer.cancelled
            ? "cancel"
            : answer.allow
              ? answer.allowForSession
                ? "acceptForSession"
                : "accept"
              : "decline",
        };
      }

      case "item/permissions/requestApproval": {
        const answer = await interact(InteractionKind.PERMISSION, "permissions");
        const requested = request.params.permissions;

        return { permissions: answer.allow ? requested : {}, scope: answer.allowForSession ? "session" : "turn" };
      }

      case "item/tool/requestUserInput": {
        const answer = await interact(InteractionKind.QUESTION, "request_user_input");

        return { answers: answer.cancelled || !answer.answerJson ? {} : JSON.parse(answer.answerJson) };
      }

      case "mcpServer/elicitation/request": {
        const answer = await interact(InteractionKind.ELICITATION, "mcp_elicitation");

        return answer.cancelled || !answer.answerJson
          ? { action: "decline" }
          : { action: "accept", content: JSON.parse(answer.answerJson) };
      }

      case "item/tool/call": {
        if (!entry) throw new RpcError(request.method, -32602, "unknown thread");
        const call = request.params;

        if (isViewImageCall(call) && options.viewImage) {
          const args = jsonObject(decodeJson(call.arguments ?? {}));
          const viewed = await options.viewImage(entry.platformId, jsonString(args?.["path"]));

          return (
            viewed.ok
              ? {
                  contentItems: [
                    { type: "inputImage", imageUrl: `data:${viewed.mimeType};base64,${viewed.base64}` },
                    { type: "inputText", text: viewed.summary },
                  ],
                  success: true,
                }
              : { contentItems: [{ type: "inputText", text: viewed.message }], success: false }
          ) satisfies v2.DynamicToolCallResponse;
        }

        const result = await options.callTool(
          create(AgentToolCallSchema, {
            callId: toolCallId(entry.platformId, call.callId),
            threadId: entry.platformId,
            turnId: entry.codexToPlatform.get(call.turnId) ?? "",
            itemId: call.callId,
            toolName: call.tool,
            connectorAccountId:
              connectorCatalog.get(entry.platformId)?.find((t) => t.name === call.tool)?.accountId ?? "",
            argumentsJson: JSON.stringify(call.arguments ?? {}),
          }),
        );

        return {
          contentItems: [{ type: "inputText", text: result.content }],
          success: !result.isError,
        } satisfies v2.DynamicToolCallResponse;
      }

      case "currentTime/read":
        return { currentTime: new Date().toISOString() };
      default:
        throw new RpcError(request.method, -32601, "not supported by the Canopy worker");
    }
  };
}

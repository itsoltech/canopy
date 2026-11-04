import type { MessageInitShape } from "@bufbuild/protobuf";
import type { FunctionCallOutputBody, v2 } from "@canopy/codex-protocol";
import { ItemStatus, type ItemSchema } from "@canopy/contracts";
import { isAgentBusTool, isPlatformServer, VIEW_IMAGE_TOOL, type JsonObject } from "@canopy/domain";
import { decodeJson, decodeJsonObject, isString, jsonObject, jsonString } from "../json.ts";

type ItemInit = MessageInitShape<typeof ItemSchema>;

type CodexItem = v2.ThreadItem;

export function mapItem(item: CodexItem, completed: boolean): ItemInit {
  const base = { itemId: item.id };
  const lifecycle = completed ? ItemStatus.COMPLETED : ItemStatus.IN_PROGRESS;

  switch (item.type) {
    case "userMessage":
      return {
        ...base,
        status: lifecycle,
        content: {
          case: "userMessage",
          value: {
            text: item.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n"),
            // turn/start and turn/steer send the platform's id (turn id, steer input id) as clientUserMessageId.
            ...(item.clientId && { clientId: item.clientId }),
          },
        },
      };
    case "agentMessage":
      return {
        ...base,
        status: lifecycle,
        content: { case: "agentMessage", value: { text: item.text, phase: item.phase ?? "" } },
      };
    case "reasoning":
      return {
        ...base,
        status: lifecycle,
        content: { case: "reasoning", value: { text: item.content.join("\n"), summary: item.summary.join("\n") } },
      };
    case "commandExecution":
      return {
        ...base,
        status: toolStatus(item.status),
        content: {
          case: "commandExecution",
          value: {
            command: item.command,
            cwd: item.cwd,
            output: item.aggregatedOutput ?? "",
            ...(item.exitCode !== null && { exitCode: item.exitCode }),
            ...(item.durationMs !== null && { durationMs: BigInt(item.durationMs) }),
          },
        },
      };
    case "fileChange":
      return {
        ...base,
        status: toolStatus(item.status),
        content: {
          case: "fileChange",
          value: {
            changes: item.changes.map((change) => ({
              path: change.path,
              kind: change.kind.type === "update" && change.kind.move_path ? "move" : change.kind.type,
              diff: change.diff,
              ...(change.kind.type === "update" && change.kind.move_path && { movePath: change.kind.move_path }),
            })),
          },
        },
      };
    case "mcpToolCall":
      return {
        ...base,
        status: toolStatus(item.status),
        content: {
          case: "toolCall",
          value: {
            server: item.server,
            name: item.tool,
            inputJson: JSON.stringify(item.arguments ?? null),
            output: item.error ? item.error.message : item.result ? JSON.stringify(item.result.content) : "",
            isError: item.error !== null || item.status === "failed",
          },
        },
      };
    case "dynamicToolCall":
      return mapDynamicTool(item);
    case "webSearch":
      return { ...base, status: lifecycle, content: { case: "webSearch", value: { query: item.query } } };
    case "plan":
      return { ...base, status: lifecycle, content: { case: "plan", value: { text: item.text } } };
    case "imageView":
      // Codex's own view_image: the worker reads the file for the preview (images/previews.ts).
      return { ...base, status: lifecycle, content: { case: "image", value: { path: item.path, source: "native" } } };
    case "imageGeneration":
      return {
        ...base,
        status: item.failure ? ItemStatus.FAILED : lifecycle,
        content: {
          case: "image",
          value: { path: item.savedPath ?? "", prompt: item.revisedPrompt ?? "", source: "generated" },
        },
      };
    case "contextCompaction":
      return { ...base, status: lifecycle, content: { case: "contextCompaction", value: {} } };
    case "collabAgentToolCall":
      return {
        ...base,
        status: lifecycle,
        content: {
          case: "subagent",
          value: {
            agentType: item.tool,
            prompt: item.prompt ?? "",
            model: item.model ?? "",
            providerThreadId: item.receiverThreadIds[0] ?? "",
          },
        },
      };
    default:
      // hookPrompt, review mode, sleep, functionCallOutput, subAgentActivity, and future types: kept whole.
      return {
        ...base,
        status: lifecycle,
        content: { case: "providerItem", value: { type: item.type, json: JSON.stringify(item) } },
      };
  }
}

export function providerToolCall(
  callId: string,
  call: { name: string; inputJson: string; outputs: string[] },
  completed: boolean,
): ItemInit {
  return {
    itemId: callId,
    status: completed ? ItemStatus.COMPLETED : ItemStatus.IN_PROGRESS,
    content: {
      case: "toolCall",
      value: { name: call.name, inputJson: call.inputJson, output: call.outputs.join("\n") },
    },
  };
}

/** A `commandExecution`-like item from the call and its output ("Process exited with code N ... Output:\n..."). */
export function shellCommandItem(
  callId: string,
  call: { name: string; arguments: string; output?: FunctionCallOutputBody },
): ItemInit {
  let args: JsonObject = {};

  try {
    args = decodeJsonObject(JSON.parse(call.arguments));
  } catch {
    // Not JSON: shown as the command below.
  }

  const command = isString(args["cmd"])
    ? args["cmd"]
    : Array.isArray(args["command"])
      ? args["command"].join(" ")
      : isString(args["command"])
        ? args["command"]
        : call.arguments;

  const text = call.output === undefined ? "" : outputText(call.output);
  const exit = /Process exited with code (-?\d+)/.exec(text);
  const marker = text.indexOf("Output:\n");
  const exitCode = exit ? Number(exit[1]) : undefined;

  return {
    itemId: callId,
    status: exitCode !== undefined && exitCode !== 0 ? ItemStatus.FAILED : ItemStatus.COMPLETED,
    content: {
      case: "commandExecution",
      value: {
        command,
        cwd: jsonString(args["workdir"]),
        output: marker >= 0 ? text.slice(marker + "Output:\n".length) : text,
        ...(exitCode !== undefined && { exitCode }),
      },
    },
  };
}

export function outputText(body: FunctionCallOutputBody): string {
  return isString(body)
    ? body
    : body.map((part) => (part.type === "input_text" ? part.text : `[${part.type}]`)).join("\n");
}

function toolStatus(status: "inProgress" | "completed" | "failed" | "declined"): ItemStatus {
  switch (status) {
    case "inProgress":
      return ItemStatus.IN_PROGRESS;
    case "completed":
      return ItemStatus.COMPLETED;
    case "failed":
      return ItemStatus.FAILED;
    case "declined":
      return ItemStatus.DECLINED;
  }
}

function mapDynamicTool(item: Extract<CodexItem, { type: "dynamicToolCall" }>): ItemInit {
  const base = { itemId: item.id };
  const output = (item.contentItems ?? []).map((c) => (c.type === "inputText" ? c.text : `[${c.type}]`)).join("\n");

  // The platform's view_image (namespace "canopy"): an image item; the preview comes from its result.
  if (item.tool === VIEW_IMAGE_TOOL && isPlatformServer(item.namespace)) {
    const path = jsonObject(decodeJson(item.arguments ?? null))?.["path"];

    return {
      ...base,
      status: toolStatus(item.status),
      content: {
        case: "image",
        value: {
          path: jsonString(path),
          source: VIEW_IMAGE_TOOL,
          ...(item.success === false && { detail: output }),
        },
      },
    };
  }

  if (isAgentBusTool(item.tool)) {
    return {
      ...base,
      status: toolStatus(item.status),
      content: {
        case: "agentBusCall",
        value: {
          callId: item.id,
          toolName: item.tool,
          argumentsJson: JSON.stringify(item.arguments ?? null),
          resultJson: output,
          isError: item.success === false,
        },
      },
    };
  }

  return {
    ...base,
    status: toolStatus(item.status),
    content: {
      case: "toolCall",
      value: {
        server: item.namespace ?? "",
        name: item.tool,
        inputJson: JSON.stringify(item.arguments ?? null),
        output,
        isError: item.success === false,
      },
    },
  };
}

import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ItemSchema } from "@canopy/contracts";
import { isAgentBusTool, isPlatformServer, VIEW_IMAGE_TOOL, type JsonValue } from "@canopy/domain";
import { Match } from "effect";
import { isString, jsonObject, jsonString } from "../json.ts";

type Content = NonNullable<MessageInitShape<typeof ItemSchema>["content"]>;

/** `mcp__canopy__x` → `x`. */
function platformTool(name: string): string | undefined {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);

  return mcp && isPlatformServer(mcp[1]) ? mcp[2] : undefined;
}

export function emptyContent(kind: "text" | "thinking"): Content {
  return kind === "text" ? { case: "agentMessage", value: { text: "" } } : { case: "reasoning", value: { text: "" } };
}

/** `final_answer` marks text of a message that ended its turn (stop reason `end_turn`, no tool use). */
export function textContent(kind: "text" | "thinking", text: string, final = false): Content {
  return kind === "text"
    ? { case: "agentMessage", value: { text, ...(final && { phase: "final_answer" }) } }
    : { case: "reasoning", value: { text } };
}

/** Claude Code tools as platform items; anything unknown is a generic tool call. */
export function toolContent(name: string, input: JsonValue | undefined): Content {
  const args = jsonObject(input) ?? {};
  const str = (key: string) => jsonString(args[key]);
  // The platform's view_image: an image item; its preview comes from the tool result (images/previews.ts).
  const platform = platformTool(name);

  if (platform === VIEW_IMAGE_TOOL) return { case: "image", value: { path: str("path"), source: VIEW_IMAGE_TOOL } };

  if (platform && isAgentBusTool(platform)) {
    return { case: "agentBusCall", value: { toolName: platform, argumentsJson: JSON.stringify(args) } };
  }

  switch (name) {
    case "Bash":
    case "PowerShell":
      return { case: "commandExecution", value: { command: str("command") } };
    case "Write":
      return {
        case: "fileChange",
        value: { changes: [{ path: str("file_path"), kind: "add", diff: prefixLines(str("content"), "+") }] },
      };
    case "Edit":
      return {
        case: "fileChange",
        value: {
          changes: [{ path: str("file_path"), kind: "update", diff: editDiff(str("old_string"), str("new_string")) }],
        },
      };
    case "MultiEdit": {
      const edits = Array.isArray(args["edits"])
        ? args["edits"].flatMap((value) => {
            const edit = jsonObject(value);

            return edit ? [edit] : [];
          })
        : [];

      const diff = edits.map((e) => editDiff(jsonString(e["old_string"]), jsonString(e["new_string"]))).join("\n");

      return { case: "fileChange", value: { changes: [{ path: str("file_path"), kind: "update", diff }] } };
    }

    case "NotebookEdit":
      return {
        case: "fileChange",
        value: { changes: [{ path: str("notebook_path"), kind: "update", diff: prefixLines(str("new_source"), "+") }] },
      };
    case "WebSearch":
      return { case: "webSearch", value: { query: str("query") } };
    case "TodoWrite": {
      const todos = Array.isArray(args["todos"])
        ? args["todos"].flatMap((value) => {
            const todo = jsonObject(value);

            return todo ? [todo] : [];
          })
        : [];

      return {
        case: "todoList",
        value: { items: todos.map((t) => ({ text: jsonString(t["content"]), status: jsonString(t["status"]) })) },
      };
    }

    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);

      return {
        case: "toolCall",
        value: { server: mcp?.[1] ?? "", name: mcp?.[2] ?? name, inputJson: JSON.stringify(args) },
      };
    }
  }
}

export function withOutput(content: Content, output: string, failed: boolean): Content {
  switch (content.case) {
    case "commandExecution":
      return { case: "commandExecution", value: { ...content.value, output } };
    case "toolCall":
      return { case: "toolCall", value: { ...content.value, output, isError: failed } };
    case "agentBusCall":
      return { case: "agentBusCall", value: { ...content.value, resultJson: output, isError: failed } };
    case "webSearch":
      return { case: "webSearch", value: { ...content.value, resultsJson: output } };
    case "image":
      return failed ? { case: "image", value: { ...content.value, detail: output } } : content;
    default:
      return content;
  }
}

export function resultText(content: JsonValue | undefined): string {
  if (isString(content)) return content;

  if (!Array.isArray(content)) return "";

  return content
    .map((value) => {
      const c = jsonObject(value);

      return Match.value(c?.["type"]).pipe(
        Match.when("text", () => jsonString(c?.["text"])),
        Match.when("tool_reference", () => `[${c?.["tool_name"]}]`),
        Match.orElse(() => `[${c?.["type"]}]`),
      );
    })
    .join("\n");
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function editDiff(before: string, after: string): string {
  return [prefixLines(before, "-"), prefixLines(after, "+")].filter(Boolean).join("\n");
}

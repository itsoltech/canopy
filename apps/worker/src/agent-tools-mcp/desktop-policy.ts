import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolCall } from "./protocol.ts";
import { bindSessionArguments } from "./session-policy.ts";

type Call = z.infer<typeof ToolCall>;

const blockedTools = new Set(["desktop_session_start", "desktop_session_gc", "desktop_sandbox_exec"]);
const sessionEnd = z.object({ id: z.string().nullish() }).catchall(z.json());
const batchInput = z.object({ commands_json: z.string() });

const batchCommands = z
  .array(
    z.object({ command: z.string(), session: z.string().optional(), args: z.json().optional() }).catchall(z.json()),
  )
  .max(64);

const sessionAction = z.object({ action: z.string().nullish() }).catchall(z.json());

const SESSION_INSTRUCTIONS =
  "Desktop automation and Preview share this thread's fixed session. Omit session: startup flags select it, and Desktop tools do not accept session or extraArgs per call. Do not create another session or bypass this boundary through shell, CLI or sandbox commands. If the task requires a separate session, explain this limitation to the user.";

function bindEnd(args: Call["arguments"], session: string): Call["arguments"] {
  const parsed = sessionEnd.parse(args);

  if (parsed.id != null && parsed.id !== session) throw new Error(SESSION_INSTRUCTIONS);

  return { ...parsed, id: session };
}

function bindBatch(args: Call["arguments"], session: string): Call["arguments"] {
  const input = batchInput.parse(args);

  if (Buffer.byteLength(input.commands_json) > 1024 * 1024) throw new Error("Desktop batch JSON exceeds 1 MiB");

  const commands = batchCommands.parse(JSON.parse(input.commands_json)).map((item) => {
    const bound = bindSessionArguments(item, session);

    if (item.command === "sandbox") throw new Error(SESSION_INSTRUCTIONS);
    let boundArgs = item.args;

    if (item.command === "session") {
      const action = sessionAction.parse(item.args ?? {});

      if (action.action === "start" || action.action === "gc") throw new Error(SESSION_INSTRUCTIONS);

      if (action.action === "end") boundArgs = bindEnd(action, session);
    }

    return { ...bound, ...(boundArgs !== undefined && { args: boundArgs }) };
  });

  return { ...args, commands_json: JSON.stringify(commands) };
}

/** Desktop forwards startup globals itself; only supported nested session selectors are rewritten. */
export function bindDesktopCall(params: Call, session: string): Call {
  if (blockedTools.has(params.name)) throw new Error(SESSION_INSTRUCTIONS);

  if (params.name === "desktop_batch") return { ...params, arguments: bindBatch(params.arguments, session) };

  if (params.name === "desktop_session_end") return { ...params, arguments: bindEnd(params.arguments, session) };

  return params;
}

export function desktopCatalog(tools: Tool[], session: string): Tool[] {
  return tools.flatMap((tool) => {
    if (blockedTools.has(tool.name)) return [];
    const properties = { ...tool.inputSchema.properties };

    if (tool.name === "desktop_session_end")
      properties["id"] = {
        type: "string",
        enum: [session],
        description: "This thread's desktop session. Omit to use it automatically.",
      };

    const batchInstructions =
      tool.name === "desktop_batch"
        ? " Batch entries use {command, session?, args?}; omit session or use this thread's session. Session start, global session gc and sandbox commands are unavailable; session end can only target this thread."
        : "";

    return [
      {
        ...tool,
        description: `${tool.description ?? ""}\n${SESSION_INSTRUCTIONS}${batchInstructions}`,
        inputSchema: { ...tool.inputSchema, properties },
      },
    ];
  });
}

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ItemDeltaField, ItemStatus } from "@canopy/contracts";
import { claudeProfileOptions } from "../providers/claude/profile.ts";
import { claudeExecutable } from "../providers/claude/executable.ts";
import { transcriptPath } from "../providers/claude/transcript.ts";
import { isClaudeEffort } from "../providers/models.ts";
import { statSync } from "node:fs";
import { botPrompt } from "./session.ts";
import type { BotHarnessContext } from "./types.ts";
import { BotHarnessFailure } from "./types.ts";

/** Official Claude SDK, with an empty built-in tool set and only Canopy MCP. */
export async function runClaudeBot(ctx: BotHarnessContext): Promise<void> {
  const { input, session, signal } = ctx;
  const resumed = Boolean(session.id && transcriptPath(session.home, session.id));
  const id = resumed ? session.id : crypto.randomUUID();
  session.save(id);
  const path = resumed ? transcriptPath(session.home, id) : undefined;
  await ctx.noteHarness({
    harness: "claude",
    transcript: session.home,
    sessionId: id,
    offset: path ? statSync(path).size : 0,
    providerTurn: "",
  });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });

  if (signal.aborted) cancel();
  const allowedTools = input.tools.map((t) => `mcp__canopy__${t.name}`);

  const q = query({
    prompt: botPrompt(input, resumed),
    options: {
      ...claudeProfileOptions(ctx.profile, {
        ...process.env,
        CLAUDE_CONFIG_DIR: session.home,
        ENABLE_TOOL_SEARCH: "false",
      }),
      pathToClaudeCodeExecutable: claudeExecutable(ctx.executable),
      cwd: session.cwd,
      model: input.model,
      ...(isClaudeEffort(input.effort) && { effort: input.effort }),
      ...(resumed ? { resume: id } : { sessionId: id }),
      persistSession: true,
      settingSources: [],
      tools: [],
      allowedTools,
      strictMcpConfig: true,
      mcpServers: input.tools.length ? { canopy: { type: "http", ...ctx.mcp, alwaysLoad: true } } : {},
      plugins: [],
      settings: { disableAllHooks: true },
      systemPrompt: input.instructions,
      maxTurns: 32,
      includePartialMessages: true,
      abortController: abort,
    },
  });

  let messageId = "";

  try {
    for await (const message of q) {
      if (message.type === "stream_event" && message.event.type === "message_start")
        messageId = message.event.message.id;

      if (
        message.type === "stream_event" &&
        message.event.type === "content_block_delta" &&
        message.event.delta.type === "text_delta"
      )
        await ctx.record({
          body: {
            case: "itemDelta",
            value: {
              itemId: `${messageId}:${message.event.index}`,
              field: ItemDeltaField.TEXT,
              chunk: message.event.delta.text,
            },
          },
        });

      if (message.type === "assistant") {
        if (message.error)
          throw new BotHarnessFailure(
            message.error,
            message.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          );

        for (const [index, block] of message.message.content.entries()) {
          if (block.type !== "text") continue;
          await ctx.record({
            body: {
              case: "itemCompleted",
              value: {
                item: {
                  itemId: `${message.message.id}:${index}`,
                  status: ItemStatus.COMPLETED,
                  content: { case: "agentMessage", value: { text: block.text } },
                },
              },
            },
          });
        }
      }

      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error)
          throw new BotHarnessFailure(
            message.subtype === "success" ? "error_result" : message.subtype,
            message.subtype === "success" ? message.result : message.errors.join("; "),
          );

        return;
      }
    }

    throw new BotHarnessFailure("process_exit");
  } finally {
    signal.removeEventListener("abort", cancel);
    abort.abort();
    q.close();
  }
}

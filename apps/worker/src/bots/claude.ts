import { query, type SDKUserMessage, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeEventMapper } from "../providers/claude/mapping.ts";
import { claudeProfileOptions } from "../providers/claude/profile.ts";
import { claudeExecutable } from "../providers/claude/executable.ts";
import { transcriptPath } from "../providers/claude/transcript.ts";
import { isClaudeEffort } from "../providers/models.ts";
import { statSync } from "node:fs";
import { botPrompt } from "./session.ts";
import type { BotHarnessContext } from "./types.ts";
import { BotHarnessFailure } from "./types.ts";
import { rejectBotToolApproval } from "./failures.ts";
import { spawnClaude } from "../providers/claude/spawn.ts";

function botClaudeProcess() {
  let done = Promise.resolve();

  return {
    spawn: (options: SpawnOptions) => {
      const child = spawnClaude(options);
      done = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });

      return child;
    },
    closed: () => done,
  };
}

/** Official Claude SDK, with an empty built-in tool set and only Canopy MCP. */
export async function runClaudeBot(ctx: BotHarnessContext): Promise<void> {
  const { input, session, signal } = ctx;
  signal.throwIfAborted();
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
  const allowedTools = input.tools.map((t) => `mcp__canopy__${t.name}`);
  const profile = claudeProfileOptions(ctx.profile, process.env);
  const images = await ctx.images(resumed);
  signal.throwIfAborted();
  const harness = botClaudeProcess();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      session_id: id,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: botPrompt(input, resumed) },
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType,
              data: Buffer.from(image.data).toString("base64"),
            },
          })),
        ],
      },
    };
  }

  const q = query({
    prompt: images.length ? prompt() : botPrompt(input, resumed),
    options: {
      ...profile,
      env: {
        ...profile.env,
        CLAUDE_CONFIG_DIR: session.home,
        ENABLE_TOOL_SEARCH: "false",
      },
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
      spawnClaudeCodeProcess: harness.spawn,
    },
  });

  const mapper = new ClaudeEventMapper(input.turnId);
  const textItems = new Set<string>();

  try {
    for await (const message of q) {
      signal.throwIfAborted();

      if (message.type === "assistant") {
        if (message.error)
          throw new BotHarnessFailure(
            message.error,
            message.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          );
      }

      // SDK assistant messages may contain only one block: its array index is not the stream index.
      // The thread mapper matches completed text to the open streamed block, including after thinking/tools.
      for (const event of mapper.map(message)) {
        const body = event.body;

        if (body?.case === "itemStarted" && body.value.item?.content?.case === "agentMessage")
          textItems.add(body.value.item.itemId!);

        if (
          (body?.case === "itemDelta" && textItems.has(body.value.itemId!)) ||
          (body?.case === "itemCompleted" && body.value.item?.content?.case === "agentMessage")
        )
          await ctx.record(event);
      }

      if (message.type === "result") {
        if (message.permission_denials?.some((denial) => allowedTools.includes(denial.tool_name)))
          await rejectBotToolApproval(ctx);

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
    await harness.closed();
  }
}

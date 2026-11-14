import { query, type SDKUserMessage, type SpawnOptions, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeEventMapper } from "../providers/claude/mapping.ts";
import { claudeProfileOptions } from "../providers/claude/profile.ts";
import { claudeExecutable } from "../providers/claude/executable.ts";
import { transcriptPath } from "../providers/claude/transcript.ts";
import { isClaudeEffort } from "../providers/models.ts";
import { statSync } from "node:fs";
import type { BotHarnessContext } from "./types.ts";
import { BotHarnessFailure } from "./types.ts";
import { rejectBotToolApproval } from "./failures.ts";
import { spawnClaude } from "../providers/claude/spawn.ts";
import { ClaudeUsage } from "../providers/claude/usage.ts";
import { NoticeLevel } from "@canopy/contracts";
import { claudeLimitError } from "../providers/usage-limits.ts";

async function observeUsage(ctx: BotHarnessContext, usage: ClaudeUsage, message: SDKMessage) {
  if (usage.observe(message))
    await ctx.record({
      body: {
        case: "notice",
        value: { code: "extra_usage", level: NoticeLevel.WARNING, message: "This turn uses extra usage credits." },
      },
    });
}

async function noteSession(ctx: BotHarnessContext, id: string, resumed: boolean) {
  const path = resumed ? transcriptPath(ctx.session.home, id) : undefined;

  await ctx.noteHarness({
    harness: "claude",
    transcript: ctx.session.home,
    sessionId: id,
    offset: path ? statSync(path).size : 0,
    providerTurn: "",
  });
}

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

/** Official Claude SDK: optional web tools and Canopy MCP, without local tools. */
export async function runClaudeBot(ctx: BotHarnessContext): Promise<void> {
  const { input, session, signal } = ctx;
  signal.throwIfAborted();
  const resumed = Boolean(session.id && transcriptPath(session.home, session.id));
  const id = resumed ? session.id : crypto.randomUUID();
  session.save(id);
  await noteSession(ctx, id, resumed);
  const webTools = input.webAccess ? ["WebSearch", "WebFetch"] : [];
  const allowedTools = [...webTools, ...input.tools.map((t) => `mcp__canopy__${t.name}`)];
  const profile = claudeProfileOptions(ctx.profile, process.env);
  const content = await ctx.content(resumed);
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
          { type: "text", text: content.text },
          ...content.documents.map((document) => ({
            type: "document" as const,
            title: document.name,
            source: { type: "base64" as const, media_type: "application/pdf" as const, data: document.data },
          })),
          ...content.images.map((image) => ({
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
    prompt: content.images.length || content.documents.length ? prompt() : content.text,
    options: {
      ...profile,
      env: {
        ...profile.env,
        CLAUDE_CONFIG_DIR: session.home,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: session.secureStorageDir,
        ENABLE_TOOL_SEARCH: "false",
      },
      pathToClaudeCodeExecutable: claudeExecutable(ctx.executable),
      cwd: session.cwd,
      model: input.model,
      ...(isClaudeEffort(input.effort) && { effort: input.effort }),
      ...(resumed ? { resume: id } : { sessionId: id }),
      persistSession: true,
      settingSources: [],
      tools: webTools,
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
    const usage = new ClaudeUsage(ctx.onUsage, ctx.usageSnapshot);

    for await (const message of q) {
      signal.throwIfAborted();

      await observeUsage(ctx, usage, message);

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
            claudeLimitError(message.subtype === "success" ? message.result : message.errors.join("; "))
              ? "usage_limit"
              : message.subtype === "success"
                ? "error_result"
                : message.subtype,
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

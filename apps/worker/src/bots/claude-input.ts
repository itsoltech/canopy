import { AsyncChannel } from "@canopy/transport";
import { Schema } from "effect";
import type { BotContent } from "./images.ts";
import type { SDKUserMessage, SDKMessage, Query } from "@anthropic-ai/claude-agent-sdk";
import { BotHarnessFailure, type BotHarnessContext } from "./types.ts";
import { claudeFastAvailable } from "../providers/claude/service-tier.ts";

/** Match the caller's UUID, never text or queue admission, to the provider's consumed input. */
export async function consumedBotInput(ctx: BotHarnessContext, message: SDKMessage): Promise<boolean> {
  const lifecycle = Schema.decodeUnknownSync(
    Schema.Struct({
      type: Schema.String,
      command_uuid: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.String),
    }),
  )(message);

  // replay-user-messages acknowledges stdin admission while the preceding inference can still be running.
  let started = false;

  if (lifecycle.type === "command_lifecycle" && lifecycle.state === "started" && lifecycle.command_uuid) {
    await ctx.steering?.applied(lifecycle.command_uuid);
    started = true;
  }

  if ((message.type === "assistant" || message.type === "stream_event") && message.user_message_uuid)
    await ctx.steering?.applied(message.user_message_uuid);

  if (message.type === "result") {
    // A delivery-failure result can echo the rejected send's UUID without consuming it.
    const ids =
      message.user_message_uuids ??
      (message.subtype === "success" && !message.is_error && message.user_message_uuid
        ? [message.user_message_uuid]
        : []);

    for (const id of ids) await ctx.steering?.applied(id);
  }

  return started;
}

/** A queued Claude input can begin after the preceding result. Bound only that transition, never generation. */
export function nextBotMessage(
  next: Promise<IteratorResult<SDKMessage>>,
  signal: AbortSignal,
): Promise<IteratorResult<SDKMessage> | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(undefined), 60_000);
    const cancel = () => finish(undefined);

    const finish = (value: IteratorResult<SDKMessage> | undefined, error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);

      if (error) reject(error);
      else resolve(value);
    };

    signal.addEventListener("abort", cancel, { once: true });

    if (signal.aborted) cancel();
    void next.then(
      (value) => finish(value),
      (error: Error) => finish(undefined, error),
    );
  });
}

/** Keep stdin open for text steering while preserving native initial images and documents. */
export function botClaudePrompts(
  ctx: BotHarnessContext,
  sessionId: string,
  content: BotContent,
  admitted?: Promise<boolean>,
) {
  const prompts = new AsyncChannel<SDKUserMessage>();
  prompts.push({
    type: "user",
    session_id: sessionId,
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
  });
  ctx.steering?.ready(async (inputId, text) => {
    ctx.signal.throwIfAborted();

    const uuid = Schema.decodeUnknownSync(
      Schema.TemplateLiteral([
        Schema.String,
        "-",
        Schema.String,
        "-",
        Schema.String,
        "-",
        Schema.String,
        "-",
        Schema.String,
      ]),
    )(inputId);

    if (
      !prompts.push({
        type: "user",
        uuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        priority: "next",
        message: { role: "user", content: text },
      })
    )
      throw new Error("Bot input closed");
  });

  return {
    close: () => prompts.close(),
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      // Gate the entire queue: steers cannot bypass the fast account/model preflight either.
      if (admitted && !(await admitted)) return;

      yield* prompts;
    },
  };
}

/** Denied fast mode must never send a prompt to the subprocess. */
export async function admitClaudeBotInput(query: Query, fast: boolean, model: string, signal: AbortSignal) {
  if (fast && !claudeFastAvailable(await query.initializationResult(), model))
    throw new BotHarnessFailure("SERVICE_TIER_UNAVAILABLE", "Fast speed is unavailable for this model and account.");

  signal.throwIfAborted();

  return true;
}

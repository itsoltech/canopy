import { Schema } from "effect";
import { Invalid } from "../../store/store.ts";
import { botConfiguration } from "../store-views.ts";
import { define, object, str, type ToolContext } from "./shared.ts";

export const BOT_FILE_TOOLS = [
  "list_files",
  "read_file",
  "write_file",
  "delete_file",
  "download_file",
  "send_attachment",
];

export async function botFileCommand(ctx: ToolContext, operation: string) {
  const bot = await ctx.core.bots.run((s) => s.owned(ctx.options.userId, ctx.turn.bot_id));

  if (botConfiguration(bot).files === false || ctx.turn.handoff_configuration)
    throw new Invalid("Files are disabled for this bot. Enable Files in bot settings.");
  const job = await ctx.core.bots.run((s) => s.harnessTurn(ctx.turn.id));

  if (
    !job ||
    !(await ctx.core.bots.run((s) =>
      s.harnessAuthorized(ctx.options.userId, job.worker_id, ctx.turn.bot_id, ctx.turn.id),
    ))
  )
    throw new Invalid("This bot turn is no longer active.");
  const connection = ctx.core.link.connections.get(job.worker_id);

  if (!connection?.isOpen || !connection.hello.capabilities.includes("bot_workspace_v1"))
    throw new Invalid("Update the bot's worker to use files, then retry.");

  const result = await connection.sendCommand({
    case: "botFile",
    value: {
      botId: ctx.turn.bot_id,
      turnId: ctx.turn.id,
      operation,
      path: ctx.optional("path"),
      text: ctx.optional("text"),
    },
  });

  if (!result.ok || !result.botFile) throw new Invalid(result.errorMessage || "The file operation failed. Try again.");

  // Only the command result's data crosses this boundary; no host paths or provider diagnostics.
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(result.botFile.resultJson);
}

const execute = (operation: string) => (ctx: ToolContext) => ctx.action(() => botFileCommand(ctx, operation));

export const workspaceTools = [
  define(
    "delete_file",
    "Remove a file from this conversation workspace to free space. Delivered attachments stay in the conversation.",
    object({ path: str }, ["path"]),
    "Deleting a conversation file",
    execute("delete"),
  ),
  define(
    "list_files",
    "List files in this conversation's isolated workspace. No host filesystem access.",
    object({}),
    "Checking conversation files",
    execute("list"),
    "read",
  ),
  define(
    "read_file",
    "Read a UTF-8 file in this conversation workspace, up to 100,000 bytes. Use the filename from list_files, without folders.",
    object({ path: str }, ["path"]),
    "Reading a conversation file",
    execute("read"),
    "read",
  ),
  define(
    "write_file",
    "Create or replace a UTF-8 note in this conversation workspace. Use a filename such as note.md or note.txt, without folders. Up to 100,000 characters; files are not sent until send_attachment.",
    object({ path: str, text: str }, ["path", "text"]),
    "Writing a conversation file",
    execute("write"),
  ),
];

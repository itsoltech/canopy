import { InvalidError, type TurnInputJson } from "./core-context.ts";

/** Public owner input only. Agent/bot prompts never opt into command execution. */
export function coreShellInput(text: string, rich: boolean): TurnInputJson | undefined {
  if (!text.startsWith("!")) return undefined;

  if (!text.slice(1).trim()) throw new InvalidError("Write a shell command after !.");

  if (rich)
    throw new InvalidError("Shell commands cannot include attachments, quotes or mentions. Remove them, then send.");

  return { text: "", message: text, shellCommand: text.slice(1), shellInputId: Bun.randomUUIDv7() };
}

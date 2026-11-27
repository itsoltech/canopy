import type { MentionData } from "#lib/features/mentions/kinds.ts";
import { botTextTone, normalizeColor, staticBotMascot } from "./mascot.ts";
import type { ParticipantView } from "@canopy/domain/bot-chat";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const BOT_CHIP_CLASS =
  "inline-flex max-w-full items-baseline gap-1 font-medium whitespace-nowrap align-baseline";

/** The same static xs avatar in BotChip and in the editor's atomic HTML (no mounted Svelte children). */
export function botAvatarHtml(bot: ParticipantView): string {
  const { face, backgroundClass } = staticBotMascot(bot);

  return `<span aria-hidden="true" class="inline-grid size-5 shrink-0 self-center rounded-full ${backgroundClass}"><svg viewBox="0 0 40 40" class="size-full">${face}</svg></span>`;
}

/** Escaped model data only; bot colour is normalized before entering a CSS variable. */
export function botMentionHtml(mention: MentionData, bot: ParticipantView): string {
  const color = normalizeColor(bot.color ?? "");
  const tone = botTextTone({ id: bot.id, color });

  return `<span contenteditable="false" draggable="true" data-element="mention" data-mention="${escape(JSON.stringify(mention))}" class="mention-chip ${BOT_CHIP_CLASS} ${tone}"${color ? ` style="--bot-color:${color}"` : ""} title="${escape(bot.name)}">${botAvatarHtml(bot)}<span class="truncate">${escape(bot.name)}</span></span>`;
}

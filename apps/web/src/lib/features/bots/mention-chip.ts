import type { MentionData } from "#lib/features/mentions/kinds.ts";
import { botTextTone, defaultAppearance, eyeColor, mascotFor, mascotShapes, normalizeColor } from "./mascot.ts";
import type { ParticipantView } from "./model.ts";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const BOT_CHIP_CLASS =
  "inline-flex max-w-full items-baseline gap-1 font-medium whitespace-nowrap align-baseline";

/** The same static xs avatar in BotChip and in the editor's atomic HTML (no mounted Svelte children). */
export function botAvatarHtml(bot: ParticipantView): string {
  const legacy = mascotFor(bot.id, bot.shape);
  const configured = mascotShapes.find((s) => s.id === bot.shape);
  const color = normalizeColor(bot.color ?? "");
  const chosen = configured && color;
  const body = chosen ? configured : legacy.shape;
  const fill = color ?? defaultAppearance.color;

  const eyes = [16, 24]
    .map((x) => {
      if (chosen) return `<ellipse cx="${x}" cy="${body.eyeY}" rx="2.1" ry="3.2"/>`;

      if (legacy.eyes === "round")
        return `<circle cx="${x}" cy="${body.eyeY}" r="3.2" class="fill-white"/><circle cx="${x + legacy.gaze * 0.9}" cy="${body.eyeY + 0.4}" r="1.6" class="fill-zinc-950"/>`;

      if (legacy.eyes === "dots") return `<circle cx="${x}" cy="${body.eyeY}" r="1.9"/>`;

      return `<path d="M${x - 2.4} ${body.eyeY + 0.8}q2.4 -3 4.8 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`;
    })
    .join("");

  const smile =
    !chosen && legacy.smile
      ? `<path d="M17.5 ${body.eyeY + 4.5}q2.5 2.2 5 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`
      : "";

  const background = chosen ? "bg-zinc-950/5 dark:bg-white/10" : legacy.tone.background;

  return `<span aria-hidden="true" class="inline-grid size-5 shrink-0 self-center rounded-full ${background}"><svg viewBox="0 0 40 40" class="size-full" style="--mascot-color:${fill};color:${eyeColor(fill)}"><path d="${body.body}" class="${color ? "fill-(--mascot-color)" : legacy.tone.body}"/><g fill="currentColor">${eyes}${smile}</g></svg></span>`;
}

/** Escaped model data only; bot colour is normalized before entering a CSS variable. */
export function botMentionHtml(mention: MentionData, bot: ParticipantView): string {
  const color = normalizeColor(bot.color ?? "");
  const tone = botTextTone({ id: bot.id, color });

  return `<span contenteditable="false" data-element="mention" data-mention="${escape(JSON.stringify(mention))}" class="mention-chip ${BOT_CHIP_CLASS} ${tone}"${color ? ` style="--bot-color:${color}"` : ""} title="${escape(bot.name)}">${botAvatarHtml(bot)}<span class="truncate">${escape(bot.name)}</span></span>`;
}

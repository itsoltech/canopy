import type { bots } from "@canopy/contracts";

/** Shared entry point for a chat header and the sidebar's context menu. */
export function openBotSettings(botId: string): void {
  window.dispatchEvent(new CustomEvent("edit-bot", { detail: botId }));
}

export function openBotDeletion(bot: bots.Bot): void {
  window.dispatchEvent(new CustomEvent("delete-bot", { detail: bot }));
}

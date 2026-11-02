/** Shared entry point for a chat header and the sidebar's context menu. */
export function openBotSettings(botId: string): void {
  window.dispatchEvent(new CustomEvent("edit-bot", { detail: botId }));
}

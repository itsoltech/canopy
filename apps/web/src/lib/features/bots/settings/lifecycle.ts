import { bots } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { botList } from "../bot-list.svelte.ts";

export async function archiveBot(bot: bots.Bot, archived = true): Promise<void> {
  const response = decode(
    bots.GetBotResponseSchema,
    await requestJson(archived ? "POST" : "DELETE", `/api/bots/${bot.id}/archive`, {}),
  );

  if (response.bot) botList.upsert(response.bot);
  window.dispatchEvent(new Event("bots-changed"));

  if (archived)
    toast(`${bot.configuration?.name ?? "Bot"} archived`, {
      tone: "info",
      action: {
        label: "Undo",
        run: () => {
          void archiveBot(bot, false).catch(reportLifecycleError);
        },
      },
    });
}

export function reportLifecycleError(cause: unknown): void {
  toast(cause instanceof Error ? cause.message : "Could not change this bot.", { tone: "error" });
}

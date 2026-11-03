import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/**
 * Your bots with their last messages, shared by the sidebar and the chats (names, avatars, mentions):
 * one request every 5 s while anything uses it, and at once after a "bots-changed" event.
 */
class BotList {
  list = $state.raw<bots.Bot[]>([]);
  loaded = $state(false);
  error = $state("");
  #users = 0;
  #saving = new Set<string>();
  #stop: (() => void) | undefined;

  /** Keeps the list fresh until the returned function is called (use it from an `$effect`). */
  use(): () => void {
    if (this.#users++ === 0) {
      const refresh = () => void this.refresh();
      const timer = setInterval(refresh, 5000);
      window.addEventListener("bots-changed", refresh);
      this.#stop = () => {
        clearInterval(timer);
        window.removeEventListener("bots-changed", refresh);
      };
      refresh();
    }
    return () => {
      if (--this.#users === 0) this.#stop?.();
    };
  }

  async refresh(): Promise<void> {
    try {
      this.list = decode(bots.ListBotsResponseSchema, await requestJson("GET", "/api/bots?archived=1")).bots.map((bot) => this.#saving.has(bot.id) ? this.list.find((b) => b.id === bot.id) ?? bot : bot);
      this.error = "";
    } catch {
      this.error = "Could not load bots";
    } finally {
      this.loaded = true;
    }
  }

  upsert(bot: bots.Bot): void {
    if (this.#saving.has(bot.id)) return;
    this.list = this.list.some((b) => b.id === bot.id) ? this.list.map((b) => b.id === bot.id ? bot : b) : [...this.list, bot];
  }

  async markRead(botId: string, throughSeq: bigint): Promise<void> {
    const response = decode(bots.GetBotResponseSchema, await requestJson('POST', `/api/bots/${botId}/read`, encode(bots.MarkBotReadRequestSchema, create(bots.MarkBotReadRequestSchema, { botId, throughSeq }))));
    if (response.bot) this.upsert(response.bot);
  }

  async save(bot: bots.Bot, configuration: bots.BotConfiguration): Promise<void> {
    if (this.#saving.has(bot.id)) throw new Error("This bot is already being saved. Try again after it finishes.");
    this.#saving.add(bot.id);
    this.list = this.list.map((b) => b.id === bot.id ? create(bots.BotSchema, { ...b, configuration }) : b);
    try {
      const response = decode(bots.GetBotResponseSchema, await requestJson("PUT", `/api/bots/${bot.id}`, encode(bots.UpdateBotRequestSchema, create(bots.UpdateBotRequestSchema, { botId: bot.id, configuration }))));
      if (response.bot) this.list = this.list.map((b) => b.id === bot.id ? create(bots.BotSchema, { ...response.bot!, lastMessage: b.lastMessage }) : b);
    } catch (cause) {
      this.list = this.list.map((b) => b.id === bot.id ? bot : b);
      throw cause;
    } finally {
      this.#saving.delete(bot.id);
      window.dispatchEvent(new Event("bots-changed"));
    }
  }
}

export const botList = new BotList();

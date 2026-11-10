import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import { botCache } from "./cache.ts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";

/** How often the list is read while the gateway does not push bot changes (older gateways). */
const FALLBACK_MS = 15_000;

/**
 * Your bots with their last messages, shared by the sidebar and the chats (names, avatars, mentions). Read once
 * while anything uses it, then kept current by pushed `bot` / `botRemoved` updates (`follow`), again after a gap
 * in the overview stream and at once after a "bots-changed" event. Without pushed bots it reads every 15 s.
 */
class BotList {
  list = $state.raw<bots.Bot[]>([]);
  loaded = $state(false);
  error = $state("");
  #users = 0;
  #saving = new Set<string>();
  #stop: (() => void) | undefined;
  #refreshing = false;
  #again = false;
  /** Grows with every pushed or saved bot: a list read started before it is older. */
  #written = 0;
  #pushed = () => false;

  /** Keeps the list fresh until the returned function is called (use it from an `$effect`). */
  use(): () => void {
    if (this.#users++ === 0) {
      const refresh = () => {
        if (!document.hidden) void this.refresh();
      };

      const timer = setInterval(() => {
        if (!this.#pushed()) refresh();
      }, FALLBACK_MS);

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

  /** Follows the overview stream: pushed summaries, removals and gaps. Returns the unsubscribe. */
  follow(overview: OverviewState): () => void {
    this.#pushed = () => overview.pushed.has("bots");
    let resyncs = overview.resyncs;

    return overview.subscribe((update) => {
      const change = update.change;

      if (change.case === "bot") this.upsert(change.value);

      if (change.case === "botRemoved") {
        this.#written++;
        this.list = this.list.filter((b) => b.id !== change.value);
      }

      // Every (re)subscription of a pushing gateway announces its feeds: read once, so nothing missed before
      // it stays stale. An older gateway's gap is a resync.
      if (this.#users && change.case === "feeds") void this.refresh();
      else if (this.#users && change.case === "linkedReadCompleted" && change.value === "ListBots") void this.refresh();
      else if (this.#users && overview.resyncs !== resyncs && !overview.pushed.has("bots")) void this.refresh();
      resyncs = overview.resyncs;
    });
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#again = true;

      return;
    }

    this.#refreshing = true;
    const written = this.#written;

    try {
      const listed = decode(bots.ListBotsResponseSchema, await requestJson("GET", "/api/bots?archived=1")).bots;

      // A bot pushed meanwhile is newer than this read: read once more instead of overwriting it.
      if (written !== this.#written) {
        this.#again = true;

        return;
      }

      this.list = listed.map((bot) =>
        this.#saving.has(bot.id) ? (this.list.find((b) => b.id === bot.id) ?? bot) : bot,
      );
      this.error = "";
      botCache.reconcile(this.list);
    } catch {
      this.error = "Could not load bots";
    } finally {
      this.#refreshing = false;
      this.loaded = true;

      if (this.#again) {
        this.#again = false;
        void this.refresh();
      }
    }
  }

  upsert(bot: bots.Bot): void {
    if (this.#saving.has(bot.id)) return;
    this.#written++;
    this.list = this.list.some((b) => b.id === bot.id)
      ? this.list.map((b) => (b.id === bot.id ? bot : b))
      : [...this.list, bot];
  }

  async markRead(botId: string, throughSeq: bigint): Promise<void> {
    const response = decode(
      bots.GetBotResponseSchema,
      await requestJson(
        "POST",
        `/api/bots/${botId}/read`,
        encode(bots.MarkBotReadRequestSchema, create(bots.MarkBotReadRequestSchema, { botId, throughSeq })),
      ),
    );

    if (response.bot) this.upsert(response.bot);
  }

  async save(bot: bots.Bot, configuration: bots.BotConfiguration): Promise<void> {
    if (this.#saving.has(bot.id)) throw new Error("This bot is already being saved. Try again after it finishes.");
    this.#saving.add(bot.id);
    this.list = this.list.map((b) => (b.id === bot.id ? create(bots.BotSchema, { ...b, configuration }) : b));

    try {
      const response = decode(
        bots.GetBotResponseSchema,
        await requestJson(
          "PUT",
          `/api/bots/${bot.id}`,
          encode(bots.UpdateBotRequestSchema, create(bots.UpdateBotRequestSchema, { botId: bot.id, configuration })),
        ),
      );

      if (response.bot)
        this.list = this.list.map((b) =>
          b.id === bot.id ? create(bots.BotSchema, { ...response.bot!, lastMessage: b.lastMessage }) : b,
        );
    } catch (cause) {
      this.list = this.list.map((b) => (b.id === bot.id ? bot : b));
      throw cause;
    } finally {
      this.#saving.delete(bot.id);
      window.dispatchEvent(new Event("bots-changed"));
    }
  }
}

export const botList = new BotList();

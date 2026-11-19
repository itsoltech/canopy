import { create } from "@bufbuild/protobuf";
import { untrack } from "svelte";
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
  unavailableComputers = $state.raw<bots.ListBotsResponse["unavailableComputers"]>([]);
  refreshingComputers = $state.raw<bots.ListBotsResponse["refreshingComputers"]>([]);
  #executing = $state.raw<ReadonlySet<string>>(new Set());
  loaded = $state(false);
  error = $state("");
  #users = 0;
  #saving = new Set<string>();
  #stop: (() => void) | undefined;
  #refreshing = false;
  #again = false;
  /** Grows with every pushed or saved bot: a list read started before it is older. */
  #written = 0;
  #overview = $state.raw<OverviewState>();
  #executionResync = $state(-1);

  // Conversation and mutation responses also update bot metadata. Execution comes only from list summaries.
  executing(botId: string): boolean {
    return (
      this.#overview?.connection === "live" &&
      this.#executionResync === this.#overview.resyncs &&
      this.#executing.has(botId)
    );
  }

  /** Keeps the list fresh until the returned function is called (use it from an `$effect`). */
  use(): () => void {
    if (this.#users++ === 0) {
      const refresh = () => {
        if (!document.hidden) void this.refresh();
      };

      const timer = setInterval(() => {
        if (!this.#overview?.pushed.has("bots")) refresh();
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
    this.#overview = overview;
    const resync = overview.resyncs;

    // The first list read can start before the overview subscription, and a gap may have missed a finish.
    if (this.#users && untrack(() => this.#executionResync !== resync)) void this.refresh();

    return overview.subscribe((update) => {
      const change = update.change;

      if (change.case === "bot") {
        const bot = change.value;
        this.#setExecuting(bot.id, bot.executing === true);
        this.upsert(bot);
      }

      if (change.case === "botRemoved") {
        this.#written++;
        this.#setExecuting(change.value, false);
        this.list = this.list.filter((b) => b.id !== change.value);
      }

      // Feed announcements also arrive when a linked computer changes what it pushes.
      if (this.#users && change.case === "feeds") void this.refresh();
      else if (this.#users && change.case === "linkedReadCompleted" && change.value === "ListBots") void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#again = true;

      return;
    }

    this.#refreshing = true;
    const written = this.#written;
    const executionResync = untrack(() => this.#overview?.resyncs ?? -1);

    try {
      const response = decode(bots.ListBotsResponseSchema, await requestJson("GET", "/api/bots?archived=1"));

      // A bot pushed meanwhile is newer than this read: read once more instead of overwriting it.
      if (written !== this.#written) {
        this.#again = true;

        return;
      }

      this.unavailableComputers = response.unavailableComputers;
      this.refreshingComputers = response.refreshingComputers;
      this.list = response.bots.map((bot) =>
        this.#saving.has(bot.id) ? (this.list.find((b) => b.id === bot.id) ?? bot) : bot,
      );
      this.error = "";
      this.#executing = new Set(response.bots.filter((bot) => bot.executing).map((bot) => bot.id));
      this.#executionResync = executionResync;
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
    this.#written++;

    if (this.#saving.has(bot.id)) return;
    this.list = this.list.some((b) => b.id === bot.id)
      ? this.list.map((b) => (b.id === bot.id ? bot : b))
      : [...this.list, bot];
  }

  #setExecuting(botId: string, executing: boolean): void {
    if (this.#executing.has(botId) === executing) return;
    const updated = new Set(this.#executing);

    if (executing) updated.add(botId);
    else updated.delete(botId);
    this.#executing = updated;
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

import { create } from "@bufbuild/protobuf";
import { untrack } from "svelte";
import { bots } from "@canopy/contracts";
import { sharesThreads } from "@canopy/domain/computer-presence";
import { REMOTE_BOTS } from "@canopy/domain/computers";
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
  #saving = new Map<string, bots.BotConfiguration>();
  #stop: (() => void) | undefined;
  #refreshing = false;
  #again = false;
  /** Grows with every pushed or saved bot: a list read started before it is older. */
  #written = 0;
  #overview = $state.raw<OverviewState>();
  #listResync = $state(-1);

  /** A successful list read for the current overview connection. */
  get synchronized(): boolean {
    return this.#overview?.connection === "live" && this.#listResync === this.#overview.resyncs;
  }

  // Conversation and mutation responses also update bot metadata. Execution comes only from list summaries.
  executing(botId: string): boolean {
    return this.synchronized && this.#executing.has(botId);
  }

  /** Counts from a synchronized list summary, including a verified zero. */
  delegatedThreads(bot: bots.Bot | undefined): bots.Bot["delegatedThreads"] {
    if (!bot || !this.synchronized || this.error) return undefined;

    if (bot.nodeId) {
      const home = this.#overview?.computer(bot.nodeId);

      if (
        !home ||
        !sharesThreads(home) ||
        !home.capabilities.includes(REMOTE_BOTS) ||
        home.unavailableReason ||
        this.unavailableComputers.some((computer) => computer.nodeId === bot.nodeId) ||
        this.refreshingComputers.some((computer) => computer.nodeId === bot.nodeId)
      )
        return undefined;
    }

    return bot.delegatedThreads;
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
    if (this.#users && untrack(() => this.#listResync !== resync)) void this.refresh();

    const unsubscribe = overview.subscribe((update) => {
      const change = update.change;

      if (change.case === "bot") {
        const bot = change.value;
        this.#setExecuting(bot.id, bot.executing === true);
        this.upsert(bot, "summary");
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

    return () => {
      unsubscribe();
      this.#overview = undefined;
      this.#listResync = -1;
      // A list read started before detaching cannot establish freshness on reattach.
      this.#written++;
    };
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#again = true;

      return;
    }

    this.#refreshing = true;
    const written = this.#written;
    const listResync = untrack(() => this.#overview?.resyncs ?? -1);

    try {
      const response = decode(bots.ListBotsResponseSchema, await requestJson("GET", "/api/bots?archived=1"));

      // A bot pushed meanwhile is newer than this read: read once more instead of overwriting it.
      if (written !== this.#written) {
        this.#again = true;

        return;
      }

      this.unavailableComputers = response.unavailableComputers;
      this.refreshingComputers = response.refreshingComputers;
      this.list = response.bots.map((bot) => this.#keepEdit(bot));
      this.error = "";
      this.#executing = new Set(response.bots.filter((bot) => bot.executing).map((bot) => bot.id));
      this.#listResync = listResync;
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

  #keepEdit(bot: bots.Bot): bots.Bot {
    const configuration = this.#saving.get(bot.id);

    return configuration ? { ...bot, configuration } : bot;
  }

  upsert(bot: bots.Bot, from: "summary" | "conversation" | "archive"): void {
    this.#written++;

    const previous = this.list.find((b) => b.id === bot.id);
    let next = bot;

    if (from === "conversation")
      next = {
        ...bot,
        ...(previous && { pendingApproval: previous.pendingApproval, executing: previous.executing }),
        delegatedThreads: previous?.delegatedThreads,
      };

    if (from === "archive")
      next = previous
        ? { ...previous, archived: bot.archived, updatedAt: bot.updatedAt }
        : { ...bot, delegatedThreads: undefined };
    next = this.#keepEdit(next);
    this.list = previous ? this.list.map((b) => (b.id === bot.id ? next : b)) : [...this.list, next];
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

    const read = response.bot;

    if (!read) return;
    const previous = this.list.find((b) => b.id === botId);

    if (!previous || (previous.lastMessage?.seq ?? 0n) > (read.lastMessage?.seq ?? 0n)) {
      await this.refresh();

      return;
    }

    if (previous.lastReadSeq >= read.lastReadSeq) return;
    this.#written++;
    this.list = this.list.map((b) =>
      b.id === botId ? { ...b, lastReadSeq: read.lastReadSeq, unreadCount: read.unreadCount } : b,
    );
  }

  async save(bot: bots.Bot, configuration: bots.BotConfiguration): Promise<void> {
    if (this.#saving.has(bot.id)) throw new Error("This bot is already being saved. Try again after it finishes.");
    this.#saving.set(bot.id, configuration);
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

      const saved = response.bot;

      if (saved) {
        this.#written++;
        this.list = this.list.map((b) =>
          b.id === bot.id ? { ...b, configuration: saved.configuration, updatedAt: saved.updatedAt } : b,
        );
      }
    } catch (cause) {
      this.list = this.list.map((b) => (b.id === bot.id ? { ...b, configuration: bot.configuration } : b));
      throw cause;
    } finally {
      this.#saving.delete(bot.id);
      window.dispatchEvent(new Event("bots-changed"));
    }
  }
}

export const botList = new BotList();

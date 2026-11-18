import { useEffect, useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { bots as botContract } from "@canopy/contracts";
import type { QueryCache } from "@canopy/domain/shared-query";
import { useOverviewEvents } from "./overview-bus";
import { useAppearance } from "./appearance";
import { useSession } from "./session";
import { useSharedQuery } from "./queries";

/** The pairing's one bot list, archived bots included: sidebar, alerts, settings and mentions share it. */
export const BOT_LIST = "ListBots:archived";

/** How often the shared list reads again while the gateway does not push bot changes (older gateways). */
const BOT_LIST_FALLBACK_MS = 15_000;

export function useBotList() {
  const { client, queries } = useSession();
  const { botsEnabled, modulesReady } = useAppearance();

  return useSharedQuery(
    BOT_LIST,
    (signal) => readBotList(client!.api, queries, signal),
    Boolean(client) && modulesReady && botsEnabled,
  );
}

/** A linked list or an overview update can still carry a read cursor from before the receipt. */
function keepBotRead(bot: botContract.Bot, known: botContract.Bot | undefined): botContract.Bot {
  return known && known.lastReadSeq > bot.lastReadSeq
    ? { ...bot, lastReadSeq: known.lastReadSeq, unreadCount: known.unreadCount }
    : bot;
}

async function readBotList(
  api: NonNullable<ReturnType<typeof useSession>["client"]>["api"],
  queries: QueryCache,
  signal: AbortSignal,
) {
  const list = await api.listBots({ includeArchived: true }, { signal });

  const known = new Map(
    queries.snapshot<botContract.ListBotsResponse>(BOT_LIST).data?.bots.map((bot) => [bot.id, bot]),
  );

  return { ...list, bots: list.bots.map((bot) => keepBotRead(bot, known.get(bot.id))) };
}

/** The list with its bots replaced; the computers it could not reach stay as last read. */
const withBots = (list: botContract.ListBotsResponse | undefined, bots: botContract.Bot[]) =>
  create(botContract.ListBotsResponseSchema, {
    bots,
    unavailableComputers: list?.unavailableComputers ?? [],
    refreshingComputers: list?.refreshingComputers ?? [],
  });

const withBot = (list: botContract.ListBotsResponse | undefined, bot: botContract.Bot) =>
  withBots(
    list,
    list?.bots.some((b) => b.id === bot.id)
      ? list.bots.map((b) => (b.id === bot.id ? keepBotRead(bot, b) : b))
      : [...(list?.bots ?? []), bot],
  );

/** Apply the confirmed count without replacing newer messages or unrelated sidebar state. */
export function updateBotRead(queries: QueryCache, read: botContract.Bot) {
  const list = queries.snapshot<botContract.ListBotsResponse>(BOT_LIST).data;
  const known = list?.bots.find((bot) => bot.id === read.id);

  if (!known || (known.lastMessage?.seq ?? 0n) > (read.lastMessage?.seq ?? 0n)) {
    queries.invalidate(BOT_LIST);

    return;
  }

  if (known.lastReadSeq >= read.lastReadSeq) return;
  queries.set(BOT_LIST, withBot(list, { ...known, lastReadSeq: read.lastReadSeq, unreadCount: read.unreadCount }));
}

/**
 * Keeps the shared list current: one read on mount, then pushed `bot` / `botRemoved` updates. Each
 * (re)subscription of a pushing gateway announces its feeds and the list reads once, so nothing missed while
 * disconnected stays stale. An older gateway pushes nothing: one fallback read every 15 s in the foreground.
 */
export function useBotListSync() {
  const { client, active, online, epoch, queries, updateBots } = useSession();
  const { botsEnabled, modulesReady } = useAppearance();
  const list = useBotList();
  const [pushed, setPushed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (list.data) updateBots(list.data.bots);
  }, [list.data, updateBots]);

  useOverviewEvents((update) => {
    const change = update.change;

    if (change.case === "feeds") {
      const next = change.value.pushed.includes("bots");
      setPushed(next);

      if (next) queries.invalidate(BOT_LIST);
    }

    if (change.case === "bot" && queries.snapshot(BOT_LIST).loaded)
      queries.set<botContract.ListBotsResponse>(BOT_LIST, (current) => withBot(current, change.value));

    if (change.case === "linkedReadCompleted" && change.value === "ListBots") queries.invalidate(BOT_LIST);

    if (change.case === "botRemoved" && queries.snapshot(BOT_LIST).loaded)
      queries.set<botContract.ListBotsResponse>(BOT_LIST, (current) =>
        withBots(
          current,
          (current?.bots ?? []).filter((b) => b.id !== change.value),
        ),
      );
  });

  // The stream is down while in the background or offline: nothing is pushed then.
  if (pushed && (!active || !online)) setPushed(false);

  useEffect(() => {
    if (!client || !active || !online || !modulesReady || !botsEnabled) return;

    if (started.current && !pushed) queries.invalidate(BOT_LIST);
    started.current = true;

    if (pushed) return;
    const timer = setInterval(() => queries.invalidate(BOT_LIST), BOT_LIST_FALLBACK_MS);

    return () => clearInterval(timer);
  }, [client, active, online, epoch, queries, pushed, modulesReady, botsEnabled]);
}

/** Reads the shared list again now, e.g. after a bot action; joins a read already running. */
export function useRefreshBots() {
  const { client, queries } = useSession();

  return async () => {
    if (!client) return;
    queries.invalidate(BOT_LIST);
    await queries.read(BOT_LIST, (signal) => readBotList(client.api, queries, signal));
  };
}

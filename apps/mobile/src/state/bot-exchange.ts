import { useEffect, useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { applyBotExchange } from "@canopy/domain/bot-snapshot";
import { botViewKey } from "@canopy/domain/bot-cache";
import { useSession } from "./session";
import { useStream } from "./stream";
import { prependBotPage } from "@canopy/domain/history-pages";
import { useHistoryPage } from "./history-page";

/** Exchanges are read-only; unary checkpoints share the live retry/foreground lifecycle. */
export function useBotExchange(id: string) {
  const { client, session, botCache } = useSession();
  const key = botViewKey("exchange", id);
  const [snapshot, setSnapshot] = useState(() => botCache?.peek(key)?.exchange);
  const current = useRef(snapshot);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (botCache?.load(key) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;
        current.current = cached?.exchange ?? current.current;
        setSnapshot(current.current);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [key, botCache]);

  const stream = useStream(
    client && loaded
      ? async function* (signal) {
          while (!signal.aborted) {
            yield await client.api.readBotExchange(
              { exchangeId: id, pageSize: 50, incremental: true, cursor: current.current?.cursor ?? "" },
              { signal },
            );
            await pause(signal);
          }
        }
      : null,
    (update: bots.ReadBotExchangeResponse) => {
      if (update.delta && update.cursor === current.current?.cursor) return;

      try {
        current.current = applyBotExchange(current.current, update);
      } catch {
        if (current.current) current.current = { ...current.current, cursor: "" };
        throw new Error("Exchange resynchronization required");
      }

      setSnapshot(current.current);
      void botCache?.save(create(bots.BotCachedViewSchema, { key, exchange: current.current })).catch(() => {});
    },
    `bot-exchange:${session?.deviceId}:${id}`,
  );

  const history = useHistoryPage(id, {
    current,
    read: async (base, signal) => {
      if (!client) throw new Error("Gateway unavailable");

      return client.api.readBotExchange(
        { exchangeId: id, pageSize: 50, incremental: true, beforeSeq: base.historyBeforeSeq, cursor: base.cursor },
        { signal },
      );
    },
    merge: prependBotPage,
    receive: (value) => {
      current.current = value;
      setSnapshot(value);
      void botCache?.save(create(bots.BotCachedViewSchema, { key, exchange: value })).catch(() => {});
    },
    restart: stream.retry,
  });

  return { snapshot, stream, history };
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, 5000);
    signal.addEventListener("abort", done, { once: true });

    if (signal.aborted) done();
  });
}

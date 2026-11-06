import { useEffect, useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { applyBotConversation, answerLiveBotApproval } from "@canopy/domain/bot-snapshot";
import { botViewKey } from "@canopy/domain/bot-cache";
import { useSession } from "./session";
import { useStream } from "./stream";

/** Load disk before opening the watch. A ref keeps retries on the last atomically applied checkpoint. */
export function useBotSnapshot(id: string) {
  const { client, session, botCache, active } = useSession();
  const key = botViewKey("chat", id);
  const [snapshot, setSnapshot] = useState(() => botCache?.peek(key)?.conversation);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const current = useRef(snapshot);
  const live = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const saving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (botCache?.load(key) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;
        current.current = cached?.conversation ?? current.current;
        setSnapshot(current.current);

        if (current.current) setSeen((ids) => seenApprovals(ids, current.current));
        setLoaded(true);
      });

    return () => {
      cancelled = true;
      live.current = false;
    };
  }, [key, botCache]);

  const stream = useStream(
    client && loaded
      ? (signal) => {
          live.current = false;

          return client.api.watchBotConversation(
            { botId: id, incremental: true, cursor: current.current?.cursor ?? "" },
            { signal },
          );
        }
      : null,
    (update: bots.BotConversation) => {
      try {
        current.current = applyBotConversation(current.current, update);
      } catch {
        if (current.current) current.current = { ...current.current, cursor: "" };
        live.current = false;
        throw new Error("Bot resynchronization required");
      }

      live.current = true;
      setSnapshot(current.current);
      setSeen((ids) => seenApprovals(ids, current.current));
    },
    `bot:${session?.deviceId}:${id}`,
  );

  useEffect(() => {
    if (!snapshot || !botCache || saving.current) return;
    saving.current = setTimeout(() => {
      saving.current = undefined;

      if (current.current)
        void botCache.save(create(bots.BotCachedViewSchema, { key, conversation: current.current })).catch(() => {});
    }, 2000);
  }, [snapshot, botCache, key]);
  useEffect(() => {
    const save = () => {
      clearTimeout(saving.current);
      saving.current = undefined;

      if (current.current)
        void botCache?.save(create(bots.BotCachedViewSchema, { key, conversation: current.current })).catch(() => {});
    };

    if (!active) save();

    return save;
  }, [active, botCache, key]);

  return {
    snapshot,
    seen,
    stream,
    answer(request: bots.AnswerBotApprovalRequest) {
      if (!client) return Promise.reject(new Error("This conversation is still syncing."));

      return answerLiveBotApproval(current.current, request, live.current && stream.connection === "live", (r) =>
        client.api.answerBotApproval(r),
      );
    },
  };
}

function seenApprovals(ids: ReadonlySet<string>, snapshot: bots.BotConversation | undefined) {
  return new Set([...ids, ...(snapshot?.approvals.flatMap((a) => (a.status === "pending" ? [a.id] : [])) ?? [])]);
}

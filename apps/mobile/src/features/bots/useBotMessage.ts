import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ChatMessageView } from "@canopy/domain/bot-chat";
import { markdownText } from "@canopy/domain/markdown";
import { QUOTE_LIMITS } from "@canopy/domain";
import { useSession } from "../../state/session";
import { useMessageDraft } from "../composer/useMessageDraft";
import { useQuoteDraft } from "../quotes/useQuoteDraft";
import { botComposerState } from "./composer-state";

export function useBotMessage(id: string, live: boolean, onSend: () => void, sourceName = "Bot") {
  const { client, online } = useSession();
  const state = useMemo(() => botComposerState(client, id), [client, id]);
  useSyncExternalStore(state.subscribe, state.snapshot);
  const draft = useMessageDraft({ value: state.value, files: state.files, botId: id, onChange: state.changed });
  const busy = state.sending;
  const [error, setError] = useState("");
  const quoteDraft = useQuoteDraft(() => state.sending, {}, draft);
  const { quotes } = quoteDraft;
  useEffect(() => {
    if (online) void state.sync.load();

    return () => {
      void state.sync.flush().catch(() => {});
    };
  }, [state, online]);

  async function send() {
    const { text, mentions, attachmentIds, quotes: sentQuotes } = draft.outgoing();

    if (
      (!text && !quotes.length && !attachmentIds.length) ||
      state.sending ||
      draft.files.blocker ||
      !client ||
      !online ||
      !live ||
      !state.sync.loaded
    )
      return;
    state.persist();
    state.sending = true;
    state.notify();
    onSend();
    setError("");

    try {
      const saved = await state.sync.outgoing();
      await client.api.sendBotMessage(
        {
          botId: id,
          text,
          mentions,
          quotes: sentQuotes,
          attachmentIds,
          clientRequestId: saved.clientRequestId,
          draftRevision: saved.revision,
        },
        { timeoutMs: 20_000 },
      );
      draft.clear();
      quoteDraft.clear();
      await state.sync.sent(saved);
    } catch {
      setError(state.sync.error || "Could not confirm delivery. Retry this message unchanged to send it only once.");
    } finally {
      state.sending = false;
      state.notify();
    }
  }

  function reply(message: ChatMessageView) {
    if (!live || state.sending) return;

    if (quotes.length >= QUOTE_LIMITS.maxQuotes) {
      setError("A message can carry up to 20 quotes. Remove a quote to add another.");

      return;
    }

    const text = message.senderId === "me" ? message.text : markdownText(message.text);

    if (!text.trim()) return;

    if (text.length > QUOTE_LIMITS.maxTextChars) {
      setError("This message is too long to quote. Copy it and shorten the passage.");

      return;
    }

    quoteDraft.add(
      create(ui.QuoteSchema, {
        text,
        sourceItemId: message.id,
        sourceThreadId: id,
        sourceKind: "agent_message",
        sourceAuthor: message.senderId === "me" ? "You" : sourceName,
        sourceTime: message.at.toLocaleString(),
      }),
    );
  }

  return {
    draft,
    quotes,
    quoteDraft,
    busy,
    error: error || state.sync.error,
    loaded: state.sync.loaded,
    reloadDraft: () => {
      setError("");
      void state.sync.reload();
    },
    setError,
    send,
    reply,
  };
}

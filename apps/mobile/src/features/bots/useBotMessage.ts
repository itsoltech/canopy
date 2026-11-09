import { useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ChatMessageView } from "@canopy/domain/bot-chat";
import { markdownText } from "@canopy/domain/markdown";
import { QUOTE_LIMITS } from "@canopy/domain";
import { useSession } from "../../state/session";
import { useMessageDraft } from "../composer/useMessageDraft";
import { useQuoteDraft } from "../quotes/useQuoteDraft";

export function useBotMessage(id: string, live: boolean, onSend: () => void) {
  const { client, online } = useSession();
  const draft = useMessageDraft();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const quoteDraft = useQuoteDraft(() => sending.current);
  const { quotes } = quoteDraft;
  const pending = useRef({ value: "", id: "" });

  async function send() {
    const { text, mentions } = draft.outgoing();

    if ((!text && !quotes.length) || sending.current || !client || !online || !live) return;
    sending.current = true;
    onSend();
    setBusy(true);
    setError("");
    const value = JSON.stringify({ text, mentions, quotes });

    if (pending.current.value !== value) pending.current = { value, id: Crypto.randomUUID() };

    try {
      await client.api.sendBotMessage(
        { botId: id, text, mentions, quotes: [...quotes], clientRequestId: pending.current.id },
        { timeoutMs: 20_000 },
      );
      draft.clear();
      quoteDraft.clear();
      pending.current = { value: "", id: "" };
    } catch {
      setError("Could not confirm delivery. Retry this message unchanged to send it only once.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function reply(message: ChatMessageView) {
    if (!live || sending.current) return;

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
      create(ui.QuoteSchema, { text, sourceItemId: message.id, sourceThreadId: id, sourceKind: "agent_message" }),
    );
  }

  return {
    draft,
    quotes,
    quoteDraft,
    busy,
    error,
    setError,
    send,
    reply,
  };
}

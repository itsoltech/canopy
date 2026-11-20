import { createContext, useContext, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { IconButton } from "../../ui/Button";
import type { StyleProp, ViewStyle } from "react-native";
import { useTimelineDirectory } from "../timeline/directory";
import { QuoteEditor } from "./QuoteEditor";
import { markdownText } from "@canopy/domain/markdown";
import { providerName } from "../models/catalog";

export const QuoteItem = createContext("");

/** Shared by the visible action and the message's long-press menu. */
export function useQuotePassage(text: string, kind: string, language = "") {
  const directory = useTimelineDirectory();
  const itemId = useContext(QuoteItem);
  const [quote, setQuote] = useState<ui.Quote>();

  const available = Boolean(text.trim() && !directory.readOnly && directory.quote);

  function passage(value: string, sourceKind: string) {
    const sourceThreadId = directory.sourceId || directory.currentId;

    return create(ui.QuoteSchema, {
      text: value,
      sourceItemId: itemId,
      sourceThreadId,
      sourceKind,
      sourceAuthor: providerName(directory.thread(sourceThreadId)?.provider ?? 0),
      sourceTime: directory.quoteTime?.(itemId),
      language,
    });
  }

  return {
    available,
    open: () =>
      setQuote(
        passage(
          kind === "reasoning" ? markdownText(text) : text,
          kind === "agent_message" ? "agent_message_markdown" : kind,
        ),
      ),
    addSelection: available ? (value: string) => directory.quote?.(passage(value, kind)) : undefined,
    editor:
      available && quote ? (
        <QuoteEditor quote={quote} onSave={(value) => directory.quote?.(value)} onClose={() => setQuote(undefined)} />
      ) : null,
  };
}

export function QuoteAction({
  text,
  kind,
  language = "",
  style,
}: {
  text: string;
  kind: string;
  language?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const quote = useQuotePassage(text, kind, language);

  return quote.available ? (
    <>
      <IconButton icon="chat-bubble-left-right" label="Quote passage" size="sm" style={style} onPress={quote.open} />
      {quote.editor}
    </>
  ) : null;
}

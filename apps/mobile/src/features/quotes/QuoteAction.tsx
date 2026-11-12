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
  const [open, setOpen] = useState(false);

  const available = Boolean(text.trim() && !directory.readOnly && directory.quote);

  return {
    available,
    open: () => setOpen(true),
    editor:
      available && open ? (
        <QuoteEditor
          quote={create(ui.QuoteSchema, {
            text: kind === "agent_message" || kind === "reasoning" ? markdownText(text) : text,
            sourceItemId: itemId,
            sourceThreadId: directory.sourceId || directory.currentId,
            sourceKind: kind,
            sourceAuthor: providerName(directory.thread(directory.sourceId || directory.currentId)?.provider ?? 0),
            sourceTime: directory.quoteTime?.(itemId),
            language,
          })}
          onSave={(value) => directory.quote?.(value)}
          onClose={() => setOpen(false)}
        />
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

import { createContext, useContext, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { IconButton } from "../../ui/Button";
import { useTimelineDirectory } from "../timeline/directory";
import { QuoteEditor } from "./QuoteEditor";
import { markdownText } from "./markdown-text";

export const QuoteItem = createContext("");

export function QuoteAction({ text, kind, language = "" }: { text: string; kind: string; language?: string }) {
  const directory = useTimelineDirectory();
  const itemId = useContext(QuoteItem);
  const [open, setOpen] = useState(false);

  if (!text.trim() || directory.readOnly || !directory.quote) return null;

  return (
    <>
      <IconButton icon="chat-bubble-left-right" label="Quote passage" size="sm" onPress={() => setOpen(true)} />
      {open && (
        <QuoteEditor
          quote={create(ui.QuoteSchema, {
            text: kind === "agent_message" || kind === "reasoning" ? markdownText(text) : text,
            sourceItemId: itemId,
            sourceThreadId: directory.sourceId || directory.currentId,
            sourceKind: kind,
            language,
          })}
          onSave={directory.quote}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

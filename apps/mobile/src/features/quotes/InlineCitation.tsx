import { useState } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { citationLabel } from "@canopy/domain";
import { font, useColors } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { Button } from "../../ui/Button";
import { QuoteSource } from "./QuoteSource";

export function InlineCitation({ quote }: { quote: ui.Quote }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(false);

  const text = [
    quote.text,
    quote.comment,
    [quote.sourceAuthor || "Agent", quote.sourceKind.replaceAll("_", " "), quote.sourceTime]
      .filter(Boolean)
      .join(" · "),
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <>
      <Text
        accessibilityRole="button"
        accessibilityLabel={`Citation: ${citationLabel(quote.text)}`}
        onPress={() => setOpen(true)}
        style={{ fontFamily: font.medium, color: c.accent, backgroundColor: c.softAccent }}
      >
        {`“${citationLabel(quote.text)}”`}
      </Text>
      {open && (
        <TextViewer
          text={text}
          label="Citation"
          threadId=""
          onClose={() => setOpen(false)}
          extraActions={
            quote.sourceItemId ? <Button title="Jump to source" size="sm" onPress={() => setSource(true)} /> : undefined
          }
        />
      )}
      {source && <QuoteSource quote={quote} onClose={() => setSource(false)} />}
    </>
  );
}

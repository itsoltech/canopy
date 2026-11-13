import { useState } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { citationTokenLabel } from "@canopy/domain";
import { font, useColors } from "../../ui/theme";
import { CitationViewer } from "./CitationViewer";
import { QuoteSource } from "./QuoteSource";

export function InlineCitation({ quote }: { quote: ui.Quote }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(false);

  return (
    <>
      <Text
        accessibilityRole="button"
        accessibilityLabel={`Citation: ${citationTokenLabel(quote)}`}
        onPress={() => setOpen(true)}
        style={{ fontFamily: font.medium, color: c.accent, backgroundColor: c.softAccent }}
      >
        {`${quote.pullRequest ? "⑂ " : "“"}${citationTokenLabel(quote)}${quote.pullRequest ? "" : "”"}`}
      </Text>
      {open && <CitationViewer quote={quote} onClose={() => setOpen(false)} onSource={() => setSource(true)} />}
      {source && <QuoteSource quote={quote} onClose={() => setSource(false)} />}
    </>
  );
}

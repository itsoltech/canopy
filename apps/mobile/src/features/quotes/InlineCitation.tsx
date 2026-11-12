import { useState } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { citationLabel, citationPreview, citationTokenLabel } from "@canopy/domain";
import * as Linking from "expo-linking";
import { safeHref } from "@canopy/domain/markdown";
import { font, useColors } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { Button } from "../../ui/Button";
import { QuoteSource } from "./QuoteSource";

export function InlineCitation({ quote }: { quote: ui.Quote }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(false);

  const text = [citationPreview(quote), quote.comment].filter(Boolean).join("\n\n");

  return (
    <>
      <Text
        accessibilityRole="button"
        accessibilityLabel={`Citation: ${citationLabel(quote.text)}`}
        onPress={() => setOpen(true)}
        style={{ fontFamily: font.medium, color: c.accent, backgroundColor: c.softAccent }}
      >
        {`${quote.pullRequest ? "⑂ " : "“"}${citationTokenLabel(quote)}${quote.pullRequest ? "" : "”"}`}
      </Text>
      {open && (
        <TextViewer
          text={text}
          label="Citation"
          threadId=""
          onClose={() => setOpen(false)}
          extraActions={
            quote.pullRequest ? (
              <Button
                title="Open on GitHub"
                size="sm"
                onPress={() => {
                  const url = safeHref(quote.pullRequest?.url ?? "");

                  if (url) void Linking.openURL(url);
                }}
              />
            ) : quote.sourceItemId ? (
              <Button title="Jump to source" size="sm" onPress={() => setSource(true)} />
            ) : undefined
          }
        />
      )}
      {source && <QuoteSource quote={quote} onClose={() => setSource(false)} />}
    </>
  );
}

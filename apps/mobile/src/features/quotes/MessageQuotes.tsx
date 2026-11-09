import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { isCodeQuote } from "@canopy/domain";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { Button } from "../../ui/Button";
import { QuoteSource } from "./QuoteSource";

export function MessageQuotes({ quotes }: { quotes: readonly ui.Quote[] }) {
  const c = useColors();
  const type = useTypography();
  const [selected, setSelected] = useState<ui.Quote>();
  const [source, setSource] = useState<ui.Quote>();

  return (
    <View style={{ gap: 8 }}>
      {quotes.map((quote, index) => (
        <View key={index} style={{ borderLeftWidth: 2, borderColor: c.line, paddingLeft: 10, gap: 4 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show quoted passage"
            onPress={() => setSelected(quote)}
          >
            <Text
              numberOfLines={3}
              style={[
                styles.meta,
                { color: c.muted, fontFamily: isCodeQuote(quote.sourceKind) ? type.mono.fontFamily : font.regular },
              ]}
            >
              {quote.text}
            </Text>
          </Pressable>
          {quote.comment ? (
            <Text selectable style={[styles.body, { color: c.text }]}>
              {quote.comment}
            </Text>
          ) : null}
        </View>
      ))}
      {selected && (
        <TextViewer
          text={selected.text}
          label="Quoted passage"
          threadId=""
          diff={selected.sourceKind === "diff"}
          onClose={() => setSelected(undefined)}
          extraActions={
            selected.sourceItemId ? (
              <>
                <Button title="Show source" size="sm" onPress={() => setSource(selected)} />
                {source && <QuoteSource quote={source} onClose={() => setSource(undefined)} />}
              </>
            ) : undefined
          }
        />
      )}
    </View>
  );
}

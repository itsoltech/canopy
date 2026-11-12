import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { styles, useColors } from "../../ui/theme";

export function QuotePreview({ quote, mine = false }: { quote: ui.Quote; mine?: boolean }) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={{ gap: 4, borderLeftWidth: 2, borderColor: mine ? c.botUserText : c.accent, paddingLeft: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Collapse quote" : "Expand quote"}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text numberOfLines={expanded ? undefined : 3} style={[styles.meta, { color: mine ? c.botUserText : c.muted }]}>
          {quote.text}
        </Text>
      </Pressable>
      {quote.comment ? (
        <Text style={[styles.body, { color: mine ? c.botUserText : c.text }]}>{quote.comment}</Text>
      ) : null}
    </View>
  );
}

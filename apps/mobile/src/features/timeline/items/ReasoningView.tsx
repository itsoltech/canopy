import { useRef, useState } from "react";
import { Pressable, Text, View, type HostInstance } from "react-native";
import type { Reasoning } from "@canopy/contracts";
import { LiveText } from "../../../ui/LiveText";
import { useAnchoredToggle } from "../../../ui/feed-anchor";
import { Markdown } from "../../../ui/markdown";
import { font, styles, useColors } from "../../../ui/theme";
import { Chevron } from "../../../ui/MotionViews";

/** Reasoning, folded: the first line of the summary as a preview, the rest on demand (web: ReasoningView). */
export function ReasoningView({ reasoning, streaming }: { reasoning: Reasoning; streaming: boolean }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const header = useRef<HostInstance>(null);
  const toggle = useAnchoredToggle();

  const preview =
    (reasoning.summary || reasoning.text)
      .trim()
      .split("\n")[0]
      ?.replace(/^[#*_\s]+|[*_]+$/g, "") ?? "";

  if (!reasoning.summary.trim() && !reasoning.text.trim() && !streaming) return null;
  const label = { fontFamily: font.medium, color: c.muted };

  return (
    <View ref={header} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => toggle(header.current, () => setOpen(!open))}
        style={({ pressed }) => [
          styles.row,
          {
            minHeight: 40,
            marginHorizontal: -6,
            paddingHorizontal: 6,
            borderRadius: 6,
            backgroundColor: pressed ? c.well : "transparent",
          },
        ]}
      >
        <Chevron open={open} color={c.faint} />
        {streaming ? (
          <LiveText style={[styles.work, label]}>Thinking</LiveText>
        ) : (
          <Text style={[styles.work, label]}>Thought</Text>
        )}
        {preview ? (
          <Text numberOfLines={1} style={[styles.work, { flex: 1, color: c.muted }]}>
            {preview}
          </Text>
        ) : null}
      </Pressable>
      {open && (
        <View
          style={{ marginTop: 4, marginBottom: 8, gap: 12, borderLeftWidth: 2, borderColor: c.rule, paddingLeft: 16 }}
        >
          {reasoning.summary.trim() ? <Markdown text={reasoning.summary} color={c.muted} /> : null}
          {reasoning.text.trim() && reasoning.text !== reasoning.summary ? (
            <Markdown text={reasoning.text} color={c.faint} />
          ) : null}
        </View>
      )}
    </View>
  );
}

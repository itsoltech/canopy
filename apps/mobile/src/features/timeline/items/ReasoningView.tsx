import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import type { Reasoning } from "@canopy/contracts";
import { streamingText } from "@canopy/ui/streaming";
import { LiveText } from "../../../ui/LiveText";
import { useAnchoredToggle } from "../../../ui/feed-anchor";
import { Markdown } from "../../../ui/markdown";
import { font, styles, useColors } from "../../../ui/theme";
import { Chevron } from "../../../ui/MotionViews";
import { Icon } from "../../../ui/Icon";
import { QuoteAction } from "../../quotes/QuoteAction";
import { activityHeader } from "../activity-header";
import { useItemContent } from "../item-content";
import { LazyItemContent } from "../LazyItemContent";
import { useMessageActions } from "../useMessageActions";

/** Reasoning, folded: the first line of the summary as a preview, the rest on demand (web: ReasoningView). */
export function ReasoningView({ reasoning, streaming }: { reasoning: Reasoning; streaming: boolean }) {
  const c = useColors();
  const lazy = useItemContent();
  const [open, setOpen] = useState(false);
  const { header, toggle } = useAnchoredToggle();

  const summary = streamingText(reasoning.summary, streaming);
  const body = streamingText(reasoning.text, streaming);
  const distinctBody = reasoning.text !== reasoning.summary ? body : "";
  const passage = [summary, distinctBody].filter(Boolean).join("\n\n");
  const actions = useMessageActions(passage, "reasoning", open);

  const preview =
    (reasoning.summary ? summary : body)
      .trim()
      .split("\n")[0]
      ?.replace(/^[#*_\s]+|[*_]+$/g, "") ?? "";

  if (!reasoning.summary.trim() && !reasoning.text.trim() && !streaming) return null;
  const label = { fontFamily: font.medium, color: c.muted };

  return (
    <Animated.View
      ref={header}
      collapsable={false}
      style={[activityHeader.shell, { borderColor: c.rule, backgroundColor: c.dark ? "#ffffff06" : "#09090b03" }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => toggle(() => setOpen(!open))}
        style={({ pressed }) => [
          styles.row,
          activityHeader.row,
          open && activityHeader.open,
          {
            backgroundColor: pressed ? c.well : "transparent",
          },
        ]}
      >
        <Chevron open={open} color={c.faint} />
        <Icon name="light-bulb" color={c.icon} />
        <View style={{ width: 64, flexShrink: 0 }}>
          {streaming ? (
            <LiveText style={[styles.work, label]}>Thinking</LiveText>
          ) : (
            <Text style={[styles.work, label]}>Thought</Text>
          )}
        </View>
        <Text
          numberOfLines={1}
          style={[styles.work, { flex: 1, minWidth: 0, color: c.muted, fontFamily: font.regularItalic }]}
        >
          {preview}
        </Text>
      </Pressable>
      {open && (
        <View style={[activityHeader.body, { gap: 12 }]}>
          <Pressable {...actions.trigger} style={{ gap: 12 }}>
            {summary.trim() ? <Markdown text={summary} selectable={!actions.available} color={c.muted} /> : null}
            {distinctBody.trim() ? (
              <Markdown text={distinctBody} selectable={!actions.available} color={c.faint} />
            ) : null}
          </Pressable>
          <QuoteAction text={passage} kind="reasoning" />
          {actions.menu}
          {lazy && <LazyItemContent key={lazy.reference.sha256} {...lazy} auto subject="thought" />}
        </View>
      )}
    </Animated.View>
  );
}

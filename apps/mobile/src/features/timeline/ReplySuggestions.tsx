import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { ui } from "@canopy/contracts";
import { splitReplySuggestions } from "@canopy/domain/reply-suggestions";
import { isProgressPhase } from "@canopy/domain/work-fold";
import { Button } from "../../ui/Button";
import { turnReplySource } from "../threads/reply-suggestions";

export const ReplySendContext = createContext<{
  activeId?: string;
  send: (itemId: string, text: string) => void;
}>({ send: () => {} });

export const ReplyMessageContext = createContext<{
  itemId?: string;
  resolve: (itemId: string, text: string) => void;
}>({ resolve: () => {} });

/** Full content can arrive after its preview; the final answer and its footer share that resolution. */
export function useTurnReplySuggestions(turn: ui.Turn, entries: readonly ui.TimelineItem[]) {
  const source = turnReplySource(turn, entries);
  const [full, setFull] = useState<{ itemId: string; text: string }>();

  const resolve = useCallback((itemId: string, text: string) => {
    setFull((previous) => (previous?.itemId === itemId && previous.text === text ? previous : { itemId, text }));
  }, []);

  const itemId = source?.itemId;
  const context = useMemo(() => ({ itemId, resolve }), [itemId, resolve]);

  const raw =
    source?.content.case === "agentMessage"
      ? full && full.itemId === itemId
        ? full.text
        : source.content.value.text
      : "";

  const parsed = useMemo(() => splitReplySuggestions(raw), [raw]);

  const message = entries.findLast((entry) => entry.item?.content.case === "agentMessage")?.item;

  const progress =
    turn.status === "completed" &&
    message?.content.case === "agentMessage" &&
    isProgressPhase(message.content.value.phase);

  const last = progress ? undefined : message;

  const answerText = source ? parsed.text : last?.content.case === "agentMessage" ? last.content.value.text : "";

  return { context, itemId, answerText, answerItemId: itemId ?? last?.itemId ?? "", ...parsed };
}

/** Historical groups retain their exact labels and layout, with native disabled semantics. */
export function ReplySuggestions({
  itemId,
  replies,
  disabled: inactive,
  style,
}: {
  itemId: string;
  replies: readonly string[];
  disabled: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const send = useContext(ReplySendContext);
  const disabled = inactive || send.activeId !== itemId;

  return (
    <View accessibilityLabel="Suggested replies" style={[{ gap: 4, alignItems: "flex-start", minWidth: 0 }, style]}>
      {replies.map((reply, index) => (
        <Button
          key={`${index}:${reply}`}
          title={reply}
          hint="Sends this reply"
          size="sm"
          reserveTouchTarget
          multiline
          disabled={disabled}
          onPress={() => send.send(itemId, reply)}
          style={{ maxWidth: "100%", paddingVertical: 4 }}
        />
      ))}
    </View>
  );
}

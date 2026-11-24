import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChatMessageView } from "@canopy/domain/bot-chat";
import { botReactionOptions } from "@canopy/domain/bot-reactions";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/Toast";
import { styles, useColors } from "../../ui/theme";
import { TextActions } from "../viewers/TextActions";

export type SetMessageReaction = (messageId: string, emoji: string, active: boolean) => Promise<void>;

export function ChatMessageActions({
  message,
  mine,
  visible,
  onClose,
  onReply,
  onSetReaction,
}: {
  message: ChatMessageView;
  mine: boolean;
  visible: boolean;
  onClose: () => void;
  onReply?: (() => void) | undefined;
  onSetReaction?: SetMessageReaction | undefined;
}) {
  const [saving, setSaving] = useState(false);
  const reactions = message.reactions;
  const setReaction = !mine && reactions ? onSetReaction : undefined;

  async function toggle(emoji: string) {
    if (!setReaction || !reactions || saving) return;
    onClose();
    setSaving(true);

    try {
      await setReaction(message.id, emoji, !reactions.includes(emoji));
    } catch {
      toast("Could not save the reaction. Check the connection and retry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {reactions?.length ? (
        <View style={[s.row, { justifyContent: mine ? "flex-end" : "flex-start" }]}>
          {reactions.map((emoji) => {
            const label = botReactionOptions.find((option) => option.emoji === emoji)?.label ?? emoji;

            return (
              <ReactionChip
                key={emoji}
                emoji={emoji}
                label={
                  setReaction ? `Remove reaction: ${label}` : `${mine ? "Bot reaction" : "Your reaction"}: ${label}`
                }
                active
                disabled={saving}
                onPress={setReaction ? () => void toggle(emoji) : undefined}
              />
            );
          })}
        </View>
      ) : null}
      <TextActions
        text={message.text || message.quotes?.map((q) => q.text).join("\n\n") || ""}
        visible={visible}
        onClose={onClose}
        onReply={onReply}
        header={
          visible &&
          setReaction &&
          reactions && (
            <View style={[s.row, { paddingHorizontal: 16, paddingVertical: 4 }]}>
              {botReactionOptions.map(({ emoji, label }) => (
                <ReactionChip
                  key={emoji}
                  emoji={emoji}
                  label={`${reactions.includes(emoji) ? "Remove" : "Add"} reaction: ${label}`}
                  active={reactions.includes(emoji)}
                  picker
                  disabled={saving}
                  onPress={() => void toggle(emoji)}
                />
              ))}
            </View>
          )
        }
      />
    </>
  );
}

function ReactionChip({
  emoji,
  label,
  active,
  disabled,
  onPress,
  picker = false,
}: {
  emoji: string;
  label: string;
  active: boolean;
  disabled: boolean;
  onPress?: (() => void) | undefined;
  picker?: boolean;
}) {
  const c = useColors();

  const chip = (
    <View
      accessible={!onPress}
      accessibilityLabel={onPress ? undefined : label}
      style={[s.chip, { borderColor: active ? c.accent : c.line, backgroundColor: active ? c.softAccent : c.surface }]}
    >
      <Text style={styles.body}>{emoji}</Text>
    </View>
  );

  if (!onPress) return chip;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled, busy: disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.target, { opacity: pressed || disabled ? 0.6 : 1 }]}
    >
      {chip}
      {picker && active && (
        <View style={[s.check, { backgroundColor: c.surface }]}>
          <Icon name="check" size={12} color={c.accent} />
        </View>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  chip: {
    borderWidth: 1,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  check: { position: "absolute", right: 0, bottom: 4, borderRadius: 6 },
  target: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
});

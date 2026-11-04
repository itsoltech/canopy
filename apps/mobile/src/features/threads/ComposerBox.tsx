import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";

export function ComposerBox({
  text,
  onChange,
  onSend,
  onQueue,
  onStop,
  running = false,
  disabled,
  busy,
  controls,
  compact = false,
  placeholder = "Ask anything…",
}: {
  text: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onQueue?: () => void;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  busy?: boolean;
  controls?: ReactNode;
  compact?: boolean;
  placeholder?: string;
}) {
  const c = useColors();
  const stop = running && !text.trim() && Boolean(onStop);
  const unavailable = disabled || busy || (!stop && !text.trim());

  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderRadius: compact ? 24 : 16,
        flexDirection: compact ? "row" : "column",
        alignItems: compact ? "center" : undefined,
        borderWidth: 1,
        borderColor: c.line,
      }}
    >
      <ComposerInput text={text} onChange={onChange} busy={busy} compact={compact} placeholder={placeholder} />
      {!compact || text.trim() || running ? (
        <View
          style={[
            styles.row,
            {
              minHeight: compact ? 44 : 52,
              padding: compact ? 4 : 10,
              paddingLeft: compact ? 0 : 12,
              gap: 4,
            },
          ]}
        >
          {!compact && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[styles.row, { gap: 4, paddingRight: 4 }]}
              style={{ flex: 1 }}
            >
              {controls}
            </ScrollView>
          )}
          {running && text.trim() && onQueue ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Queue message"
              onPress={onQueue}
              disabled={disabled || busy}
              style={{ padding: 8, opacity: disabled ? 0.4 : 1 }}
            >
              <Icon name="queue-list" />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={stop ? "Stop the turn" : running ? "Send now" : "Send message"}
            disabled={unavailable}
            onPress={stop ? onStop : onSend}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: unavailable ? c.line : stop ? c.text : c.accent,
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={c.onAccent} />
            ) : (
              <Icon
                name={stop ? "stop" : "arrow-up"}
                color={unavailable ? c.faint : stop ? c.background : c.onAccent}
                size={18}
              />
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function ComposerInput({
  text,
  onChange,
  busy,
  compact,
  placeholder,
}: Pick<Parameters<typeof ComposerBox>[0], "text" | "onChange" | "busy" | "compact" | "placeholder">) {
  const c = useColors();

  return (
    <TextInput
      accessibilityLabel="Message to your agent"
      value={text}
      onChangeText={onChange}
      editable={!busy}
      multiline
      maxLength={32000}
      placeholder={placeholder}
      placeholderTextColor={c.faint}
      style={[
        styles.body,
        {
          minHeight: compact ? 44 : 64,
          flex: compact ? 1 : undefined,
          maxHeight: 160,
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 12,
          color: c.text,
          textAlignVertical: "top",
        },
      ]}
    />
  );
}

export function ComposerPill({
  icon,
  title,
  onPress,
  warning = false,
  leading,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  onPress: () => void;
  warning?: boolean;
  leading?: ReactNode;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 36,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 6,
        borderRadius: 6,
        backgroundColor: pressed ? c.inset : "transparent",
      })}
    >
      {leading ?? <Icon name={icon} size={14} color={warning ? c.warning : c.muted} />}
      <Text numberOfLines={1} style={[styles.meta, { color: warning ? c.warning : c.muted, maxWidth: 140 }]}>
        {title}
      </Text>
      <Icon name="chevron-down" size={12} />
    </Pressable>
  );
}

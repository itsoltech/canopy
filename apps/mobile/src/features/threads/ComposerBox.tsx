import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Skeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import type { Mention } from "@canopy/contracts";
import { MessageSpans, type BadgeTone } from "../composer/MessageText";

/** What each trigger character does, as on the web; no-break spaces keep each item on one line. */
const TRIGGER_HINT = ["/ commands", "$ skills", "@ files", "# threads", "! shell"]
  .map((item) => item.replace(" ", "\u00a0"))
  .join(" · ");

/** Badges in the text (the message draft's files); without it the field is plain text. */
export interface ComposerBadges {
  mentions: readonly Mention[];
  onSelect: (selection: { start: number; end: number }) => void;
  tone?: (mention: Mention) => BadgeTone;
}

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
  top,
  files = 0,
  label = "Message to your agent",
  badges,
  triggers = false,
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
  /** Above the text (attachment chips). */
  top?: ReactNode;
  /** Attached files: a message may be files only. */
  files?: number;
  label?: string;
  badges?: ComposerBadges;
  /** The composer takes mentions and shell commands: the empty field lists their trigger characters. */
  triggers?: boolean;
}) {
  const c = useColors();
  const empty = !text.trim() && files === 0;
  // A leading "!" runs the text as a shell command on the worker when it is delivered (docs/ui-api.md).
  const shell = text.startsWith("!");
  const shellIssue = shell && (text.trim() === "!" || files > 0);
  const stop = running && empty && Boolean(onStop);
  const unavailable = disabled || busy || (!stop && empty) || shellIssue;

  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderRadius: compact ? 24 : 16,
        flexDirection: compact ? "row" : "column",
        alignItems: compact ? "center" : undefined,
        borderWidth: 1,
        borderColor: shell ? c.danger : c.line,
      }}
    >
      {top}

      <ComposerInput
        text={text}
        onChange={onChange}
        busy={busy}
        compact={compact}
        placeholder={triggers && !compact ? `${placeholder}\n${TRIGGER_HINT}` : placeholder}
        label={label}
        badges={badges}
      />
      {!compact || !empty || running ? (
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
              {shell ? (
                <Text numberOfLines={2} style={[styles.caption, { color: c.danger, flexShrink: 1 }]}>
                  {files > 0 ? "Remove the files to run a shell command." : "Runs as a shell command when delivered."}
                </Text>
              ) : (
                controls
              )}
            </ScrollView>
          )}
          <SendButtons
            queue={running && !empty ? onQueue : undefined}
            onSend={stop ? onStop : onSend}
            stop={stop}
            running={running}
            disabled={disabled}
            busy={busy}
            unavailable={unavailable}
          />
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
  label,
  badges,
}: Pick<
  Parameters<typeof ComposerBox>[0],
  "text" | "onChange" | "busy" | "compact" | "placeholder" | "label" | "badges"
>) {
  const c = useColors();

  return (
    <TextInput
      accessibilityLabel={label}
      // With badges the spans carry the text; a TextInput takes either children or a value.
      value={badges ? undefined : text}
      onChangeText={onChange}
      onSelectionChange={badges ? (event) => badges.onSelect(event.nativeEvent.selection) : undefined}
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
    >
      {badges ? <MessageSpans value={{ text, mentions: badges.mentions }} tone={badges.tone} /> : null}
    </TextInput>
  );
}

export function ComposerPill({
  icon,
  title,
  onPress,
  warning = false,
  danger = false,
  leading,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  onPress: () => void;
  warning?: boolean;
  danger?: boolean;
  leading?: ReactNode;
}) {
  const c = useColors();
  const tone = danger ? c.danger : warning ? c.warning : c.muted;

  return (
    <Skeleton>
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
        {leading ?? <Icon name={icon} size={14} color={tone} />}
        <Text numberOfLines={1} style={[styles.meta, { color: tone, maxWidth: 140 }]}>
          {title}
        </Text>
        <Icon name="chevron-down" size={12} />
      </Pressable>
    </Skeleton>
  );
}

/** Queue (while a turn runs), then send, send now or stop. */
function SendButtons({
  queue,
  onSend,
  stop,
  running,
  disabled,
  busy,
  unavailable,
}: {
  queue?: () => void;
  onSend?: () => void;
  stop: boolean;
  running: boolean;
  disabled?: boolean;
  busy?: boolean;
  unavailable: boolean;
}) {
  const c = useColors();

  return (
    <>
      {queue ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Queue message"
          onPress={queue}
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
        onPress={onSend}
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
    </>
  );
}

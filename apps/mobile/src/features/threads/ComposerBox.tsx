import type { ReactNode } from "react";
import { ActivityIndicator, Animated, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Skeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import type { Mention } from "@canopy/contracts";
import { MessageSpans, type BadgeTone } from "../composer/MessageText";
import { ComposerFold, useComposerMotion } from "../composer/ComposerFold";

const AnimatedInput = Animated.createAnimatedComponent(TextInput);

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
  inline = false,
  onExpand,
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
  /** Bot chats keep their one-row pill when expanded; long drafts still grow. */
  inline?: boolean;
  onExpand?: () => void;
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
  const progress = useComposerMotion(!compact);

  return (
    <Animated.View
      onTouchStart={onExpand}
      style={{
        backgroundColor: c.surface,
        borderRadius: inline ? 24 : 16,
        flexDirection: inline ? "row" : "column",
        alignItems: inline ? "center" : undefined,
        borderWidth: 1,
        borderColor: shell ? c.danger : c.line,
        boxShadow: c.dark ? undefined : "0px 1px 3px #0000001a",
      }}
    >
      {top}

      <ComposerInput
        text={text}
        onChange={onChange}
        busy={busy}
        compact={compact}
        inline={inline}
        onExpand={onExpand}
        placeholder={triggers && !compact ? `${placeholder}\n${TRIGGER_HINT}` : placeholder}
        label={label}
        badges={badges}
      />
      {!inline && (
        <ComposerFold open={!compact}>
          <ComposerControls shell={shell} files={files} sendWidth={running && !empty && onQueue ? 92 : 60}>
            {controls}
          </ComposerControls>
        </ComposerFold>
      )}
      {!inline || !empty || running ? (
        <Animated.View
          style={[
            styles.row,
            inline
              ? { padding: 4, paddingLeft: 0 }
              : {
                  position: "absolute",
                  right: 10,
                  bottom: progress.interpolate({ inputRange: [0, 1], outputRange: [4, 10] }),
                },
            { gap: 4 },
          ]}
        >
          <SendButtons
            queue={running && !empty ? onQueue : undefined}
            onSend={stop ? onStop : onSend}
            stop={stop}
            running={running}
            disabled={disabled}
            busy={busy}
            unavailable={unavailable}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/** The toolbar folds without unmounting its attachment and model pickers. */
function ComposerControls({
  shell,
  files,
  sendWidth,
  children,
}: {
  shell: boolean;
  files: number;
  sendWidth: number;
  children: ReactNode;
}) {
  const c = useColors();

  return (
    <View style={[styles.row, { minHeight: 52, padding: 10, paddingLeft: 12, paddingRight: sendWidth }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.row, { gap: 4, paddingRight: 4 }]}
        style={{ flex: 1 }}
      >
        {shell ? (
          <Text numberOfLines={2} style={[styles.caption, { color: c.danger, flexShrink: 1 }]}>
            {files > 0 ? "Remove the files to run a shell command." : "Runs as a shell command when delivered."}
          </Text>
        ) : (
          children
        )}
      </ScrollView>
    </View>
  );
}

function ComposerInput({
  text,
  onChange,
  busy,
  compact,
  inline,
  onExpand,
  placeholder,
  label,
  badges,
}: Pick<
  Parameters<typeof ComposerBox>[0],
  "text" | "onChange" | "busy" | "compact" | "inline" | "onExpand" | "placeholder" | "label" | "badges"
>) {
  const c = useColors();
  const progress = useComposerMotion(!compact);

  return (
    <AnimatedInput
      accessibilityLabel={label}
      // With badges the spans carry the text; a TextInput takes either children or a value.
      value={badges ? undefined : text}
      onChangeText={(next) => {
        onExpand?.();
        onChange(next);
      }}
      onFocus={onExpand}
      onSelectionChange={badges ? (event) => badges.onSelect(event.nativeEvent.selection) : undefined}
      editable={!busy}
      multiline
      maxLength={32000}
      placeholder={placeholder}
      placeholderTextColor={c.faint}
      style={[
        styles.body,
        {
          minHeight: inline ? 44 : progress.interpolate({ inputRange: [0, 1], outputRange: [44, 64] }),
          flex: inline ? 1 : undefined,
          maxHeight: progress.interpolate({ inputRange: [0, 1], outputRange: [44, 160] }),
          paddingHorizontal: 16,
          paddingRight: inline ? 16 : progress.interpolate({ inputRange: [0, 1], outputRange: [60, 16] }),
          paddingTop: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 14] }),
          paddingBottom: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 12] }),
          color: c.text,
          textAlignVertical: "top",
        },
      ]}
    >
      {badges ? <MessageSpans value={{ text, mentions: badges.mentions }} tone={badges.tone} /> : null}
    </AnimatedInput>
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

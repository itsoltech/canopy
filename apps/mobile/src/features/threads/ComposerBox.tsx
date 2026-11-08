import { useEffect, useRef, type ComponentRef, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, Pressable, ScrollView, Text, View } from "react-native";
import { inputTypography, TextInput } from "../../ui/TextInput";
import Animated, { interpolate, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Skeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import type { Mention } from "@canopy/contracts";
import { MessageSpans, type BadgeTone } from "../composer/MessageText";
import { ComposerFold, useComposerMotion } from "../composer/ComposerFold";

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
  const composerMotion = useComposerMotion();
  const { progress } = composerMotion;

  // The send buttons follow the toolbar's fold; writing keeps both in place (UI thread).
  const sendPosition = useAnimatedStyle(() => ({
    bottom: interpolate(progress.get(), [0, 1], [4, 10]),
  }));

  return (
    <View
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
        inline={inline}
        onExpand={onExpand}
        placeholder={triggers ? TRIGGER_HINT : placeholder}
        triggers={triggers}
        label={label}
        badges={badges}
      />
      {!inline && (
        <ComposerFold open={!compact} hideWhileWriting={false}>
          <ComposerControls shell={shell} files={files} sendWidth={running && !empty && onQueue ? 92 : 60}>
            {controls}
          </ComposerControls>
        </ComposerFold>
      )}
      {!inline || !empty || running ? (
        <Animated.View
          style={[
            styles.row,
            inline ? { padding: 4, paddingLeft: 0 } : [{ position: "absolute", right: 10 }, sendPosition],
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
    </View>
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
  inline,
  onExpand,
  placeholder,
  label,
  badges,
  triggers,
}: Pick<
  Parameters<typeof ComposerBox>[0],
  "text" | "onChange" | "busy" | "inline" | "onExpand" | "placeholder" | "label" | "badges" | "triggers"
>) {
  const c = useColors();
  const { progress, writing, room, focused, onFocus } = useComposerMotion();
  const input = useRef<ComponentRef<typeof TextInput>>(null);

  // Android keeps the field focused when the back gesture closes the keyboard: closing it ends writing, so the
  // controls come back. Only a keyboard that showed during this focus counts (a hardware keyboard shows none).
  useEffect(() => {
    if (!focused) return;
    let shown = false;

    const show = Keyboard.addListener("keyboardDidShow", () => {
      shown = true;
    });

    const hide = Keyboard.addListener("keyboardDidHide", () => {
      if (shown) input.current?.blur();
    });

    return () => {
      show.remove();
      hide.remove();
    };
  }, [focused]);

  // Measure the draft's natural height and retain at least the field's height when writing began.
  const lines = useSharedValue(0);
  const resting = useSharedValue(0);
  const laidOut = useRef(0);

  // Folding shortens the field; writing hands it the controls' room, so the composer keeps its height and nothing
  // above it moves. The toolbar keeps its own space; the send button sits beside the text only when compact. All on the UI thread,
  // on a frame around the field: Android's text input does not take animated sizes itself.
  const fold = useAnimatedStyle(() => {
    const t = progress.get();
    const writes = inline ? 0 : writing.get() * t;
    const padTop = interpolate(t, [0, 1], [10, 14]);
    const padBottom = interpolate(t, [0, 1], [10, 12]);
    const max = interpolate(t, [0, 1], [44, 160]);

    const natural = Math.min(
      max,
      Math.max(inline ? 44 : interpolate(t, [0, 1], [44, 64]), lines.get() + padTop + padBottom),
    );

    // Writing: the field fills the room it was given (its height when writing began plus the controls' room) and
    // grows past it only when the text does.
    const writingSize = Math.max(natural, resting.get() + room.get());

    return {
      minHeight: natural + (writingSize - natural) * writes,
      maxHeight: max + room.get() * writes,
      paddingRight: inline ? 16 : interpolate(t, [0, 1], [60, 16]),
      paddingTop: padTop,
      paddingBottom: padBottom,
    };
  });

  return (
    <Animated.View
      onLayout={(event) => {
        laidOut.current = event.nativeEvent.layout.height;
      }}
      style={[{ flex: inline ? 1 : undefined, paddingLeft: 16 }, fold]}
    >
      <View style={{ flexGrow: 1, flexShrink: 1 }}>
        <TextInput
          ref={input}
          onContentSizeChange={(event) => lines.set(event.nativeEvent.contentSize.height)}
          accessibilityLabel={label}
          // With badges the spans carry the text; a TextInput takes either children or a value.
          value={badges ? undefined : text}
          onChangeText={(next) => {
            onExpand?.();
            onChange(next);
          }}
          onFocus={() => {
            resting.set(laidOut.current);
            onExpand?.();
            onFocus(true);
          }}
          onBlur={() => onFocus(false)}
          onSelectionChange={badges ? (event) => badges.onSelect(event.nativeEvent.selection) : undefined}
          editable={!busy}
          multiline
          maxLength={32000}
          placeholder={triggers ? undefined : placeholder}
          accessibilityHint={triggers ? placeholder : undefined}
          placeholderTextColor={c.faint}
          style={[styles.body, { flexGrow: 1, flexShrink: 1, padding: 0, color: c.text, textAlignVertical: "top" }]}
        >
          {badges ? <MessageSpans value={{ text, mentions: badges.mentions }} tone={badges.tone} /> : null}
        </TextInput>
        {/* Native multiline placeholders wrap and affect content size; the hint must do neither. */}
        {triggers && !text ? (
          <Text
            pointerEvents="none"
            accessible={false}
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[styles.body, inputTypography, { position: "absolute", top: 0, left: 0, right: 0, color: c.faint }]}
          >
            {placeholder}
          </Text>
        ) : null}
      </View>
    </Animated.View>
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

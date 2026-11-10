import { useRef, type ComponentRef, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { inputTypography, TextInput } from "../../ui/TextInput";
import Animated, { interpolate, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Skeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import type { Mention } from "@canopy/contracts";
import { MessageSpans, type BadgeTone } from "../composer/MessageText";
import { ComposerFold, useComposerMotion } from "../composer/ComposerFold";
import { useChatInputID } from "../composer/ChatKeyboard";
import { useKeyboardBlur } from "../composer/useKeyboardBlur";
import { composerGeometry } from "../composer/geometry";
import { SendButtons, SPLIT_SEND_WIDTH } from "./SendButtons";
import { useTween } from "../../ui/motion";

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
  onAlternate,
  primary = "steer",
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
  shellCommands = true,
  canSend = true,
}: {
  text: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onAlternate?: () => void;
  primary?: "steer" | "queue";
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
  /** Bot chats treat leading exclamation marks as ordinary text. */
  shellCommands?: boolean;
  canSend?: boolean;
}) {
  const c = useColors();
  const empty = !text.trim() && files === 0;
  // A leading "!" runs the text as a shell command on the worker when it is delivered (docs/ui-api.md).
  const shell = shellCommands && text.startsWith("!");
  const shellIssue = shell && (text.trim() === "!" || files > 0);
  const stop = running && empty && Boolean(onStop);
  const unavailable = disabled || busy || (!stop && (empty || !canSend)) || shellIssue;
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
      {inline && controls ? <View style={{ paddingLeft: 4 }}>{controls}</View> : null}

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
        <ComposerFold open={!compact} expandedHeight={composerGeometry.toolbar} hideWhileWriting={false}>
          <ComposerControls
            shell={shell}
            files={files}
            sendWidth={running && !empty && onAlternate ? SPLIT_SEND_WIDTH + 14 : 60}
          >
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
            alternate={running && !empty ? onAlternate : undefined}
            primary={primary}
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

/** The toolbar folds without unmounting its attachment and model pickers; the pills glide aside for the send slot. */
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
  const room = useTween(sendWidth);
  const slot = useAnimatedStyle(() => ({ paddingRight: room.get() }));

  return (
    <Animated.View style={[styles.row, { minHeight: composerGeometry.toolbar, padding: 10, paddingLeft: 12 }, slot]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.row, { flexGrow: 1, justifyContent: "flex-end", gap: 4, paddingRight: 4 }]}
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
    </Animated.View>
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
  const nativeID = useChatInputID();
  useKeyboardBlur(input, focused);

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
      Math.max(inline ? 44 : interpolate(t, [0, 1], [44, composerGeometry.input]), lines.get() + padTop + padBottom),
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
          nativeID={nativeID}
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
  loadingWidth,
  loading,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  onPress: () => void;
  warning?: boolean;
  danger?: boolean;
  leading?: ReactNode;
  loadingWidth?: number;
  loading?: boolean;
}) {
  const c = useColors();
  const tone = danger ? c.danger : warning ? c.warning : c.muted;

  return (
    <Skeleton loading={loading}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: composerGeometry.secondary,
          width: loading ? loadingWidth : undefined,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 6,
          borderRadius: 6,
          backgroundColor: pressed ? c.inset : "transparent",
        })}
      >
        {leading ?? <Icon name={icon} size={14} color={tone} />}
        <Text numberOfLines={1} style={[styles.meta, { color: tone, maxWidth: 140, flexShrink: 1 }]}>
          {title}
        </Text>
        <Icon name="chevron-down" size={12} />
      </Pressable>
    </Skeleton>
  );
}

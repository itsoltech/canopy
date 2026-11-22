import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { Skeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import type { Mention, ui } from "@canopy/contracts";
import type { BadgeTone } from "../composer/MessageText";
import { ComposerFold, useComposerMotion } from "../composer/ComposerFold";
import { ComposerInput } from "../composer/ComposerInput";
import type { ComposerPendingItem } from "@canopy/domain/composer-pending";
import { composerGeometry } from "../composer/geometry";
import { SendButtons } from "./SendButtons";
import { useTween } from "../../ui/motion";
import { startsWithShellCommand } from "./sandbox";

/** What each trigger character does, as on the web; no-break spaces keep each item on one line. */
const TRIGGER_HINT = ["/ commands", "$ skills", "@ files", "# threads"]
  .map((item) => item.replace(" ", "\u00a0"))
  .join(" · ");

/** Badges in the text (the message draft's files); without it the field is plain text. */
export interface ComposerBadges {
  onBlur?: () => void;
  mentions: readonly Mention[];
  quotes?: readonly ui.Quote[];
  focusAt?: { current: ((caret: number) => void) | undefined };
  editQuote?: (index: number, quote: ui.Quote) => void;
  removeQuote?: (index: number) => void;
  onSelect: (selection: { start: number; end: number }) => void;
  tone?: (mention: Mention) => BadgeTone;
}

export interface ComposerBoxProps {
  text: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onAlternate?: () => void;
  primary?: "steer" | "queue";
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  /** Thread Stop remains reachable during watch recovery, independently of Send. */
  stopDisabled?: boolean;
  busy?: boolean;
  /** Pinned before the field in inline mode, or to the toolbar's left edge. */
  attachment?: ReactNode;
  controls?: ReactNode;
  /** Draft actions reserve their own height only while their tab is visible. */
  drafts?: ReactNode;
  compact?: boolean;
  pending?: readonly ComposerPendingItem[];
  /** Bot chats keep their one-row pill when expanded; long drafts still grow. */
  inline?: boolean;
  /** An action slot before Send in an inline composer. Keeps the Send button visible. */
  beforeSend?: ReactNode;
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
  shellUnavailable?: string;
  canSend?: boolean;
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
  readonly,
  stopDisabled,
  busy,
  attachment,
  controls,
  drafts,
  compact = false,
  pending,
  inline = false,
  beforeSend,
  onExpand,
  placeholder = "Ask anything…",
  top,
  files = 0,
  label = "Message to your agent",
  badges,
  triggers = false,
  shellCommands = true,
  shellUnavailable,
  canSend = true,
}: ComposerBoxProps) {
  const c = useColors();
  const [sendWidth, setSendWidth] = useState(36);
  const sendInset = Math.max(60, sendWidth + 14);
  const empty = !text.trim() && files === 0;
  // A leading "!" runs the text as a shell command on the worker when it is delivered (docs/ui-api.md).
  const shell = shellCommands && (shellUnavailable ? startsWithShellCommand(text) : text.startsWith("!"));
  const shellIssue = shell && (shellUnavailable || text.trim() === "!" || files > 0);
  const stop = running && empty && Boolean(onStop);

  const unavailable = stop
    ? (stopDisabled ?? (disabled || busy || false))
    : Boolean(disabled || busy || empty || !canSend || shellIssue);

  const composerMotion = useComposerMotion();
  const { progress } = composerMotion;

  // The send buttons follow the toolbar's fold; writing keeps both in place (UI thread).
  const sendPosition = useAnimatedStyle(() => ({
    bottom: interpolate(progress.get(), [0, 1], [4, 10]),
  }));

  return (
    <View>
      {drafts}
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
        {top ? (
          <ComposerFold open={!compact} expandedHeight={0} hideWhileWriting={false}>
            {top}
          </ComposerFold>
        ) : null}
        {inline && attachment ? <View style={{ paddingLeft: 4, flexShrink: 0 }}>{attachment}</View> : null}

        <ComposerInput
          text={text}
          onChange={onChange}
          busy={busy || readonly}
          inline={inline}
          compact={compact}
          pending={pending}
          onExpand={onExpand}
          placeholder={
            triggers ? TRIGGER_HINT + (shellCommands && !shellUnavailable ? " · !\u00a0shell" : "") : placeholder
          }
          triggers={triggers}
          label={label}
          badges={badges}
          sendInset={sendInset}
        />
        {!inline && (
          <ComposerFold open={!compact} expandedHeight={composerGeometry.toolbar} hideWhileWriting={false}>
            <ComposerControls {...{ shell, shellUnavailable, files, attachment }} sendWidth={sendInset}>
              {controls}
            </ComposerControls>
          </ComposerFold>
        )}
        {!inline || beforeSend || !empty || running ? (
          <Animated.View
            onLayout={(event) => setSendWidth(event.nativeEvent.layout.width)}
            style={[
              styles.row,
              inline
                ? { padding: 4, paddingLeft: 0, flexShrink: 0 }
                : [{ position: "absolute", right: 10 }, sendPosition],
              { gap: 4 },
            ]}
          >
            {beforeSend}
            <SendButtons
              alternate={running && !empty ? onAlternate : undefined}
              primary={primary}
              onSend={stop ? onStop : onSend}
              stop={stop}
              running={running}
              disabled={stop ? unavailable : disabled}
              busy={busy}
              unavailable={unavailable}
            />
          </Animated.View>
        ) : null}
      </View>
    </View>
  );
}

/** The toolbar folds without unmounting its attachment and model pickers; the pills glide aside for the send slot. */
function ComposerControls({
  shell,
  shellUnavailable,
  files,
  attachment,
  sendWidth,
  children,
}: {
  shell: boolean;
  shellUnavailable?: string;
  files: number;
  attachment: ReactNode;
  sendWidth: number;
  children: ReactNode;
}) {
  const c = useColors();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const room = useTween(sendWidth);
  const slot = useAnimatedStyle(() => ({ paddingRight: room.get() }));

  return (
    <Animated.View
      style={[styles.row, { minHeight: composerGeometry.toolbar, padding: 10, paddingLeft: 12, gap: 4 }, slot]}
    >
      {!shell && attachment ? <View style={{ flexShrink: 0 }}>{attachment}</View> : null}
      {shell && shellUnavailable ? (
        <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: c.danger, flex: 1 }]}>
          {shellUnavailable}
        </Text>
      ) : (
        <ScrollView
          ref={scroll}
          horizontal
          alwaysBounceHorizontal={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          // Keep the trailing choices beside Send as the catalog or available width changes.
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
          onLayout={() => scroll.current?.scrollToEnd({ animated: false })}
          contentContainerStyle={[styles.row, { flexGrow: 1, justifyContent: "flex-end", gap: 4 }]}
          style={{ flex: 1, minWidth: 0, marginRight: 4 }}
        >
          {shell ? (
            <Text numberOfLines={2} style={[styles.caption, { color: c.danger, flexShrink: 1 }]}>
              {files > 0 ? "Remove the files to run a shell command." : "Runs as a shell command when delivered."}
            </Text>
          ) : (
            children
          )}
        </ScrollView>
      )}
    </Animated.View>
  );
}

export function ComposerPill({
  icon,
  title,
  accessibilityLabel = title,
  onPress,
  warning = false,
  danger = false,
  leading,
  loadingWidth,
  loading,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  accessibilityLabel?: string;
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
        accessibilityLabel={accessibilityLabel}
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

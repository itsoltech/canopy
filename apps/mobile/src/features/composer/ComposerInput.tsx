import { Pressable, Text, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { inputTypography, TextInput } from "../../ui/TextInput";
import { styles, useColors } from "../../ui/theme";
import type { ComposerBoxProps } from "../threads/ComposerBox";
import { MessageSpans } from "./MessageText";
import { useComposerMotion } from "./ComposerFold";
import { useChatInputID } from "./ChatKeyboard";
import { useKeyboardBlur } from "./useKeyboardBlur";
import { composerGeometry } from "./geometry";
import { ComposerPending } from "./ComposerPending";
import { useCitationInput } from "./useCitationInput";

type Props = Pick<
  ComposerBoxProps,
  | "text"
  | "onChange"
  | "busy"
  | "inline"
  | "compact"
  | "pending"
  | "onExpand"
  | "placeholder"
  | "label"
  | "badges"
  | "triggers"
> & { sendInset?: number };

const expandedPadding = { top: 14, bottom: 12 };

export function ComposerInput({
  text,
  onChange,
  busy,
  inline,
  compact,
  pending = [],
  onExpand,
  placeholder,
  label,
  badges,
  triggers,
  sendInset = 60,
}: Props) {
  const c = useColors();
  const { progress, writing, room, onFocus } = useComposerMotion();
  const { input, edit, editor } = useCitationInput(badges);
  const nativeID = useChatInputID();
  useKeyboardBlur(input);

  const lines = useSharedValue(0);
  const resting = useSharedValue(0);

  const expand = () => {
    onExpand?.();
    input.current?.focus();
  };

  // Only the overlay resizes. Writing keeps the room given to the input by the folding controls.
  const fold = useAnimatedStyle(() => {
    const t = progress.get();
    const writes = inline ? 0 : writing.get() * t;
    const padTop = interpolate(t, [0, 1], [10, expandedPadding.top]);
    const padBottom = interpolate(t, [0, 1], [10, expandedPadding.bottom]);
    const max = interpolate(t, [0, 1], [44, 160]);

    const natural = Math.min(
      max,
      Math.max(inline ? 44 : interpolate(t, [0, 1], [44, composerGeometry.input]), lines.get() + padTop + padBottom),
    );

    const writingSize = Math.max(natural, resting.get() + room.get());

    return {
      minHeight: natural + (writingSize - natural) * writes,
      maxHeight: max + room.get() * writes,
      paddingRight: inline ? 16 : interpolate(t, [0, 1], [sendInset, 16]),
      paddingTop: padTop,
      paddingBottom: padBottom,
    };
  });

  return (
    <Animated.View
      onTouchStart={compact ? expand : undefined}
      style={[{ flex: inline ? 1 : undefined, paddingLeft: 16, flexDirection: "row", gap: 8 }, fold]}
    >
      {compact && pending.length ? <ComposerPending items={pending} onExpand={expand} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* The field keeps its intrinsic height; the remaining writing room still accepts taps. */}
        <Pressable accessible={false} focusable={false} onPress={expand} style={{ position: "absolute", inset: 0 }} />
        <TextInput
          nativeID={nativeID}
          ref={input}
          onContentSizeChange={(event) => lines.set(event.nativeEvent.contentSize.height)}
          accessibilityLabel={label}
          accessibilityElementsHidden={compact}
          importantForAccessibility={compact ? "no-hide-descendants" : "auto"}
          value={badges ? undefined : text}
          onChangeText={(next) => {
            onExpand?.();
            onChange(next);
          }}
          onFocus={() => {
            // A rapid refocus must not capture the extra room from an unfinished blur animation.
            resting.set(
              Math.min(
                160,
                Math.max(
                  inline ? 44 : composerGeometry.input,
                  lines.get() + expandedPadding.top + expandedPadding.bottom,
                ),
              ),
            );
            onExpand?.();
            onFocus(true);
          }}
          onBlur={() => {
            onFocus(false);
            badges?.onBlur?.();
          }}
          onSelectionChange={badges ? (event) => badges.onSelect(event.nativeEvent.selection) : undefined}
          editable={!busy}
          multiline
          maxLength={32000}
          placeholder={triggers ? undefined : placeholder}
          accessibilityHint={triggers ? placeholder : undefined}
          placeholderTextColor={c.faint}
          style={[
            styles.body,
            {
              // Stretching to fill the writing room can feed that height back through onContentSizeChange.
              flexShrink: 1,
              padding: 0,
              color: c.text,
              textAlignVertical: "top",
              opacity: compact ? 0 : 1,
            },
          ]}
        >
          {badges ? (
            <MessageSpans
              value={{ text, mentions: badges.mentions, quotes: badges.quotes }}
              tone={badges.tone}
              onQuote={edit}
            />
          ) : null}
        </TextInput>
        {compact ? (
          <CompactPreview text={text} label={label} placeholder={placeholder} onExpand={expand} />
        ) : triggers && !text ? (
          <TriggerPlaceholder placeholder={placeholder} />
        ) : null}
      </View>
      {editor}
    </Animated.View>
  );
}

function TriggerPlaceholder({ placeholder }: Pick<Props, "placeholder">) {
  const c = useColors();

  return (
    <Text
      pointerEvents="none"
      accessible={false}
      numberOfLines={1}
      ellipsizeMode="tail"
      style={[styles.body, inputTypography, { position: "absolute", top: 0, left: 0, right: 0, color: c.faint }]}
    >
      {placeholder}
    </Text>
  );
}

function CompactPreview({
  text,
  label,
  placeholder,
  onExpand,
}: Pick<Props, "text" | "label" | "placeholder" | "onExpand">) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text ? `${label}: ${text}` : label}
      accessibilityHint="Expand message"
      onPress={onExpand}
      style={{ position: "absolute", inset: 0 }}
    >
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={[styles.body, inputTypography, { color: text ? c.text : c.faint }]}
      >
        {text ? text.split("\n")[0] : placeholder}
      </Text>
    </Pressable>
  );
}

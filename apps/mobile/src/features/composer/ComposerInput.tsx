import { useRef, type ComponentRef } from "react";
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
>;

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
}: Props) {
  const c = useColors();
  const { progress, writing, room, focused, onFocus } = useComposerMotion();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const nativeID = useChatInputID();
  useKeyboardBlur(input, focused);

  const lines = useSharedValue(0);
  const resting = useSharedValue(0);
  const laidOut = useRef(0);

  const expand = () => {
    onExpand?.();
    input.current?.focus();
  };

  // Only the overlay resizes. Writing keeps the room given to the input by the folding controls.
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
      onTouchStart={compact ? expand : undefined}
      onLayout={(event) => {
        laidOut.current = event.nativeEvent.layout.height;
      }}
      style={[{ flex: inline ? 1 : undefined, paddingLeft: 16, flexDirection: "row", gap: 8 }, fold]}
    >
      {compact && pending.length ? <ComposerPending items={pending} onExpand={expand} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
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
          style={[
            styles.body,
            {
              flexGrow: 1,
              flexShrink: 1,
              padding: 0,
              color: c.text,
              textAlignVertical: "top",
              opacity: compact ? 0 : 1,
            },
          ]}
        >
          {badges ? <MessageSpans value={{ text, mentions: badges.mentions }} tone={badges.tone} /> : null}
        </TextInput>
        {compact ? (
          <CompactPreview text={text} label={label} placeholder={placeholder} onExpand={expand} />
        ) : triggers && !text ? (
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

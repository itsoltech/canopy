import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { useMentionSuggestions, type ActiveTrigger, type MentionOption } from "./useMentionSuggestions";

const emptyText = {
  "/": "No commands match.",
  $: "No skills or plugins match.",
  "@": "No files match.",
  "#": "No threads match.",
} as const;

const iconOf = (option: MentionOption) =>
  option.group === "Files"
    ? option.mention.isDir
      ? ("folder" as const)
      : ("document-text" as const)
    : option.group === "Threads"
      ? ("chat-bubble-left" as const)
      : option.group === "Plugins"
        ? ("swatch" as const)
        : option.group === "Skills"
          ? ("sparkles" as const)
          : ("command-line" as const);

/**
 * The mention list over the composer while the caret is in a trigger ("/", "$", "@", "#"): compact rows grouped
 * as on the web; tapping one puts its badge in place of the typed query.
 */
export function MentionSuggestions({
  scope,
  trigger,
  onPick,
}: {
  scope: ui.MentionScope | undefined;
  trigger: ActiveTrigger | undefined;
  onPick: (option: MentionOption) => void;
}) {
  const c = useColors();
  const { options, loading, error } = useMentionSuggestions(scope, trigger);

  if (!trigger) return null;

  return (
    <View
      accessibilityLabel="Suggestions"
      style={{
        maxHeight: 240,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: c.overlay,
        overflow: "hidden",
      }}
    >
      <ScrollView keyboardShouldPersistTaps="always" contentContainerStyle={{ padding: 4 }}>
        {options.map((option, index) => (
          <View key={option.key}>
            {option.group !== options[index - 1]?.group ? (
              <Text
                accessibilityRole="header"
                style={[
                  styles.overlayHeading,
                  { color: c.faint, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
                ]}
              >
                {option.group}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={[option.title, option.detail].filter(Boolean).join(", ")}
              onPress={() => onPick(option)}
              style={({ pressed }) => [
                styles.row,
                {
                  minHeight: 44,
                  paddingHorizontal: 12,
                  gap: 10,
                  borderRadius: 10,
                  backgroundColor: pressed ? c.inset : "transparent",
                },
              ]}
            >
              <Icon name={iconOf(option)} size={16} color={c.muted} />
              <Text numberOfLines={1} style={[styles.overlay, { color: c.text, flexShrink: 1 }]}>
                {option.title}
              </Text>
              {option.detail ? (
                <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, flex: 1 }]}>
                  {option.detail}
                </Text>
              ) : null}
            </Pressable>
          </View>
        ))}
        {!options.length && (
          <View style={[styles.row, { minHeight: 44, paddingHorizontal: 12 }]}>
            {loading ? <ActivityIndicator size="small" color={c.muted} /> : null}
            <Text style={[styles.overlayMeta, { color: error ? c.danger : c.muted, flex: 1 }]}>
              {error || (loading ? "Searching…" : emptyText[trigger.char])}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

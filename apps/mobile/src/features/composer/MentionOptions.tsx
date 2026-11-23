import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { MentionKind } from "@canopy/contracts";
import { AnchoredOverlay } from "../../ui/AnchoredOverlay";
import { Skeleton } from "../../ui/Skeleton";
import { Icon } from "../../ui/Icon";
import { Button, IconButton } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import type { MentionOption } from "./useMentionSuggestions";

function iconOf(option: MentionOption) {
  switch (option.group) {
    case "Bots":
      return "chat-bubble-left-right";
    case "Connectors":
      return "link";
    case "Files":
      return option.mention.isDir ? "folder" : "document-text";
    case "Threads":
      return "chat-bubble-left";
    case "Pull requests":
      return "git-pull-request";
    case "Issues":
      return "exclamation-circle";
    case "Plugins":
      return "swatch";
    case "Skills":
      return "sparkles";
    default:
      return "command-line";
  }
}

/** Shared compact suggestions; each composer supplies its own authorized sources. */
export function MentionOptions({
  options,
  loading,
  error,
  label = "Suggestions",
  maxHeight = 280,
  inline,
  onRetry,
  warnings,
  notice,
  empty,
  onPick,
  queryKey,
}: {
  options: readonly MentionOption[];
  loading: boolean;
  error?: string | undefined;
  warnings?: readonly string[] | undefined;
  notice?: string | undefined;
  label?: string;
  maxHeight?: number;
  inline?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  empty: string;
  onPick: (option: MentionOption) => void;
  queryKey: string;
}) {
  const c = useColors();
  const [dismissedQuery, setDismissedQuery] = useState<string>();

  const rows = (
    <>
      {options.map((option, index) => (
        <View key={option.key}>
          {option.group !== label && option.group !== options[index - 1]?.group ? (
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
          <OptionRow option={option} loading={loading} onPick={onPick} />
        </View>
      ))}
      {!options.length && !warnings?.length && (
        <View style={[styles.row, { minHeight: 44, paddingHorizontal: 12 }]}>
          {loading ? (
            <>
              <Skeleton style={{ width: 16, height: 16 }} />
              <Skeleton style={{ width: "70%", height: 16 }} />
            </>
          ) : (
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.overlayMeta, { color: error ? c.danger : c.muted, flex: 1 }]}
            >
              {error || empty}
            </Text>
          )}
        </View>
      )}
      {warnings?.length ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.overlayMeta, { color: c.warning, paddingHorizontal: 12, paddingVertical: 6 }]}
        >
          {warnings.join("\n")}
        </Text>
      ) : null}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted, padding: 12 }]}>
          {notice}
        </Text>
      ) : null}
      {onRetry ? <Button variant="text" size="sm" title="Retry" onPress={onRetry} /> : null}
    </>
  );

  if (inline) {
    if (dismissedQuery === queryKey) return null;

    return (
      <View style={{ borderRadius: 10, backgroundColor: c.inset }}>
        <View style={[styles.row, { paddingHorizontal: 12 }]}>
          <Text accessibilityRole="header" style={[styles.overlayHeading, { flex: 1, color: c.muted }]}>
            {label}
          </Text>
          <IconButton
            icon="x-mark"
            label={`Close ${label.toLowerCase()}`}
            size="sm"
            onPress={() => setDismissedQuery(queryKey)}
          />
        </View>
        <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="always" style={{ maxHeight: 140 }}>
          {rows}
        </ScrollView>
      </View>
    );
  }

  return (
    <AnchoredOverlay
      visible={dismissedQuery !== queryKey}
      onClose={() => setDismissedQuery(queryKey)}
      label={label}
      modal={false}
      maxHeight={maxHeight}
    >
      {rows}
    </AnchoredOverlay>
  );
}

function OptionRow({
  option,
  loading,
  onPick,
}: {
  option: MentionOption;
  loading: boolean;
  onPick: (option: MentionOption) => void;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        option.group === "Pull requests"
          ? "Pull request"
          : option.group === "Issues"
            ? "Issue"
            : option.group === "Threads"
              ? "Thread"
              : "",
        option.title,
        option.detail,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ disabled: loading }}
      disabled={loading}
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
      {option.mention.kind === MentionKind.ISSUE ? (
        <View style={{ flex: 1, gap: 2, paddingVertical: 6 }}>
          <Text numberOfLines={2} style={[styles.overlay, { color: c.text }]}>
            {option.title}
          </Text>
          <Text numberOfLines={2} style={[styles.overlayMeta, { color: c.muted }]}>
            {option.detail}
          </Text>
        </View>
      ) : (
        <>
          <Text numberOfLines={1} style={[styles.overlay, { color: c.text, flexShrink: 1 }]}>
            {option.title}
          </Text>
          {option.detail ? (
            <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, flex: 1 }]}>
              {option.detail}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

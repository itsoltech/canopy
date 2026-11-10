import { Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { fileLook } from "@canopy/domain/github-read";
import { safeHref } from "@canopy/domain/markdown";
import { Icon } from "../../ui/Icon";
import { Diff } from "../../ui/Diff";
import { Button, Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { IconAction } from "./IconAction";
import { toast } from "../../ui/Toast";
import { toneColor } from "./presentation";

export function CodeFileHeader({
  file,
  active,
  depth,
  onPress,
}: {
  file: github.PullRequestFile;
  active: boolean;
  depth: number;
  onPress: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const look = fileLook(file);
  const href = safeHref(file.url);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: c.background,
        borderBottomWidth: 1,
        borderColor: c.line,
        paddingLeft: Math.min(depth, 6) * 12,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${look.label}: ${file.previousPath ? `${file.previousPath} → ` : ""}${file.path}`}
        accessibilityState={{ expanded: active }}
        onPress={onPress}
        onLongPress={() => toast(look.label)}
        style={{ flex: 1, minWidth: 0, flexDirection: "row", minHeight: 48, alignItems: "center", gap: 6 }}
      >
        <Icon name={active ? "chevron-down" : "chevron-right"} size={12} />
        <Icon name={look.icon} color={toneColor(c, look.tone)} />
        <Text numberOfLines={1} ellipsizeMode="middle" style={[type.mono, { flex: 1, color: c.text }]}>
          {file.previousPath ? `${file.previousPath} → ` : ""}
          {file.path}
        </Text>
      </Pressable>
      <Text style={[type.meta, { color: c.success }]}>+{file.additions}</Text>
      <Text style={[type.meta, { color: c.danger }]}>−{file.deletions}</Text>
      {active && !!href && (
        <IconAction
          icon="arrow-top-right-on-square"
          label="Open file on GitHub"
          onPress={() => void Linking.openURL(href)}
        />
      )}
    </View>
  );
}

export function CodeFileDiff({
  file,
  patch,
  busy,
  error,
  onRetry,
}: {
  file: github.PullRequestFile;
  patch: github.PullRequestDiff | undefined;
  busy: boolean;
  error: string;
  onRetry: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const href = safeHref(file.url);

  return (
    <View style={{ gap: 8, paddingVertical: 8 }}>
      {busy && <Text style={[type.meta, { color: c.muted }]}>Loading patch…</Text>}
      {!!error && (
        <>
          <Notice error>{error}</Notice>
          <Button title="Retry" variant="ghost" onPress={onRetry} />
        </>
      )}
      {patch?.patch ? (
        <Diff diff={patch.patch} label={file.path} bare toolbar={false} />
      ) : (
        !busy &&
        !error && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              padding: 8,
              backgroundColor: c.inset,
              borderRadius: 6,
            }}
          >
            <Text style={[type.meta, { flex: 1, color: c.muted }]}>
              {patch?.page?.detail || (file.patchState === "binary" ? "Binary file" : "Patch loads on demand")}
            </Text>
            {patch || file.patchState === "binary" ? (
              <Button
                title="Open on GitHub"
                variant="ghost"
                disabled={!href}
                onPress={() => {
                  if (href) void Linking.openURL(href);
                }}
              />
            ) : (
              <Button title="Load diff" variant="ghost" onPress={onRetry} />
            )}
          </View>
        )
      )}
      {!!patch?.patch && !!patch.page?.detail && <Notice>{patch.page.detail}</Notice>}
    </View>
  );
}

import { useState, type ReactNode } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { workspaceParentPath } from "@canopy/domain/workspace-sources";
import { Button, Field, IconButton, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { SkeletonScope } from "../../ui/Skeleton";
import { font, useColors, useTypography } from "../../ui/theme";
import { useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export function DirectoryPicker({
  workerId,
  initialPath = "",
  onChoose,
  actionLabel = "Use this directory",
  busy = false,
  disabled = false,
  notice,
}: {
  workerId: string;
  initialPath?: string;
  onChoose: (path: string) => void;
  actionLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  notice?: ReactNode;
}) {
  const c = useColors();
  const type = useTypography();
  const [path, setPath] = useState(initialPath);
  const [draft, setDraft] = useState<string>();

  const resource = useSettingsResource(
    `ListDirectory:${workerId}:${path}`,
    (api) => api.listDirectory({ workerId, path }),
    !disabled,
  );

  const current = resource.data?.path ?? "";
  const input = draft ?? (current || initialPath);
  const edited = draft !== undefined && draft.trim() !== (current || initialPath);
  const parent = workspaceParentPath(current);
  const entries = resource.data?.entries.filter((entry) => entry.isDir) ?? [];
  const ready = !!current && !resource.loading && !resource.error && !disabled;

  function open(next: string) {
    if (busy || disabled) return;
    setDraft(undefined);
    setPath(next);
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Field
              label="Directory path"
              value={input}
              placeholder={current || "~"}
              onChangeText={setDraft}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy && !disabled}
              returnKeyType="go"
              onSubmitEditing={() => open(input.trim())}
            />
          </View>
          <IconButton
            icon="chevron-right"
            label="Open directory"
            variant="secondary"
            disabled={busy || disabled}
            onPress={() => open(input.trim())}
          />
        </View>
        <Button
          icon="arrow-uturn-left"
          title="Parent directory"
          variant="text"
          size="sm"
          disabled={busy || !ready || !parent || parent === current}
          onPress={() => open(parent)}
        />
      </View>
      <FlatList
        style={{ flex: 1, borderTopWidth: 1, borderColor: c.line }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 4 }}
        data={resource.loading || resource.error ? [] : entries}
        keyExtractor={(entry) => entry.name}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        maxToRenderPerBatch={14}
        windowSize={5}
        ListEmptyComponent={
          <DirectoryEmpty loading={resource.loading} error={!!resource.error} onRetry={() => void resource.reload()} />
        }
        renderItem={({ item }) => (
          <DirectoryRow
            name={item.name}
            git={item.isGitRepo}
            busy={busy || disabled}
            onPress={() => open(`${current.replace(/[/\\]+$/, "")}${current.includes("\\") ? "\\" : "/"}${item.name}`)}
          />
        )}
      />
      <View style={{ padding: 16, gap: 10, borderTopWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
        {notice}
        <Text numberOfLines={2} ellipsizeMode="middle" style={[type.meta, { fontFamily: font.medium, color: c.muted }]}>
          {current || "Choose a directory above"}
        </Text>
        <Button
          variant="primary"
          title={actionLabel}
          busy={busy}
          disabled={!ready || edited}
          onPress={() => onChoose(current)}
        />
      </View>
    </View>
  );
}

function DirectoryRow({
  name,
  git,
  busy,
  onPress,
}: {
  name: string;
  git: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}${git ? ", Git repository" : ""}`}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 8,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <Icon name="folder" color={c.icon} />
      <Text numberOfLines={1} style={[type.chrome, { color: c.text, flex: 1, minWidth: 0 }]}>
        {name}
      </Text>
      {git && <Text style={[type.meta, { color: c.muted }]}>Git</Text>}
      <Icon name="chevron-right" size={14} color={c.faint} />
    </Pressable>
  );
}

function DirectoryEmpty({ loading, error, onRetry }: { loading: boolean; error: boolean; onRetry: () => void }) {
  const c = useColors();
  const type = useTypography();

  if (loading)
    return (
      <SkeletonScope loading>
        <SettingsSkeletonRows rows={5} />
      </SkeletonScope>
    );

  if (error)
    return (
      <View style={{ padding: 8, gap: 12 }}>
        <Notice error>Could not open this directory. Check the path and retry.</Notice>
        <Button title="Retry" onPress={onRetry} />
      </View>
    );

  return <Text style={[type.small, { color: c.muted, padding: 12 }]}>No subdirectories here.</Text>;
}

import { useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Workspace, WorkspaceEntry } from "@canopy/domain/workspace";
import { tabName, tabPath, tabDirty } from "@canopy/domain/workspace-modules";
import { PickerSheet } from "../../ui/Picker";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { MinimumTouchTarget } from "../../ui/density";
import { Skeleton } from "../../ui/Skeleton";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { WorkspaceTabActions } from "./WorkspaceTabActions";

export function WorkspaceTabs({
  view,
  title,
  loading = false,
  expanded = false,
  onThreadActions,
}: {
  view: Workspace;
  title: string;
  loading?: boolean;
  expanded?: boolean;
  onThreadActions?: () => void;
}) {
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<WorkspaceEntry>();
  const [observedError, setObservedError] = useState(view.error);
  const current = view.current;
  const name = current ? tabName(current) : title;
  const count = view.tabs.length + 1;
  const dirty = Boolean(current && tabDirty(current));

  if (view.error !== observedError) {
    setObservedError(view.error);

    if (view.error) setOpen(true);
  }

  return (
    <MinimumTouchTarget.Provider value={48}>
      <View style={s.tabs}>
        {expanded && current && (
          <TabButton name={title} label={title} active={false} onPress={() => view.select("thread")} />
        )}
        <TabButton
          name={name}
          label={`Switch tab, ${name}${current ? `, ${tabPath(current)}` : ""}, ${count} ${count === 1 ? "tab" : "tabs"}${dirty ? ", Unsaved changes" : ""}${current?.preview ? ", Preview" : ""}`}
          active
          switcher
          expanded={open}
          dirty={dirty}
          preview={current?.preview}
          loading={loading}
          onPress={() => setOpen(true)}
          onLongPress={current ? () => setActions(current) : onThreadActions}
        />
      </View>
      <PickerSheet
        title="Switch tab"
        visible={open}
        onClose={() => setOpen(false)}
        value={view.active}
        sections={[
          {
            options: [
              { value: "thread", label: title },
              ...view.tabs.map((tab) => ({
                value: tab.id,
                label: tabName(tab),
                description: tabPath(tab),
                badge: tabDirty(tab) ? "Unsaved changes" : tab.preview ? "Preview" : undefined,
              })),
            ],
          },
        ]}
        onSelect={(id) => {
          view.select(id);
          setOpen(false);
        }}
        footer={
          <View style={s.footer}>
            {onThreadActions && (
              <Button
                title="Thread actions"
                onPress={() => {
                  setOpen(false);
                  onThreadActions();
                }}
              />
            )}
            {view.error ? (
              <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
                {view.error}
              </Text>
            ) : null}
            {current ? (
              <Button
                title="Tab actions"
                onPress={() => {
                  setOpen(false);
                  setActions(current);
                }}
              />
            ) : null}
          </View>
        }
      />
      <WorkspaceTabActions view={view} tab={actions} onClose={() => setActions(undefined)} />
    </MinimumTouchTarget.Provider>
  );
}

function TabButton({
  name,
  label,
  active,
  switcher = false,
  expanded,
  dirty = false,
  preview = false,
  loading = false,
  onPress,
  onLongPress,
}: {
  name: string;
  label: string;
  active: boolean;
  switcher?: boolean;
  expanded?: boolean;
  dirty?: boolean;
  preview?: boolean;
  loading?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <Pressable
      accessibilityRole={switcher ? "button" : "tab"}
      accessibilityLabel={label}
      accessibilityState={{ expanded: switcher ? expanded : undefined, selected: active, disabled: loading }}
      disabled={loading}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [s.tab, { backgroundColor: pressed ? c.pressed : active ? c.background : "transparent" }]}
    >
      {loading ? (
        <View style={s.name}>
          <Skeleton style={{ width: "80%", height: 16 }} />
        </View>
      ) : (
        <Text
          numberOfLines={1}
          style={[
            type.chrome,
            s.name,
            { color: active ? c.text : c.muted },
            preview &&
              (type.chrome.fontFamily === font.regular ? { fontFamily: font.regularItalic } : { fontStyle: "italic" }),
          ]}
        >
          {name}
        </Text>
      )}
      {switcher && (
        <>
          <View style={s.dirty}>{dirty && <View style={[s.dot, { backgroundColor: c.text }]} />}</View>
          <Icon name="chevron-down" color={c.icon} />
        </>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  tabs: { flex: 1, minWidth: 0, flexDirection: "row", alignSelf: "stretch" },
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  name: { flex: 1, minWidth: 0 },
  dirty: { width: 8, flexShrink: 0, alignItems: "center" },
  dot: { width: 5, height: 5, borderRadius: 3 },
  footer: { padding: 8, gap: 8 },
});

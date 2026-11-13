import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { Workspace, WorkspaceTab, WorkspaceEntry } from "@canopy/domain/workspace";
import { fileTab, tabName, tabPath, tabDirty, tabBusy } from "@canopy/domain/workspace-modules";
import { PickerSheet } from "../../ui/Picker";
import { Button } from "../../ui/Button";
import { WorkspaceClose } from "./WorkspaceClose";
import { styles, useColors } from "../../ui/theme";

export function WorkspaceTabs({ view, onThreadActions }: { view: Workspace; onThreadActions?: () => void }) {
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<WorkspaceEntry>();
  const [closing, setClosing] = useState<WorkspaceTab[]>([]);
  const [closingModules, setClosingModules] = useState<string[]>([]);
  const current = view.current;
  const name = current ? tabName(current) : "Thread";

  useEffect(() => {
    if (view.error) setOpen(true);
  }, [view.error]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch tab, ${name}, ${view.tabs.length + 1} tabs${current && tabDirty(current) ? ", Unsaved changes" : ""}`}
        onPress={() => setOpen(true)}
        style={{ flex: 1, minWidth: 64, minHeight: 48, justifyContent: "center", paddingHorizontal: 8 }}
      >
        <Text
          numberOfLines={1}
          style={[styles.body, { color: c.text, fontStyle: current?.preview ? "italic" : "normal" }]}
        >
          {name}
          {current && tabDirty(current) ? " ●" : ""} ▾
        </Text>
      </Pressable>
      <PickerSheet
        title="Switch tab"
        visible={open}
        onClose={() => setOpen(false)}
        value={view.active}
        sections={[
          {
            options: [
              { value: "thread", label: "Thread" },
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
          <View style={{ gap: 8 }}>
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
      <PickerSheet
        title={actions ? tabName(actions) : "Tab actions"}
        visible={Boolean(actions)}
        onClose={() => setActions(undefined)}
        sections={[
          {
            options: [
              { value: "keep", label: "Keep tab" },
              { value: "up", label: "Move up" },
              { value: "down", label: "Move down" },
              { value: "close", label: "Close tab" },
              { value: "others", label: "Close other tabs" },
              { value: "saved", label: "Close saved tabs" },
            ],
          },
        ]}
        onSelect={(action) => {
          if (!actions) return;
          applyAction(view, actions, action, (entries) => {
            setClosing(entries.filter(fileTab));
            setClosingModules(entries.filter((entry) => entry.kind === "module").map((entry) => entry.id));
          });
          setActions(undefined);
        }}
      />
      <WorkspaceClose
        view={view}
        tabs={closing}
        onComplete={() => {
          for (const id of closingModules) view.close(id);
        }}
        onClose={() => {
          setClosing([]);
          setClosingModules([]);
        }}
      />
    </>
  );
}

function applyAction(view: Workspace, tab: WorkspaceEntry, action: string, confirm: (tabs: WorkspaceEntry[]) => void) {
  if (action === "keep") view.keep(tab.id);

  if (action === "up") view.move(tab.id, -1);

  if (action === "down") view.move(tab.id, 1);

  if (action === "close") {
    if (tabDirty(tab)) confirm([tab]);
    else view.close(tab.id);
  }

  if (action === "others") {
    const entries = view.tabs.filter((entry) => entry.id !== tab.id && !tabBusy(entry));

    if (entries.some(tabDirty)) confirm(entries);
    else for (const entry of entries) view.close(entry.id);
  }

  if (action === "saved") for (const entry of view.tabs) if (!tabDirty(entry)) view.close(entry.id);
}

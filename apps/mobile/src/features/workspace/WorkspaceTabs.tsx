import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { fileName } from "@canopy/domain/file-references";
import { PickerSheet } from "../../ui/Picker";
import { Button } from "../../ui/Button";
import { WorkspaceClose } from "./WorkspaceClose";
import { styles, useColors } from "../../ui/theme";

export function WorkspaceTabs({ view }: { view: Workspace }) {
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<WorkspaceTab>();
  const [closing, setClosing] = useState<WorkspaceTab[]>([]);
  const current = view.current;
  const name = current ? fileName(current.document.path) : "Thread";

  useEffect(() => {
    if (view.error) setOpen(true);
  }, [view.error]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch tab, ${name}, ${view.tabs.length + 1} tabs${current?.document.dirty ? ", Unsaved changes" : ""}`}
        onPress={() => setOpen(true)}
        style={{ flex: 1, minWidth: 96, minHeight: 48, justifyContent: "center", paddingHorizontal: 8 }}
      >
        <Text
          numberOfLines={1}
          style={[styles.body, { color: c.text, fontStyle: current?.preview ? "italic" : "normal" }]}
        >
          {name}
          {current?.document.dirty ? " ●" : ""} ▾
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
                label: fileName(tab.document.path),
                description: tab.document.path,
                badge: tab.document.dirty ? "Unsaved changes" : tab.preview ? "Preview" : undefined,
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
        title={actions ? fileName(actions.document.path) : "Tab actions"}
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

          if (action === "keep") view.keep(actions.id);

          if (action === "up") view.move(actions.id, -1);

          if (action === "down") view.move(actions.id, 1);

          if (action === "close") {
            if (actions.document.dirty) setClosing([actions]);
            else view.close(actions.id);
          }

          if (action === "others") {
            const tabs = view.tabs.filter((tab) => tab.id !== actions.id && !tab.document.busy);

            if (tabs.some((tab) => tab.document.dirty)) setClosing(tabs);
            else for (const tab of tabs) view.close(tab.id);
          }

          if (action === "saved") for (const tab of view.tabs) if (!tab.document.dirty) view.close(tab.id);
          setActions(undefined);
        }}
      />
      <WorkspaceClose view={view} tabs={closing} onClose={() => setClosing([])} />
    </>
  );
}

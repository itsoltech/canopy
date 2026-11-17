import { useState } from "react";
import { Text, View } from "react-native";
import type { Workspace, WorkspaceEntry, WorkspaceTab } from "@canopy/domain/workspace";
import { fileTab, tabBusy, tabDirty, tabName, tabPath } from "@canopy/domain/workspace-modules";
import { Button, IconButton } from "../../ui/Button";
import { PickerSheet } from "../../ui/Picker";
import { useMinimumTouchTarget } from "../../ui/density";
import { styles, useColors } from "../../ui/theme";
import { WorkspaceClose } from "./WorkspaceClose";

export function WorkspaceTabPicker({
  view,
  title,
  visible,
  onClose,
  onThreadActions,
  onTabActions,
}: {
  view: Workspace;
  title: string;
  visible: boolean;
  onClose: () => void;
  onThreadActions?: () => void;
  onTabActions: (tab: WorkspaceEntry) => void;
}) {
  const c = useColors();
  const touchTarget = useMinimumTouchTarget();
  const [closing, setClosing] = useState<WorkspaceTab[]>([]);
  const current = view.current;

  function closeTab(tab: WorkspaceEntry) {
    if (fileTab(tab) && tabDirty(tab)) setClosing([tab]);
    else view.close(tab.id);
  }

  return (
    <PickerSheet
      title="Switch tab"
      visible={visible}
      onClose={onClose}
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
              accessory: (
                <IconButton
                  icon="x-mark"
                  label={`Close tab, ${tabPath(tab)}`}
                  disabled={tabBusy(tab)}
                  style={{ width: touchTarget, height: touchTarget }}
                  onPress={() => closeTab(tab)}
                />
              ),
            })),
          ],
        },
      ]}
      onSelect={(id) => {
        view.select(id);
        onClose();
      }}
      footer={
        <View style={{ padding: 8, gap: 8 }}>
          {onThreadActions && (
            <Button
              title="Thread actions"
              onPress={() => {
                onClose();
                onThreadActions();
              }}
            />
          )}
          {view.error ? (
            <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
              {view.error}
            </Text>
          ) : null}
          {current && (
            <Button
              title="Tab actions"
              onPress={() => {
                onClose();
                onTabActions(current);
              }}
            />
          )}
          <WorkspaceClose view={view} tabs={closing} onClose={() => setClosing([])} />
        </View>
      }
    />
  );
}

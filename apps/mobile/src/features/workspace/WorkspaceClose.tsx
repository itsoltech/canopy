import { Text, View } from "react-native";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { styles, useColors } from "../../ui/theme";

export function WorkspaceClose({
  view,
  tabs,
  onClose,
}: {
  view: Workspace;
  tabs: WorkspaceTab[];
  onClose: () => void;
}) {
  const c = useColors();

  const busy = tabs.some((tab) => tab.document.busy);

  const close = async (save: boolean) => {
    for (const tab of tabs) {
      if (tab.document.dirty) {
        if (save) {
          if (!(await tab.document.save())) return;
        } else tab.document.discard();
      }

      view.close(tab.id);
    }

    onClose();
  };

  return (
    <Overlay
      visible={tabs.length > 0}
      onClose={() => {
        if (!busy) onClose();
      }}
      label="Save file changes?"
    >
      <View style={{ padding: 20, gap: 16 }}>
        <Text style={[styles.body, { color: c.text }]}>Save or discard these edits before closing the tabs.</Text>
        {tabs
          .filter((tab) => tab.document.dirty)
          .map((tab) => (
            <Text key={tab.id} style={[styles.caption, { color: c.text }]}>
              {tab.document.path}
            </Text>
          ))}
        {tabs
          .filter((tab) => tab.document.error)
          .map((tab) => (
            <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
              {tab.document.error}
            </Text>
          ))}
        <Button title="Keep editing" disabled={busy} onPress={onClose} />
        <Button title="Discard changes" variant="danger" disabled={busy} onPress={() => void close(false)} />
        <Button title="Save changes" variant="primary" busy={busy} onPress={() => void close(true)} />
      </View>
    </Overlay>
  );
}

import { StyleSheet, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { useColors, useTypography } from "../../ui/theme";
import { useThreadActions } from "./useThreadActions";

export function ArchivedThreadState({ thread }: { thread: ui.Thread }) {
  const actions = useThreadActions(thread);
  const c = useColors();
  const type = useTypography();

  return (
    <View style={[styles.card, { backgroundColor: c.well, borderColor: c.ring }]}>
      <Text accessibilityRole="header" style={[type.body, styles.title, { color: c.text }]}>
        This thread is archived
      </Text>
      <Button
        title={thread.archivedBy === "cascade" ? "Unarchive with parent" : "Unarchive"}
        icon="arrow-uturn-left"
        disabled={actions.disabled}
        busy={actions.busy}
        multiline
        onPress={() => actions.run("archive")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  title: { flexShrink: 1 },
});
